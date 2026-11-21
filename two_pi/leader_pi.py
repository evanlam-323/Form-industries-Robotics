#!/usr/bin/env python3
"""LEADER Pi: the Pi wired to the UR3e. It reads the UR3e's joint angles and
sends them over Wi-Fi to the other Pi (follower_pi.py), which drives the UR10e.
You move the UR3e by hand (freedrive) and the UR10e follows.

This is follow_socket.py v2.1 split in two. This half only ever talks to the
UR3e: it reads its joints, and switches freedrive on and off. It cannot move
the UR10e; it only tells the follower Pi where the UR3e is.

Safety behaviour:
  * the UR3e goes into freedrive only while the follower Pi says the UR10e is
    following. If the UR10e faults, or the Wi-Fi link drops for 1 s, freedrive
    is switched OFF, so the UR3e locking in your hand is your signal to stop;
  * after any stop you press Enter here again before freedrive comes back.

Run:
    python3 leader_pi.py --peer <the follower Pi's Wi-Fi IP>
Stop: Ctrl-C (takes the UR3e out of freedrive and tells the follower Pi).

Needs the shared link key on both Pis: see link.py.
"""
import argparse, sys, threading, time

import link
from ur_common import DT, RED, GRN, YEL, Arm, Console, Fault, col, do_home, send_script

ap = argparse.ArgumentParser(description="Leader Pi: sends the UR3e's joints to the follower Pi.")
ap.add_argument("--peer", required=True, help="the follower Pi's Wi-Fi IP (run `hostname -I` on it)")
ap.add_argument("--arm", default="169.254.190.160", help="UR3e IP (default %(default)s)")
ap.add_argument("--link-port", type=int, default=link.DEFAULT_PORT, help="UDP port on the follower Pi")
ap.add_argument("--no-freedrive", action="store_true", help="don't put the UR3e into freedrive")
ap.add_argument("--no-home", action="store_true", help="skip homing the UR3e at start")
ap.add_argument("--log", default="~/follow_log.txt")
args = ap.parse_args()

con = Console(args.log)
say = con.say
say(f"==== leader_pi start  peer={args.peer}:{args.link_port} ====")

KEY = link.load_key()
LEAD = Arm("UR3e", args.arm, con)
LINK = link.LeaderEnd(KEY, args.peer, args.link_port)
RUN = {"active": False, "bye": False, "stop": False}

FREEDRIVE = """def leader_fd():
  freedrive_mode()
  while True:
    sync()
  end
end
"""
STOP_L = "def s():\n  end_freedrive_mode()\n  stopj(2.0)\nend\n"
FOLLOWING_STATES = (link.FOLLOWING, link.HOLD)


def tx_loop():
    """Send the UR3e's joints 125 times a second, whatever else this script is doing."""
    tick = time.perf_counter()
    while not RUN["stop"]:
        q = LEAD.fresh_q(0.3)
        flags = 0
        if RUN["bye"]:
            flags = link.F_BYE
        elif LEAD.fault.is_set() or q is None:
            flags = link.F_FAULT
        elif RUN["active"]:
            flags = link.F_ACTIVE
        LINK.send(q, flags)
        tick += DT
        delay = tick - time.perf_counter()
        if delay > 0: time.sleep(delay)
        elif delay < -0.1: tick = time.perf_counter()


# ── startup checks ───────────────────────────────────────────────
LEAD.connect("169.254.190.100/16")
if not LEAD.healthy():
    say(f"[!!] UR3e is {LEAD.mode} / {LEAD.safety}; needs RUNNING / NORMAL "
        f"(clear any stop, power on + release brakes on its pendant)", RED, "ERROR")
    say("Fix that and run again. Nothing was moved.", YEL)
    sys.exit(1)
say(f"[OK] UR3e {LEAD.mode} / {LEAD.safety}", GRN)
if "false" in (LEAD.dash.cmd("is in remote control") or "").lower():
    say("[!!] UR3e is not in Remote Control; if freedrive doesn't start, switch it "
        "(pendant: profile icon top right -> Remote)", YEL, "WARN")

threading.Thread(target=tx_loop, daemon=True).start()


def wait_for_link():
    say(f"[..] looking for the follower Pi at {args.peer}:{args.link_port}")
    t0, hinted = time.time(), False
    while not LINK.connected():
        if not hinted and time.time() - t0 > 5:
            hinted = True
            say("     nothing yet. Check: follower_pi.py is running there, both Pis have the SAME "
                f"~/.ur_link_key, and `ping {args.peer}` works from here.", YEL)
        time.sleep(0.1)
    fb = LINK.feedback() or {}
    rtt = f"{LINK.rtt * 1000:.0f} ms round trip" if LINK.rtt is not None else "timing…"
    say(f"[OK] follower Pi linked ({rtt}); it is {link.STATE_NAMES.get(fb.get('state'), '?')}", GRN)


def wait_for_follower():
    """After Enter: wait until the follower Pi says the UR10e is following."""
    shown = None
    while True:
        LEAD.check()
        fb = LINK.feedback()
        if fb and fb["state"] in FOLLOWING_STATES:
            return
        msg = ("follower Pi not answering (Wi-Fi?)" if not fb else
               f"follower Pi has a FAULT: {fb['why'] or 'see its terminal'}. Press r then Enter THERE."
               if fb["state"] == link.FAULTED else
               f"follower Pi is {link.STATE_NAMES.get(fb['state'], '?')}: press Enter there to arm the UR10e"
               if fb["state"] == link.WAITING else
               f"follower Pi is {link.STATE_NAMES.get(fb['state'], '?')}, UR10e starting…")
        if msg != shown:
            shown = msg
            say("     " + msg, YEL)
        time.sleep(0.05)


def run_lead():
    RUN["active"] = True
    LEAD.watch.set()
    say("[..] waiting for the UR10e to start following")
    wait_for_follower()
    if not args.no_freedrive:
        send_script(LEAD.ip, FREEDRIVE)
        say("[OK] UR3e in freedrive: move it by hand, the UR10e follows. Ctrl-C to stop.", GRN)
    else:
        say("[OK] sending UR3e joints (freedrive not requested). Ctrl-C to stop.", GRN)
    last = 0.0
    while True:
        LEAD.check()
        if LEAD.fresh_q(0.3) is None:
            raise Fault("lost the UR3e joint stream (cable/network?)")
        fb = LINK.feedback(1.0)
        if fb is None:
            raise Fault("no word from the follower Pi for 1 s (Wi-Fi dropped, or follower_pi.py stopped)")
        if fb["state"] == link.FAULTED:
            raise Fault("follower Pi stopped the UR10e: " + (fb["why"] or "see its terminal"))
        if fb["state"] not in FOLLOWING_STATES:
            raise Fault(f"follower Pi is no longer following ({link.STATE_NAMES.get(fb['state'], '?')})")
        if time.time() - last > 0.5:
            last = time.time()
            rtt = f"{LINK.rtt * 1000:3.0f} ms" if LINK.rtt is not None else "  ?"
            st = link.STATE_NAMES.get(fb["state"], "?")
            con.status(col(GRN if fb["state"] == link.FOLLOWING else YEL, "● LEADING") +
                       f"  sent {LINK.seq}  |  Wi-Fi round trip {rtt}  |  UR10e side: {st}"
                       f"  |  UR3e {LEAD.mode}/{LEAD.safety}")
        time.sleep(0.02)


def fault_dialog(why):
    RUN["active"] = False
    LEAD.raise_fault(why)
    LEAD.stop(STOP_L)
    time.sleep(0.6)
    LEAD.poll()
    bar = "=" * 70
    lines = [bar, "  STOPPED: UR3e freedrive is OFF, the follower Pi has stopped the UR10e", bar,
             f"  What happened: {LEAD.fault_why}",
             f"  UR3e   {LEAD.mode} / {LEAD.safety}" + ("" if LEAD.healthy() else f"   <- {LEAD.hint()}")]
    if LEAD.msgs:
        lines.append("  Recent UR3e messages:")
        lines += ["    " + m for m in LEAD.msgs[-4:]]
    lines += ["  The UR10e's own fault box is on the follower Pi's terminal.",
              f"  (all of this is also in {args.log})", bar]
    for l in lines:
        say(l, RED, "FAULT")
    while True:
        a = input(col(YEL, "\n  [r] recover + check the UR3e   [q] quit  > ")).strip().lower()
        if a == "q":
            return False
        if a != "r":
            continue
        if not LEAD.unlock_if_protective_stop():
            say("Not ready yet. Fix the item above, then press r again.", YEL)
            continue
        LEAD.fault.clear()
        return True


# ── main ─────────────────────────────────────────────────────────
try:
    wait_for_link()
    if not args.no_home:
        try:
            do_home(LEAD, 0.3, 0.5)
        except Fault as f:
            LEAD.raise_fault(str(f))
            LEAD.stop(STOP_L)
            sys.exit(1)
    while True:
        what = "The link starts" if args.no_freedrive else "The UR3e goes into freedrive"
        input(col(GRN, f"\n  Ready. {what} once the UR10e is following.\n"
                       "  Press Enter to START, Ctrl-C to cancel... "))
        try:
            run_lead()
        except (Fault, OSError) as f:
            if not fault_dialog(str(f)):
                break
except (KeyboardInterrupt, EOFError):
    pass
finally:
    RUN["active"], RUN["bye"] = False, True
    LEAD.stop(STOP_L)
    time.sleep(0.15)                       # let the "stopping" flag reach the follower Pi a few times
    RUN["stop"] = True
    say("[*] stopped: UR3e freedrive off, follower Pi told")
