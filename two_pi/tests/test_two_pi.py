#!/usr/bin/env python3
"""End-to-end tests for the two-Pi leader-follower, with pretend robots and a bad Wi-Fi link.

    python3 tests/test_two_pi.py            (from the two_pi folder; takes about two minutes)

Each test starts two pretend UR controllers (sim_ur.py), the real leader_pi.py
and follower_pi.py as separate programs, and a UDP relay between them that can
drop, delay or cut the "Wi-Fi". Linux only (it uses several 127.x.x.x addresses).
"""
import math, os, random, signal, socket, subprocess, sys, tempfile, threading, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from sim_ur import SimUR, wave, DT

HOME = [0.0, -math.pi / 2, 0.0, -math.pi / 2, -math.pi / 2, 0.0]
KEY = "test-key-test-key-test-key-test-key"
_n = [0]


def free_port(kind=socket.SOCK_DGRAM):
    s = socket.socket(socket.AF_INET, kind); s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]; s.close()
    return p


class Wifi:
    """UDP relay between the leader and the follower that misbehaves on request."""

    def __init__(self, follower_port):
        self.to = ("127.0.0.1", follower_port)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        self.back = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.back.bind(("127.0.0.1", 0))
        self.leader = None
        self.drop, self.jitter, self.cut = 0.0, 0.0, False
        self.rng = random.Random(1)
        for src, fn in ((self.sock, self._up), (self.back, self._down)):
            threading.Thread(target=self._pump, args=(src, fn), daemon=True).start()

    def _pump(self, src, fn):
        while True:
            try:
                data, addr = src.recvfrom(2048)
            except OSError:
                return
            if self.cut or self.rng.random() < self.drop:
                continue
            delay = self.rng.random() * self.jitter
            if delay:
                threading.Timer(delay, fn, (data, addr)).start()
            else:
                fn(data, addr)

    def _up(self, data, addr):
        self.leader = addr
        try: self.back.sendto(data, self.to)
        except OSError: pass

    def _down(self, data, addr):
        if self.leader:
            try: self.sock.sendto(data, self.leader)
            except OSError: pass

    def close(self):
        self.sock.close(); self.back.close()


class Proc:
    def __init__(self, script, argv, key=KEY):
        env = dict(os.environ, UR_LINK_KEY=key, PYTHONUNBUFFERED="1")
        self.buf = ""
        self.p = subprocess.Popen([sys.executable, os.path.join(ROOT, script)] + argv, env=env, cwd=ROOT,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        while True:                                   # prompts have no newline, so read as it comes
            d = os.read(self.p.stdout.fileno(), 4096)
            if not d: return
            self.buf += d.decode(errors="replace")

    def text(self):
        return self.buf

    def enter(self, s=""):
        self.p.stdin.write((s + "\n").encode()); self.p.stdin.flush()

    def wait_for(self, needle, timeout=15, since=0):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if needle in self.buf[since:]:
                return True
            if self.p.poll() is not None and needle not in self.buf[since:]:
                time.sleep(0.2)
                if needle in self.buf[since:]: return True
                break
            time.sleep(0.05)
        raise AssertionError(f"never saw {needle!r}. Output was:\n{self.text()}")

    def stop(self):
        if self.p.poll() is None:
            self.p.send_signal(signal.SIGINT)
            try: self.p.wait(5)
            except subprocess.TimeoutExpired: self.p.kill()
        for f in (self.p.stdin, self.p.stdout):
            try: f.close()
            except OSError: pass


class Rig:
    """Two pretend arms, two Pis' programs, and the Wi-Fi between them."""

    def __init__(self, test, follower_args, leader_args=(), leader_q=None, follower_q=None,
                 follower_key=KEY, leader_key=KEY):
        _n[0] += 1
        self.lead_ip, self.fol_ip = f"127.0.{_n[0]}.2", f"127.0.{_n[0]}.3"
        self.ur3 = SimUR(self.lead_ip, leader_q or HOME, hand=wave(0.25, 5.0))
        self.ur10 = SimUR(self.fol_ip, follower_q or HOME)
        link_port, back_port = free_port(), free_port(socket.SOCK_STREAM)
        self.wifi = Wifi(link_port)
        log = os.path.join(tempfile.mkdtemp(), "log.txt")
        self.fol = Proc("follower_pi.py", ["--arm", self.fol_ip, "--pi", "127.0.0.1", "--port", str(back_port),
                                           "--link-bind", "127.0.0.1", "--link-port", str(link_port),
                                           "--log", log] + list(follower_args), key=follower_key)
        self.lead = Proc("leader_pi.py", ["--arm", self.lead_ip, "--peer", "127.0.0.1",
                                          "--link-port", str(self.wifi.port), "--log", log] + list(leader_args),
                         key=leader_key)
        test.addCleanup(self.close)

    def close(self):
        self.lead.stop(); self.fol.stop()
        self.ur3.close(); self.ur10.close(); self.wifi.close()

    def start(self):
        """Press Enter on both, wait until the UR10e is following and the UR3e is in freedrive."""
        self.fol.wait_for("Press Enter to ARM"); self.fol.enter()
        self.lead.wait_for("Press Enter to START"); self.lead.enter()
        self.fol.wait_for("FOLLOWING,")
        self.lead.wait_for("UR3e in freedrive")

    def limits(self, since=0.0):
        """Largest commanded joint speed and acceleration the UR10e was sent."""
        tg = [q for t, q in self.ur10.targets if t >= since]
        v = [[(b - a) / DT for a, b in zip(p, q)] for p, q in zip(tg, tg[1:])]
        acc = [[(b - a) / DT for a, b in zip(p, q)] for p, q in zip(v, v[1:])]
        return (max((abs(x) for r in v for x in r), default=0.0),
                max((abs(x) for r in acc for x in r), default=0.0))

    def apart(self):
        return max(abs(a - b) for a, b in zip(self.ur3.q, self.ur10.q))


class TwoPi(unittest.TestCase):
    def test_1_mirror_follows_within_limits(self):
        r = Rig(self, ["--absolute", "--vmax", "1", "--no-home"], ["--no-home"])
        r.start()
        time.sleep(6)
        self.assertLess(r.apart(), 0.12, "UR10e should be tracking the UR3e")
        self.assertGreater(max(abs(a - b) for a, b in zip(r.ur10.q, HOME)), 0.05, "UR10e should have moved")
        v, a = r.limits()
        self.assertLessEqual(v, 1.0 + 1e-3); self.assertLessEqual(a, 0.8 + 0.05)
        self.assertNotIn("FAULT", r.fol.text())

    def test_2_bad_wifi_still_smooth(self):
        r = Rig(self, ["--absolute", "--vmax", "1", "--no-home"], ["--no-home"])
        r.wifi.drop, r.wifi.jitter = 0.15, 0.06          # 15% lost, up to 60 ms late and out of order
        r.start()
        time.sleep(8)
        self.assertLess(r.apart(), 0.2)
        v, a = r.limits()
        self.assertLessEqual(v, 1.0 + 1e-3); self.assertLessEqual(a, 0.8 + 0.05)
        self.assertNotIn("FAULT", r.fol.text()); self.assertNotIn("STOPPED:", r.lead.text())

    def test_3_short_gap_holds_then_carries_on(self):
        r = Rig(self, ["--absolute", "--vmax", "1", "--no-home"], ["--no-home"])
        r.start(); time.sleep(2)
        r.wifi.cut = True; time.sleep(0.6); r.wifi.cut = False
        time.sleep(3)
        self.assertNotIn("FAULT", r.fol.text())
        self.assertEqual(r.ur10.program, "pi_follow", "the UR10e program should still be running")
        self.assertLess(r.apart(), 0.2)
        v, a = r.limits()
        self.assertLessEqual(v, 1.0 + 1e-3); self.assertLessEqual(a, 0.8 + 0.05)

    def test_4_long_gap_stops_both_then_recovers(self):
        r = Rig(self, ["--absolute", "--vmax", "1", "--no-home"], ["--no-home"])
        r.start(); time.sleep(2)
        r.wifi.cut = True
        r.fol.wait_for("no data from the leader Pi"); r.lead.wait_for("no word from the follower Pi")
        time.sleep(1)
        self.assertGreaterEqual(r.ur10.stops, 1, "the UR10e must have been sent stopj")
        self.assertFalse(r.ur3.freedrive, "UR3e freedrive must be off")
        still = list(r.ur10.q); time.sleep(1)
        self.assertLess(max(abs(a - b) for a, b in zip(still, r.ur10.q)), 1e-3, "UR10e must be standing still")
        r.wifi.cut = False
        nf, nl = len(r.fol.buf), len(r.lead.buf)
        r.fol.enter("r"); r.fol.enter()                   # recover + resume on the follower Pi
        r.lead.enter("r"); r.lead.enter()                 # recover + start again on the leader Pi
        r.fol.wait_for("FOLLOWING,", since=nf); r.lead.wait_for("UR3e in freedrive", since=nl)
        time.sleep(3)
        self.assertLess(r.apart(), 0.2)

    def test_5_wrong_key_never_moves(self):
        r = Rig(self, ["--absolute", "--vmax", "1", "--no-home"], ["--no-home"], leader_key="another-key-" * 3)
        r.fol.wait_for("Press Enter to ARM"); r.fol.enter()
        r.lead.wait_for("nothing yet", timeout=10)
        self.assertNotIn("Press Enter to START", r.lead.text())
        self.assertEqual(r.ur10.targets, []); self.assertEqual(r.ur10.program, None)

    def test_6_leader_ctrl_c_stops_follower(self):
        r = Rig(self, ["--absolute", "--vmax", "1", "--no-home"], ["--no-home"])
        r.start(); time.sleep(2)
        r.lead.stop()
        r.fol.wait_for("the leader Pi was stopped")
        time.sleep(0.8)
        self.assertGreaterEqual(r.ur10.stops, 1); self.assertFalse(r.ur3.freedrive)

    def test_7_ur10e_protective_stop_locks_the_ur3e(self):
        r = Rig(self, ["--absolute", "--vmax", "1", "--no-home"], ["--no-home"])
        r.start(); time.sleep(2)
        r.ur10.safety = "PROTECTIVE_STOP"
        r.fol.wait_for("FAULT:"); r.lead.wait_for("follower Pi stopped the UR10e")
        time.sleep(0.8)
        self.assertFalse(r.ur3.freedrive, "UR3e freedrive must be off after a UR10e fault")

    def test_8_scaled_mode_with_homing(self):
        r = Rig(self, ["--scale", "0.2", "--vmax", "1"], [],
                leader_q=[0.3, -1.2, 0.4, -1.2, -1.2, 0.3], follower_q=[-0.2, -1.4, 0.2, -1.8, -1.4, 0.2])
        r.fol.wait_for("Press Enter to home"); r.fol.enter()
        r.lead.wait_for("Press Enter to home"); r.lead.enter()
        r.fol.wait_for("UR10e at HOME", timeout=30); r.lead.wait_for("UR3e at HOME", timeout=30)
        r.start()
        time.sleep(3.7)                                   # the pretend hand is near the far end of its swing
        lead_moved = max(abs(a - b) for a, b in zip(r.ur3.q, HOME))
        self.assertGreater(lead_moved, 0.05)
        for i in range(6):
            self.assertAlmostEqual(r.ur10.q[i] - HOME[i], 0.2 * (r.ur3.q[i] - HOME[i]), delta=0.05)

    def test_9_ur10e_not_in_remote_refuses_to_start(self):
        _n[0] += 1
        ip = f"127.0.{_n[0]}.3"
        ur10 = SimUR(ip, HOME); ur10.remote = False
        self.addCleanup(ur10.close)
        p = Proc("follower_pi.py", ["--arm", ip, "--link-bind", "127.0.0.1", "--link-port", str(free_port()),
                                    "--port", str(free_port(socket.SOCK_STREAM)), "--log", os.path.join(tempfile.mkdtemp(), "l")])
        self.addCleanup(p.stop)
        p.wait_for("not in Remote Control"); p.wait_for("Nothing was moved")
        self.assertEqual(ur10.scripts, [])


if __name__ == "__main__":
    import warnings
    warnings.simplefilter("ignore", ResourceWarning)
    unittest.main(verbosity=2, warnings="ignore")
