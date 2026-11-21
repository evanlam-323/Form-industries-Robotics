#!/usr/bin/env python3
"""Shared pieces for leader_pi.py and follower_pi.py: talking to ONE UR arm.

This is the robot-facing code from follow_socket.py v2.1 (the version that works
on the real UR3e and UR10e), moved here unchanged in behaviour so each Pi can
use it for the arm it is wired to. Python 3 standard library only.
"""
import math, os, socket, struct, sys, threading, time

DT = 0.008                 # servoj period (125 Hz)
DEADBAND = 0.001           # rad; ignore smaller errors (sensor noise)
OK_SAFETY = ("NORMAL", "REDUCED")
RED, GRN, YEL, CYN = "1;31", "1;32", "1;33", "36"
TTY = sys.stdout.isatty()


def col(code, s):
    return f"\033[{code}m{s}\033[0m" if (TTY and code) else s


class Console:
    """Terminal plus a log file, safe to call from any thread."""

    def __init__(self, log_path):
        self.path = os.path.expanduser(log_path)
        self.f = open(self.path, "a")
        self.lock = threading.Lock()

    def say(self, msg, color=None, level="INFO"):
        line = time.strftime("%H:%M:%S ") + msg
        with self.lock:
            self.f.write(f"{line}  [{level}]\n"); self.f.flush()
            if TTY: sys.stdout.write("\r\033[K")
            print(col(color, line), flush=True)

    def quiet(self, msg):
        with self.lock:
            self.f.write(time.strftime("%H:%M:%S ") + msg + "  [DEBUG]\n"); self.f.flush()

    def status(self, s):
        if TTY:
            with self.lock:
                sys.stdout.write("\r\033[K" + s); sys.stdout.flush()


# ── robot I/O ─────────────────────────────────────────────────────
def read_q(ip):
    """Yield actual joint positions from a UR real-time stream (port 30003)."""
    s = socket.create_connection((ip, 30003), timeout=3)
    buf = b""
    try:
        while True:
            while len(buf) < 4:
                d = s.recv(4096)
                if not d: raise ConnectionError(f"{ip}:30003 closed")
                buf += d
            size = struct.unpack(">i", buf[:4])[0]
            if size < 4 or size > 1 << 16: raise ConnectionError(f"{ip}:30003 bad packet size {size}")
            while len(buf) < size:
                d = s.recv(4096)
                if not d: raise ConnectionError(f"{ip}:30003 closed")
                buf += d
            pkt, buf = buf[:size], buf[size:]
            if size >= 4 + 248 + 48:
                yield list(struct.unpack(">6d", pkt[4 + 248:4 + 248 + 48]))
    finally:
        s.close()


def send_script(ip, script):
    with socket.create_connection((ip, 30002), timeout=3) as s:
        s.sendall(script.encode())
        time.sleep(0.2)


class Dash:
    """Dashboard server (29999), reconnects on its own."""

    def __init__(self, ip):
        self.ip, self.s, self.lock = ip, None, threading.Lock()

    def _line(self):
        buf = b""
        while not buf.endswith(b"\n"):
            d = self.s.recv(1024)
            if not d: raise OSError("dashboard closed")
            buf += d
        return buf.decode(errors="replace").strip()

    def cmd(self, c):
        with self.lock:
            for _ in range(2):
                try:
                    if self.s is None:
                        self.s = socket.create_connection((self.ip, 29999), timeout=2)
                        self._line()                       # welcome banner
                    self.s.sendall((c + "\n").encode())
                    return self._line()
                except OSError:
                    try: self.s.close()
                    except Exception: pass
                    self.s = None
            return None


class Fault(Exception):
    pass


LEVELS = {0: "debug", 1: "info", 2: "WARNING", 3: "VIOLATION", 4: "FAULT"}


def parse_robot_message(p):
    """Primary-interface packet type 20 -> (kind, text, severity 0-4) or None."""
    off = 5
    _ts, _src, mtype = struct.unpack_from(">QbB", p, off); off += 10
    txt = lambda o: p[o:].decode(errors="replace").strip()
    if mtype == 0:
        return "message", txt(off), 1
    if mtype == 6:
        code, arg, level, _dt, _d = struct.unpack_from(">iiiBI", p, off); off += 17
        return f"{LEVELS.get(level, 'level %d' % level)} C{code}A{arg}", txt(off), min(level, 4)
    if mtype == 5:
        code, arg, smode = struct.unpack_from(">iiB", p, off)
        return f"SAFETY C{code}A{arg}", f"safety mode {smode}", 4
    if mtype == 10:
        line, colm = struct.unpack_from(">ii", p, off); off += 8
        return "SCRIPT ERROR", f"line {line}:{colm} {txt(off)}", 3
    if mtype == 7:
        code, arg, tsz = struct.unpack_from(">iiB", p, off); off += 9
        return "event", (p[off:off + tsz].decode(errors="replace") + " " + txt(off + tsz)).strip(), 0
    return None


HINTS = {
    "PROTECTIVE_STOP": "protective stop: press Unlock/Enable on that pendant",
    "SAFEGUARD_STOP": "safeguard stop: check the safeguard input / reset it",
    "ROBOT_EMERGENCY_STOP": "e-stop pressed on that robot: release it, then power on + release brakes",
    "SYSTEM_EMERGENCY_STOP": "system e-stop: release it, then power on + release brakes",
    "FAULT": "joint/controller fault: read the pendant popup, restart the robot if needed",
    "VIOLATION": "safety violation: read the pendant popup and confirm it",
    "POWER_OFF": "powered off: Initialize -> ON -> START on the pendant",
    "IDLE": "brakes still on: press START on the pendant",
    "NO-DASHBOARD": "not answering on the network: check its cable / this Pi's IP address",
}


class Arm:
    """One UR arm wired to this Pi: joints, status, its own messages, and fault state."""

    def __init__(self, name, ip, con):
        self.name, self.ip, self.con = name, ip, con
        self.dash = Dash(ip)
        self.mode = self.safety = "?"
        self.q, self.q_t, self.q_err = None, 0.0, None
        self.msgs = []
        self.fault = threading.Event()      # set = something went wrong
        self.watch = threading.Event()      # set = the arms are moving, treat problems as faults
        self.fault_why, self.fault_t = "", 0.0

    # status
    def healthy(self):
        return self.mode == "RUNNING" and self.safety in OK_SAFETY

    def problem(self):
        if self.safety not in OK_SAFETY: return f"safety status {self.safety}"
        if self.mode != "RUNNING": return f"robot mode {self.mode}"
        return "ok"

    def hint(self):
        return HINTS.get(self.safety) or HINTS.get(self.mode, "check its pendant")

    def poll(self):
        m, s = self.dash.cmd("robotmode"), self.dash.cmd("safetystatus")
        m = m.split(":")[-1].strip() if m else "NO-DASHBOARD"
        s = s.split(":")[-1].strip() if s else "NO-DASHBOARD"
        changed = (m, s) != (self.mode, self.safety)
        self.mode, self.safety = m, s
        return changed

    def fresh_q(self, max_age=0.5):
        return self.q if (self.q and time.time() - self.q_t < max_age) else None

    # faults
    def raise_fault(self, why):
        if not self.fault.is_set():
            self.fault_why, self.fault_t = why, time.time()
            self.fault.set()
            self.con.say("FAULT: " + why, RED, "FAULT")

    def check(self):
        if self.fault.is_set():
            raise Fault(self.fault_why)

    # background threads
    def _q_loop(self):
        while True:
            try:
                for q in read_q(self.ip):
                    self.q, self.q_t, self.q_err = q, time.time(), None
            except Exception as e:
                self.q_err = e
                time.sleep(0.5)

    def _msg_loop(self):
        """Listen to the robot's own messages (popups, errors, textmsg) on port 30001."""
        say = self.con.say
        while True:
            try:
                s = socket.create_connection((self.ip, 30001), timeout=5)
                buf = b""
                while True:
                    while len(buf) < 5:
                        d = s.recv(4096)
                        if not d: raise ConnectionError
                        buf += d
                    size = struct.unpack(">i", buf[:4])[0]
                    if size < 5 or size > 1 << 20: raise ConnectionError("bad packet")
                    while len(buf) < size:
                        d = s.recv(4096)
                        if not d: raise ConnectionError
                        buf += d
                    pkt, buf = buf[:size], buf[size:]
                    if pkt[4] != 20:
                        continue
                    try:
                        m = parse_robot_message(pkt)
                    except struct.error:
                        m = None
                    if not m:
                        continue
                    kind, text, sev = m
                    entry = f"{kind}: {text}"
                    self.msgs = (self.msgs + [time.strftime("%H:%M:%S ") + entry])[-6:]
                    if sev >= 3:
                        say(f"[{self.name}] {entry}", RED, "ERROR")
                        if self.watch.is_set():
                            self.raise_fault(f"{self.name} reported {entry}")
                    elif sev == 2:
                        say(f"[{self.name}] {entry}", YEL, "WARN")
                    elif kind == "message":
                        say(f"[{self.name}] {text}", CYN)
                    else:
                        self.con.quiet(f"[{self.name}] {entry}")
            except Exception:
                time.sleep(1)

    def _monitor(self):
        while True:
            if self.poll():
                ok = self.healthy()
                self.con.say(f"[{self.name}] status now {self.mode} / {self.safety}",
                             GRN if ok else RED, "INFO" if ok else "WARN")
            if self.watch.is_set() and not self.healthy():
                self.raise_fault(f"{self.name} {self.problem()}")
            time.sleep(0.2)

    def connect(self, nic_hint):
        """Start listening to the arm; exit with a clear message if it can't be read."""
        say = self.con.say
        threading.Thread(target=self._q_loop, daemon=True).start()
        threading.Thread(target=self._msg_loop, daemon=True).start()
        say(f"[..] connecting to {self.name} at {self.ip} ...")
        t0 = time.time()
        while self.q is None and time.time() - t0 < 5:
            time.sleep(0.05)
        if self.q is None:
            say(f"[!!] can't read {self.name} joints at {self.ip}: {self.q_err or 'timeout'}", RED, "ERROR")
            say(f"     Run `ip -br addr` / `ping {self.ip}`. After a replug: "
                f"sudo ip addr add {nic_hint} dev <the port {self.name} is on>", YEL)
            sys.exit(1)
        say(f"[OK] {self.name} joints: {[round(x, 3) for x in self.q]}", GRN)
        threading.Thread(target=self._monitor, daemon=True).start()
        self.poll()

    def stop(self, script):
        self.watch.clear()
        try:
            send_script(self.ip, script)
        except Exception as e:
            self.con.say(f"[!!] couldn't send stop to {self.name}: {e}  -> USE THE E-STOP if it's moving", RED, "ERROR")

    def started_moving(self, q_start, since, label):
        """Raise a Fault if the robot ignored a program we sent it."""
        q = self.fresh_q()
        if q and max(abs(a - b) for a, b in zip(q, q_start)) > 0.002:
            return True
        if time.time() - since > 4:
            ps = self.dash.cmd("programState") or "?"
            if "PLAYING" not in ps:
                raise Fault(f"{self.name} ignored the {label} program (programState: {ps}). "
                            "Check Remote Control, Automatic mode, Settings->Security->Services, "
                            "and the pendant Log tab.")
        return False

    def unlock_if_protective_stop(self):
        say = self.con.say
        self.poll()
        if self.safety == "PROTECTIVE_STOP":
            wait = 5.5 - (time.time() - self.fault_t)
            if wait > 0:
                say(f"[..] waiting {wait:.0f} s (a protective stop can only be unlocked after 5 s)")
                time.sleep(wait)
            self.dash.cmd("close safety popup")
            r = self.dash.cmd("unlock protective stop")
            say(f"[..] {self.name}: unlock protective stop -> {r}")
            time.sleep(1.0)
            self.poll()
        if self.healthy():
            say(f"[OK] {self.name} {self.mode} / {self.safety}", GRN)
            return True
        say(f"[!!] {self.name} still {self.mode} / {self.safety}: {self.hint()}", YEL)
        return False


# ── HOME ─────────────────────────────────────────────────────────
# Same HOME as the web pendant: [0,-90,0,-90,-90,0] deg (arm upright).
# Staged like js/homing.js: base/shoulder/elbow together with the wrist frozen,
# then wrist 1, 2, 3 one at a time. Base and wrists go to the nearest equivalent
# angle (+/-360) so nothing spins a full turn; shoulder/elbow go exactly.
HOME = [0.0, -math.pi / 2, 0.0, -math.pi / 2, -math.pi / 2, 0.0]
TWO_PI = 2 * math.pi


def home_target(q):
    t = list(HOME)
    for i in (0, 3, 4, 5):
        k = round((q[i] - HOME[i]) / TWO_PI)
        c = HOME[i] + k * TWO_PI
        if abs(c) > TWO_PI - 0.05:            # stay inside +/-360
            c -= math.copysign(TWO_PI, c)
        t[i] = c
    return t


def home_script(q, v, a):
    tgt = home_target(q)
    cur = list(q)
    moves = []
    for stage in ([0, 1, 2], [3], [4], [5]):
        if any(abs(tgt[i] - cur[i]) > 0.005 for i in stage):
            for i in stage: cur[i] = tgt[i]
            moves.append("  movej([" + ",".join(f"{x:.5f}" for x in cur) + f"], a={a}, v={v})")
    return tgt, "def home_all():\n" + "\n".join(moves or ["  sleep(0.1)"]) + "\nend\n"


def at(q, tgt):
    return max(abs(a - b) for a, b in zip(q, tgt)) < 0.01


def do_home(arm, v, a, on_tick=None):
    """Ask, then move this arm to HOME. Raises Fault if it doesn't get there."""
    say = arm.con.say
    tgt, scr = home_script(arm.q, v, a)
    if at(arm.q, tgt):
        say(f"[OK] {arm.name} already at HOME", GRN)
        return
    print(f"\n  {arm.name} -> {[round(math.degrees(x)) for x in tgt]} deg")
    input(f"\n  The {arm.name} will move to HOME (upright). Clear the area, hand on the e-stop.\n"
          "  Press Enter to home, Ctrl-C to cancel... ")
    arm.watch.set()
    q0, ts, moving = list(arm.q), time.time(), False
    send_script(arm.ip, scr)
    say(f"[..] {arm.name} homing")
    while True:
        arm.check()
        if on_tick: on_tick()
        q = arm.fresh_q()
        if q and at(q, tgt):
            say(f"[OK] {arm.name} at HOME", GRN)
            break
        if not moving:
            moving = arm.started_moving(q0, ts, "homing")
        if time.time() - ts > 120:
            raise Fault(f"{arm.name} didn't reach HOME within 2 minutes")
        time.sleep(0.05)
    arm.watch.clear()
