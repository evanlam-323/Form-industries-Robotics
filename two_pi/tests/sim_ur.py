#!/usr/bin/env python3
"""A pretend UR controller, for testing leader_pi.py / follower_pi.py without robots.

It answers on the same ports a real e-Series controller does:
  30003 / 30013  real-time stream (joints at the same byte offset), 125 Hz
  29999          dashboard (robotmode, safetystatus, remote control, ...)
  30002          accepts URScript. It understands just the three programs our
                 scripts send: the follow program (connects back and tracks the
                 targets it is sent), freedrive, movej homing, and stopj.
  30001          accepts a connection and stays quiet

It is NOT a physics model. It is enough to prove the two Pis' logic end to end.
"""
import math, re, socket, struct, threading, time

DT = 0.008
PKT = 1220


class SimUR:
    def __init__(self, ip, q0, hand=None):
        self.ip = ip
        self.q = list(q0)
        self.hand = hand                 # f(seconds in freedrive, pose it began at) -> joints (someone moving the arm)
        self.robotmode, self.safety = "RUNNING", "NORMAL"
        self.remote, self.opmode = True, "AUTOMATIC"
        self.freedrive = False
        self.program = None              # name of the running program
        self.gen = 0                     # bumps whenever a new script arrives
        self.targets = []                # (time, [6]) the follow program received
        self.stops = 0
        self.scripts = []
        self.lock = threading.Lock()
        self.alive = True
        self._socks = []
        for port, fn in ((30003, self._rt), (30013, self._rt), (29999, self._dash),
                         (30002, self._script), (30001, self._quiet)):
            s = socket.socket()
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((ip, port)); s.listen(8)
            self._socks.append(s)
            threading.Thread(target=self._accept, args=(s, fn), daemon=True).start()
        threading.Thread(target=self._hand_loop, daemon=True).start()

    def close(self):
        self.alive = False
        self.gen += 1
        for s in self._socks:
            try: s.close()
            except OSError: pass

    def _accept(self, s, fn):
        while self.alive:
            try:
                c, _ = s.accept()
            except OSError:
                return
            threading.Thread(target=fn, args=(c,), daemon=True).start()

    # real-time stream
    def _rt(self, c):
        modes = {"RUNNING": 7, "IDLE": 5, "POWER_OFF": 3}
        safeties = {"NORMAL": 1, "REDUCED": 2, "PROTECTIVE_STOP": 3}
        try:
            while self.alive:
                p = bytearray(PKT)
                struct.pack_into(">i", p, 0, PKT)
                struct.pack_into(">6d", p, 252, *self.q)
                struct.pack_into(">d", p, 756, modes.get(self.robotmode, 7))
                struct.pack_into(">d", p, 812, safeties.get(self.safety, 1))
                c.sendall(p)
                time.sleep(DT)
        except OSError:
            pass
        finally:
            c.close()

    def _quiet(self, c):
        try:
            while self.alive and c.recv(1024):
                pass
        except OSError:
            pass

    # dashboard
    def _dash(self, c):
        try:
            c.sendall(b"Connected: Universal Robots Dashboard Server\n")
            buf = b""
            while self.alive:
                d = c.recv(1024)
                if not d: return
                buf += d
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    cmd = line.decode().strip().lower()
                    if cmd == "robotmode": r = f"Robotmode: {self.robotmode}"
                    elif cmd == "safetystatus": r = f"Safetystatus: {self.safety}"
                    elif cmd == "is in remote control": r = "true" if self.remote else "false"
                    elif cmd == "get operational mode": r = self.opmode
                    elif cmd == "programstate": r = ("PLAYING " if self.program else "STOPPED ") + (self.program or "<unnamed>")
                    elif cmd == "unlock protective stop":
                        self.safety = "NORMAL"; r = "Protective stop releasing"
                    elif cmd == "close safety popup": r = "closing safety popup"
                    else: r = "unknown command"
                    c.sendall((r + "\n").encode())
        except OSError:
            pass
        finally:
            c.close()

    # scripts
    def _script(self, c):
        try:
            c.settimeout(0.5)
            text = b""
            try:
                while True:
                    d = c.recv(65536)
                    if not d: break
                    text += d
            except socket.timeout:
                pass
        finally:
            c.close()
        text = text.decode(errors="replace")
        if not text.strip():
            return
        self.scripts.append(text)
        if not (self.remote and self.opmode != "MANUAL" and self.robotmode == "RUNNING" and self.safety == "NORMAL"):
            return                                   # a real arm ignores programs in these states
        with self.lock:
            self.gen += 1
            gen = self.gen
        self.program = None
        if "end_freedrive_mode" in text:
            self.freedrive = False
        m = re.search(r'socket_open\("([^"]+)",\s*(\d+)', text)
        if m and "servoj" in text:
            threading.Thread(target=self._follow, args=(gen, m.group(1), int(m.group(2))), daemon=True).start()
        elif "freedrive_mode()" in text and "end_freedrive_mode" not in text:
            self.freedrive, self.program = True, "leader_fd"
        elif "movej(" in text:
            moves = [([float(x) for x in a.split(",")], float(v))
                     for a, v in re.findall(r"movej\(\[([^\]]+)\],\s*a=[\d.]+,\s*v=([\d.]+)\)", text)]
            threading.Thread(target=self._movej, args=(gen, moves), daemon=True).start()
        elif "stopj" in text:
            self.stops += 1

    def _follow(self, gen, ip, port):
        self.program = "pi_follow"
        try:
            s = socket.create_connection((ip, port), timeout=2)
        except OSError:
            self.program = None
            return
        s.settimeout(0.5)                            # same 0.5 s the URScript reader uses
        tgt, buf = list(self.q), b""
        stop = threading.Event()

        def servo():
            while not stop.is_set() and self.gen == gen and self.safety == "NORMAL":
                self.q = [q + 0.35 * (t - q) for q, t in zip(self.q, tgt)]
                time.sleep(DT)

        threading.Thread(target=servo, daemon=True).start()
        try:
            while self.gen == gen and self.safety == "NORMAL":
                d = s.recv(4096)
                if not d: break
                buf += d
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    vals = [float(x) for x in line.strip(b"()").split(b",")]
                    if len(vals) == 6:
                        tgt[:] = vals
                        self.targets.append((time.monotonic(), vals))
        except (OSError, ValueError):
            pass
        finally:
            stop.set()
            s.close()
            if self.gen == gen:
                self.program = None

    def _movej(self, gen, moves):
        self.program = "home_all"
        for tgt, v in moves:
            while self.gen == gen and self.alive:
                d = [t - q for q, t in zip(self.q, tgt)]
                far = max(abs(x) for x in d)
                if far < 1e-4: break
                k = min(1.0, v * DT / far)
                self.q = [q + k * x for q, x in zip(self.q, d)]
                time.sleep(DT)
        if self.gen == gen:
            self.program = None

    def _hand_loop(self):
        was, t0, q0 = False, 0.0, None
        while self.alive:
            on = self.freedrive and self.hand is not None and self.safety == "NORMAL"
            if on and not was:
                t0, q0 = time.monotonic(), list(self.q)
            was = on
            if on:
                self.q = self.hand(time.monotonic() - t0, q0)
            time.sleep(0.002)


def wave(amp=0.4, period=4.0):
    """A hand moving every joint back and forth, starting gently from where the arm is.
    u = seconds since freedrive began, q0 = the pose it began at."""
    def f(u, q0):
        k = min(1.0, u / 1.0)
        return [b + amp * k * math.sin(2 * math.pi * u / period) * (1.0 if i % 2 == 0 else -0.7)
                for i, b in enumerate(q0)]
    return f
