#!/usr/bin/env python3
"""The Wi-Fi link between the two Pis: small signed UDP messages.

leader Pi (UR3e)  --HELLO / DATA-->   follower Pi (UR10e)
leader Pi         <--FEEDBACK------   follower Pi

Every message carries an HMAC-SHA256 tag made with a key that only the two Pis
hold, so nothing else on the shop Wi-Fi can make the UR10e move. A message from
an earlier run cannot be replayed either: the follower picks a fresh random
number each time a leader connects, and only accepts DATA that quotes it.

Python 3 standard library only.

  python3 link.py --make-key     # print a new key (put the same one on both Pis)
  python3 link.py --selftest
"""
import hashlib, hmac, os, secrets, socket, struct, sys, threading, time

MAGIC = b"URL1"
HELLO, DATA, FEEDBACK = 1, 2, 3
DEFAULT_PORT = 50010

# leader flags
F_ACTIVE = 1      # the operator has started; the follower may follow
F_FAULT = 2       # the leader arm has a problem: do not follow
F_BYE = 4         # the leader script is stopping

# follower states (sent back in FEEDBACK)
WAITING, READY, HOMING, FOLLOWING, HOLD, FAULTED = 0, 1, 2, 3, 4, 5
STATE_NAMES = {WAITING: "WAITING", READY: "READY", HOMING: "HOMING",
               FOLLOWING: "FOLLOWING", HOLD: "HOLD (link gap)", FAULTED: "FAULT"}

_HDR = struct.Struct(">4sBBH8s8sId")     # magic, type, flags, reserved, sender id, peer id, seq, sender clock
_Q = struct.Struct(">6d")
_FB = struct.Struct(">BId6d80s")         # state, last seq seen, echoed leader clock, follower joints, why
_MAC = 16
ZERO = b"\0" * 8
KEY_FILE = "~/.ur_link_key"


def load_key():
    """The shared key: UR_LINK_KEY in the environment, else the first line of ~/.ur_link_key."""
    key = os.environ.get("UR_LINK_KEY", "").strip()
    if not key:
        try:
            with open(os.path.expanduser(KEY_FILE)) as f:
                key = f.readline().strip()
        except OSError:
            key = ""
    if len(key) < 24:
        sys.exit("No link key. Run `python3 link.py --make-key` once, then put that same key on BOTH Pis:\n"
                 f"    echo 'THE-KEY' > {KEY_FILE} && chmod 600 {KEY_FILE}")
    return key.encode()


def pack(key, typ, flags, sid, peer, seq, t, payload=b""):
    body = _HDR.pack(MAGIC, typ, flags, 0, sid, peer, seq & 0xFFFFFFFF, t) + payload
    return body + hmac.new(key, body, hashlib.sha256).digest()[:_MAC]


def unpack(key, data):
    """-> (type, flags, sender id, peer id, seq, sender clock, payload), or None if it is not ours."""
    if len(data) < _HDR.size + _MAC or data[:4] != MAGIC:
        return None
    body, tag = data[:-_MAC], data[-_MAC:]
    if not hmac.compare_digest(tag, hmac.new(key, body, hashlib.sha256).digest()[:_MAC]):
        return None
    _m, typ, flags, _r, sid, peer, seq, t = _HDR.unpack_from(body)
    return typ, flags, sid, peer, seq, t, body[_HDR.size:]


def pack_q(q):
    return _Q.pack(*q)


def unpack_q(payload):
    return list(_Q.unpack(payload)) if len(payload) == _Q.size else None


def pack_feedback(state, last_seq, echo_t, q, why=""):
    return _FB.pack(state, last_seq & 0xFFFFFFFF, echo_t, *(q or [0.0] * 6), why.encode(errors="replace")[:80])


def unpack_feedback(payload):
    if len(payload) != _FB.size:
        return None
    v = _FB.unpack(payload)
    return {"state": v[0], "last_seq": v[1], "echo_t": v[2], "q": list(v[3:9]),
            "why": v[9].rstrip(b"\0").decode(errors="replace")}


class LeaderSample:
    """One reading from the leader: joints, flags, when it arrived here, its number, the leader's clock."""
    __slots__ = ("q", "flags", "at", "seq", "t")

    def __init__(self, q, flags, at, seq, t):
        self.q, self.flags, self.at, self.seq, self.t = q, flags, at, seq, t


class FollowerEnd:
    """Runs on the follower Pi: receives the leader's joints, sends feedback."""

    def __init__(self, key, bind="0.0.0.0", port=DEFAULT_PORT, only_from=None):
        self.key, self.only_from = key, only_from
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind((bind, port))
        self.sock.settimeout(0.5)
        self.nonce = secrets.token_bytes(8)
        self.sid, self.addr, self.last_seq = None, None, -1
        self.sample = None                 # newest LeaderSample
        self.last_heard = 0.0              # any valid message from the current leader
        self.echo_t = 0.0
        self.received = self.lost = self.rejected = 0
        self.lock = threading.Lock()
        threading.Thread(target=self._rx, daemon=True).start()

    def _rx(self):
        while True:
            try:
                data, addr = self.sock.recvfrom(512)
            except socket.timeout:
                continue
            except OSError:
                return
            if self.only_from and addr[0] != self.only_from:
                self.rejected += 1
                continue
            m = unpack(self.key, data)
            if not m:
                self.rejected += 1
                continue
            typ, flags, sid, peer, seq, t, payload = m
            now = time.monotonic()
            with self.lock:
                if typ == HELLO:
                    # a new leader run is adopted only when the current one has gone quiet
                    if sid != self.sid and now - self.last_heard > 1.0:
                        self.sid, self.last_seq, self.sample = sid, -1, None
                        self.nonce = secrets.token_bytes(8)      # old DATA can no longer be replayed
                        self.received = self.lost = 0
                    if sid == self.sid:
                        self.addr, self.last_heard, self.echo_t = addr, now, t
                elif typ == DATA:
                    q = unpack_q(payload)
                    if sid != self.sid or peer != self.nonce or seq <= self.last_seq or q is None:
                        self.rejected += 1
                        continue
                    if self.last_seq >= 0:
                        self.lost += seq - self.last_seq - 1
                    self.received += 1
                    self.last_seq, self.addr, self.last_heard, self.echo_t = seq, addr, now, t
                    self.sample = LeaderSample(q, flags, now, seq, t)

    def latest(self):
        with self.lock:
            return self.sample

    def link_age(self):
        return time.monotonic() - self.last_heard if self.last_heard else float("inf")

    def loss_pct(self):
        n = self.received + self.lost
        return 100.0 * self.lost / n if n else 0.0

    def send_feedback(self, state, q=None, why=""):
        with self.lock:
            addr, sid, nonce, seq, echo = self.addr, self.sid, self.nonce, self.last_seq, self.echo_t
        if not addr or not sid:
            return
        try:
            self.sock.sendto(pack(self.key, FEEDBACK, 0, nonce, sid, 0, time.monotonic(),
                                  pack_feedback(state, max(seq, 0), echo, q, why)), addr)
        except OSError:
            pass


class LeaderEnd:
    """Runs on the leader Pi: sends joints to the follower Pi, receives its feedback."""

    def __init__(self, key, peer_ip, port=DEFAULT_PORT):
        self.key, self.peer = key, (peer_ip, port)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.settimeout(0.5)
        self.sid = secrets.token_bytes(8)
        self.nonce = None                  # the follower's number, learned from its feedback
        self.seq = 0
        self.fb, self.fb_at, self.rtt = None, 0.0, None
        self.lock = threading.Lock()
        threading.Thread(target=self._rx, daemon=True).start()

    def _rx(self):
        while True:
            try:
                data, addr = self.sock.recvfrom(512)
            except socket.timeout:
                continue
            except OSError:
                return
            if addr[0] != self.peer[0]:
                continue
            m = unpack(self.key, data)
            if not m or m[0] != FEEDBACK or m[3] != self.sid:
                continue
            fb = unpack_feedback(m[6])
            if not fb:
                continue
            now = time.monotonic()
            with self.lock:
                self.nonce, self.fb, self.fb_at = m[2], fb, now
                if fb["echo_t"]:
                    rtt = now - fb["echo_t"]
                    if 0 <= rtt < 5:
                        self.rtt = rtt if self.rtt is None else 0.8 * self.rtt + 0.2 * rtt

    def connected(self, max_age=1.0):
        return self.fb is not None and time.monotonic() - self.fb_at < max_age

    def feedback(self, max_age=1.0):
        with self.lock:
            return dict(self.fb) if self.fb and time.monotonic() - self.fb_at < max_age else None

    def send(self, q, flags):
        """Send the joints. Until the follower has answered, sends HELLO instead."""
        now = time.monotonic()
        with self.lock:
            nonce = self.nonce if (self.fb and now - self.fb_at < 1.0) else None
        try:
            if nonce is None or q is None:
                self.sock.sendto(pack(self.key, HELLO, flags, self.sid, ZERO, 0, now), self.peer)
            else:
                self.seq += 1
                self.sock.sendto(pack(self.key, DATA, flags, self.sid, nonce, self.seq, now, pack_q(q)), self.peer)
        except OSError:
            pass                           # Wi-Fi down for a moment: the follower's watchdog covers it


def selftest():
    key = b"k" * 32
    q = [0.1, -1.2, 1.3, -1.4, -1.57, 0.2]
    m = unpack(key, pack(key, DATA, F_ACTIVE, b"A" * 8, b"B" * 8, 7, 1.5, pack_q(q)))
    assert m and m[:6] == (DATA, F_ACTIVE, b"A" * 8, b"B" * 8, 7, 1.5) and unpack_q(m[6]) == q
    raw = bytearray(pack(key, DATA, 0, b"A" * 8, b"B" * 8, 7, 1.5, pack_q(q)))
    raw[40] ^= 1
    assert unpack(key, bytes(raw)) is None, "a changed message must be refused"
    assert unpack(b"x" * 32, pack(key, HELLO, 0, b"A" * 8, ZERO, 0, 0.0)) is None, "wrong key must be refused"
    fb = unpack_feedback(pack_feedback(FOLLOWING, 9, 2.5, q, "ok"))
    assert fb == {"state": FOLLOWING, "last_seq": 9, "echo_t": 2.5, "q": q, "why": "ok"}, fb

    f = FollowerEnd(key, "127.0.0.1", 0)
    port = f.sock.getsockname()[1]
    l = LeaderEnd(key, "127.0.0.1", port)
    for _ in range(40):
        l.send(q, F_ACTIVE)
        f.send_feedback(READY, q)
        time.sleep(0.01)
    s = f.latest()
    assert s and s.q == q and s.flags == F_ACTIVE and l.connected(), "leader and follower should be linked"
    # a recorded DATA message from an earlier leader run must be refused
    old = pack(key, DATA, F_ACTIVE, b"Z" * 8, f.nonce, 10 ** 6, 0.0, pack_q([9.0] * 6))
    before = f.rejected
    l.sock.sendto(old, ("127.0.0.1", port))
    time.sleep(0.1)
    assert f.rejected == before + 1 and f.latest().q == q, "replay from another run must be refused"
    # a stranger without the key is ignored
    l.sock.sendto(pack(b"wrong-key" * 4, DATA, F_ACTIVE, l.sid, f.nonce, 10 ** 6, 0.0, pack_q([9.0] * 6)), ("127.0.0.1", port))
    time.sleep(0.1)
    assert f.latest().q == q
    print("link selftest ok")


if __name__ == "__main__":
    if "--make-key" in sys.argv:
        print(secrets.token_urlsafe(32))
    elif "--selftest" in sys.argv:
        selftest()
    else:
        print(__doc__)
