#!/usr/bin/env python3
"""Live UR joint state -> FactoryForm (Devices -> Robot cells).

Runs on the computer wired to the robots (the lab's Raspberry Pi). For each arm
it listens to the controller's real-time stream, takes the measured joint
angles, tool point, robot mode and safety mode, and posts them to FactoryForm's
POST /api/robots/live about 20 times a second. The twin then follows the arm.

READ-ONLY. This script never writes a byte to a robot. It connects to the
controller's read-only real-time port (30013) and only listens; if that port is
closed it falls back to 30003 and still only listens. It cannot move an arm.

Python 3 standard library only (nothing to install on the Pi).

  python3 arm_state_pusher.py --check                 # read each arm once, print it, exit
  python3 arm_state_pusher.py --server http://HOST:3001
  python3 arm_state_pusher.py --fake                  # no robots: a slow made-up motion, to test the website
  python3 arm_state_pusher.py --selftest              # check the packet parser without a robot

The key for a server on another computer comes from ROBOT_API_KEY in the
environment (never on the command line, where `ps` would show it).
"""
import argparse, http.client, json, math, os, socket, struct, sys, threading, time, urllib.parse

DEFAULT_ARMS = ["ur-large=192.168.1.20", "ur-small=169.254.190.160"]
PORTS = (30013, 30003)  # read-only real-time interface first, then the classic one (listen only)

# Byte offsets in the e-Series real-time message (after the 4-byte length), from
# Universal Robots' "Remote Control via TCP/IP" client-interface table.
Q_ACTUAL = 252       # 6 doubles: measured joint angles, rad
TCP_ACTUAL = 444     # 6 doubles: x, y, z, rx, ry, rz of the tool point, m and rad
ROBOT_MODE = 756     # 1 double
SAFETY_MODE = 812    # 1 double
MIN_SIZE, MAX_SIZE = Q_ACTUAL + 48, 4096


def parse_packet(pkt):
    """One real-time message -> dict, or None when it is too short or not finite."""
    size = len(pkt)
    if size < MIN_SIZE:
        return None
    joints = list(struct.unpack_from(">6d", pkt, Q_ACTUAL))
    if not all(math.isfinite(v) and abs(v) < 4 * math.pi for v in joints):
        return None
    out = {"joints": joints}
    if size >= TCP_ACTUAL + 48:
        tcp = list(struct.unpack_from(">6d", pkt, TCP_ACTUAL))
        if all(math.isfinite(v) for v in tcp):
            out["tcp"] = tcp
    if size >= ROBOT_MODE + 8:
        mode = struct.unpack_from(">d", pkt, ROBOT_MODE)[0]
        if math.isfinite(mode) and -1 <= mode <= 8:
            out["robotMode"] = int(mode)
    if size >= SAFETY_MODE + 8:
        safety = struct.unpack_from(">d", pkt, SAFETY_MODE)[0]
        if math.isfinite(safety) and 1 <= safety <= 13:
            out["safetyMode"] = int(safety)
    return out


class Arm:
    """Listens to one controller and keeps its latest reading. Reconnects on its own."""

    def __init__(self, robot_id, ip):
        self.id, self.ip = robot_id, ip
        self.latest, self.at, self.port, self.error = None, 0.0, None, "not connected yet"
        self.lock = threading.Lock()

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()
        return self

    def _connect(self):
        last = None
        for port in PORTS:
            try:
                s = socket.create_connection((self.ip, port), timeout=3)
                s.settimeout(3)
                return s, port
            except OSError as e:
                last = e
        raise last

    def _run(self):
        wait = 1.0
        while True:
            try:
                s, port = self._connect()
            except OSError as e:
                self.error = f"cannot reach {self.ip}: {e}"
                time.sleep(wait)
                wait = min(wait * 2, 10)
                continue
            wait, self.port, self.error = 1.0, port, None
            try:
                self._listen(s)
            except (OSError, ValueError) as e:
                self.error = f"{self.ip}:{port} {e}"
            finally:
                s.close()
            time.sleep(1)

    def _listen(self, s):
        buf = b""
        while True:
            data = s.recv(8192)   # receive only: nothing is ever sent on this socket
            if not data:
                raise OSError("closed by the controller")
            buf += data
            newest = None
            while len(buf) >= 4:
                size = struct.unpack_from(">i", buf)[0]
                if not MIN_SIZE <= size <= MAX_SIZE:
                    raise ValueError(f"unexpected message size {size}")
                if len(buf) < size:
                    break
                newest, buf = buf[:size], buf[size:]
            if newest:   # the stream runs at up to 500 Hz; only the newest message matters
                reading = parse_packet(newest)
                if reading:
                    with self.lock:
                        self.latest, self.at = reading, time.monotonic()

    def reading(self, max_age=1.0):
        with self.lock:
            if self.latest and time.monotonic() - self.at <= max_age:
                return dict(self.latest)
        return None


class FakeArm:
    """A slow made-up motion around the ready pose, for testing the website without robots."""

    def __init__(self, robot_id, phase):
        self.id, self.ip, self.port, self.error, self.phase = robot_id, "fake", None, None, phase

    def start(self):
        return self

    def reading(self, max_age=1.0):
        t = time.monotonic() * 0.6 + self.phase
        joints = [0.6 * math.sin(t * 0.5), -1.3 + 0.35 * math.sin(t), 1.5 + 0.4 * math.cos(t * 0.8),
                  -1.6 + 0.3 * math.sin(t * 1.3), -1.57, 0.5 * math.sin(t * 0.7)]
        return {"joints": joints, "robotMode": 7, "safetyMode": 1, "simulated": True}


class Server:
    """Keeps one connection to FactoryForm open and posts frames on it."""

    def __init__(self, base, key):
        u = urllib.parse.urlsplit(base)
        if u.scheme not in ("http", "https") or not u.hostname:
            raise SystemExit(f"--server must look like http://host:3001, not {base!r}")
        self.cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
        self.host, self.port = u.hostname, u.port or (443 if u.scheme == "https" else 80)
        self.path = u.path.rstrip("/") + "/api/robots/live"
        self.headers = {"Content-Type": "application/json"}
        if key:
            self.headers["Authorization"] = f"Bearer {key}"
        self.conn = None

    def post(self, body):
        payload = json.dumps(body).encode()
        for attempt in (0, 1):   # one retry on a dropped keep-alive connection
            try:
                if self.conn is None:
                    self.conn = self.cls(self.host, self.port, timeout=3)
                self.conn.request("POST", self.path, payload, self.headers)
                res = self.conn.getresponse()
                text = res.read().decode(errors="replace")
                return res.status, text
            except (OSError, http.client.HTTPException) as e:
                if self.conn:
                    self.conn.close()
                self.conn = None
                if attempt:
                    return None, str(e)


def selftest():
    pkt = bytearray(1220)
    struct.pack_into(">i", pkt, 0, 1220)
    q = [0.1, -1.2, 1.3, -1.4, -1.57, 0.2]
    struct.pack_into(">6d", pkt, Q_ACTUAL, *q)
    struct.pack_into(">6d", pkt, TCP_ACTUAL, 0.3, -0.2, 0.5, 0.0, 3.14, 0.0)
    struct.pack_into(">d", pkt, ROBOT_MODE, 7.0)
    struct.pack_into(">d", pkt, SAFETY_MODE, 1.0)
    r = parse_packet(bytes(pkt))
    assert r and r["joints"] == q and r["tcp"][:3] == [0.3, -0.2, 0.5] and r["robotMode"] == 7 and r["safetyMode"] == 1, r
    assert parse_packet(bytes(100)) is None
    bad = bytearray(pkt)
    struct.pack_into(">d", bad, Q_ACTUAL, float("nan"))
    assert parse_packet(bytes(bad)) is None
    short = parse_packet(bytes(pkt[:400]))   # an older, shorter message still gives joints
    assert short == {"joints": q}, short
    print("selftest ok")


def main():
    ap = argparse.ArgumentParser(description="Post live UR joint state to FactoryForm. Read-only: never commands a robot.")
    ap.add_argument("--server", default=os.environ.get("FACTORYFORM_URL", "http://127.0.0.1:3001"), help="FactoryForm's address (default %(default)s)")
    ap.add_argument("--arm", action="append", metavar="ID=IP", help=f"a robot's FactoryForm id and controller address; repeat for each arm (default {' '.join(DEFAULT_ARMS)})")
    ap.add_argument("--rate", type=float, default=20.0, help="frames per second sent to FactoryForm (default 20)")
    ap.add_argument("--fake", action="store_true", help="send a made-up motion instead of reading robots")
    ap.add_argument("--check", action="store_true", help="read each arm once, print what it reports, and exit")
    ap.add_argument("--selftest", action="store_true", help="check the packet parser and exit")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if not 1 <= args.rate <= 60:
        ap.error("--rate must be between 1 and 60")

    arms = []
    for i, spec in enumerate(args.arm or DEFAULT_ARMS):
        robot_id, sep, ip = spec.partition("=")
        if not sep or not robot_id or not ip:
            ap.error(f"--arm must be ID=IP, not {spec!r}")
        arms.append((FakeArm(robot_id, i * 1.7) if args.fake else Arm(robot_id, ip)).start())

    if args.check:
        time.sleep(0 if args.fake else 4)
        ok = True
        for arm in arms:
            r = arm.reading(max_age=5)
            if r:
                deg = " ".join(f"{math.degrees(v):7.1f}" for v in r["joints"])
                print(f"[ok]   {arm.id} ({arm.ip}, port {arm.port}): joints deg [{deg}] robotMode={r.get('robotMode')} safetyMode={r.get('safetyMode')}")
            else:
                ok = False
                print(f"[FAIL] {arm.id} ({arm.ip}): {arm.error or 'no data yet'}")
        sys.exit(0 if ok else 1)

    server = Server(args.server, os.environ.get("ROBOT_API_KEY", ""))
    source = "ur-pi" + (" (fake)" if args.fake else "")
    print(f"posting to {args.server}/api/robots/live at {args.rate:g} Hz: " + ", ".join(f"{a.id}={a.ip}" for a in arms), flush=True)
    period, next_at, sent, last_report, last_status = 1.0 / args.rate, time.monotonic(), 0, time.monotonic(), "nothing sent yet"
    while True:
        robots = []
        for arm in arms:
            r = arm.reading()
            if r:
                robots.append({"id": arm.id, **r})
        if robots:
            status, text = server.post({"source": source, "robots": robots})
            if status == 204:
                sent += 1
                last_status = "ok"
            else:
                last_status = f"server said {status}: {text[:200]}" if status else f"cannot reach FactoryForm: {text}"
        now = time.monotonic()
        if now - last_report >= 5:
            live = [a.id for a in arms if a.reading()]
            quiet = [f"{a.id} ({a.error or 'no data'})" for a in arms if not a.reading()]
            print(f"{time.strftime('%H:%M:%S')} sent {sent} frames in 5 s | reading: {', '.join(live) or 'none'}"
                  + (f" | not reading: {'; '.join(quiet)}" if quiet else "") + f" | {last_status}", flush=True)
            sent, last_report = 0, now
        next_at += period
        delay = next_at - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:
            next_at = time.monotonic()   # fell behind (server slow or down): don't burst to catch up


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
