#!/usr/bin/env python3
"""FOLLOWER Pi: the Pi wired to the UR10e. It makes the UR10e follow the UR3e,
whose joint angles arrive over Wi-Fi from the other Pi (leader_pi.py).

This is follow_socket.py v2.1 split in two. Everything that touches the UR10e
is the same as before (same URScript, same 125 Hz stream on the Ethernet cable,
same speed and acceleration limits, same fault handling). The only new part is
where the UR3e's joints come from: the Wi-Fi link in link.py.

Because Wi-Fi is less steady than a cable, this Pi never passes Wi-Fi timing on
to the robot. It keeps its own smooth 125 Hz stream to the UR10e and treats the
leader's joints as a moving goal:
  * a short gap (default 0.15 s without data): HOLD, the UR10e glides to a stop
    at the last goal and carries on when data returns;
  * a long gap (default 1.5 s): FAULT, the UR10e is stopped and you are asked
    before it resumes;
  * the leader Pi stopping, pausing or reporting a UR3e problem: FAULT.

Run (after leader_pi.py or before, either order):
    python3 follower_pi.py --absolute --vmax 1      # mirror mode, like before
    python3 follower_pi.py --scale 0.1              # scaled mode
Stop: Ctrl-C (stops the UR10e).

Needs the shared link key on both Pis: see link.py.
"""
import argparse, math, select, socket, sys, threading, time

import link
from ur_common import (DT, DEADBAND, RED, GRN, YEL, TWO_PI, Arm, Console, Fault, col, do_home, send_script)

ap = argparse.ArgumentParser(description="Follower Pi: drives the UR10e from the leader Pi's joint stream.")
ap.add_argument("--arm", default="192.168.1.20", help="UR10e IP (default %(default)s)")
ap.add_argument("--pi", default="192.168.1.250", help="this Pi's IP on the UR10e's cable (default %(default)s)")
ap.add_argument("--port", type=int, default=50007, help="TCP port the UR10e connects back to")
ap.add_argument("--link-port", type=int, default=link.DEFAULT_PORT, help="UDP port the leader Pi sends to")
ap.add_argument("--link-bind", default="0.0.0.0", help="address to listen on for the leader Pi")
ap.add_argument("--leader-pi", default=None, help="only accept the leader Pi at this Wi-Fi IP (optional)")
ap.add_argument("--scale", type=float, default=0.2,
                help="UR10e moves this fraction of the UR3e's joint motion (0.1 = a tenth, 0.33 = a third)")
ap.add_argument("--vmax", type=float, default=0.3, help="max UR10e joint speed, rad/s")
ap.add_argument("--amax", type=float, default=0.8, help="max UR10e joint acceleration, rad/s^2")
ap.add_argument("--smooth", type=float, default=0.1, help="smoothing time constant on the UR3e reading, s")
ap.add_argument("--max-lag", type=float, default=15.0, help="deg; fault if the UR10e falls this far behind")
ap.add_argument("--absolute", action="store_true",
                help="copy UR3e joint angles exactly (ignores --scale; UR10e first drives to the UR3e pose)")
ap.add_argument("--hold-after", type=float, default=0.15, help="s without leader data before the UR10e holds")
ap.add_argument("--link-timeout", type=float, default=1.5, help="s without leader data before a FAULT")
ap.add_argument("--no-home", action="store_true", help="skip homing the UR10e at start")
ap.add_argument("--home-speed", type=float, default=0.3, help="UR10e homing joint speed rad/s")
ap.add_argument("--log", default="~/follow_log.txt")
args = ap.parse_args()
if not 0 < args.scale <= 1:
    sys.exit("--scale must be between 0 and 1")
if not 0 < args.hold_after < args.link_timeout <= 5:
    sys.exit("--hold-after must be shorter than --link-timeout (at most 5 s)")

JUMP_LIMIT = 0.15          # rad; a bigger step than this (plus what the gap allows) = bad reading -> fault
LEADER_VMAX = 6.3          # rad/s; the fastest a UR3e joint can turn, for judging a step after a gap
JOINT_LIMIT = TWO_PI - 0.05

con = Console(args.log)
say = con.say
say(f"==== follower_pi start  scale={args.scale} vmax={args.vmax} amax={args.amax} "
    f"absolute={args.absolute} hold={args.hold_after} timeout={args.link_timeout} ====")

KEY = link.load_key()
FOL = Arm("UR10e", args.arm, con)
LINK = link.FollowerEnd(KEY, args.link_bind, args.link_port, args.leader_pi)

# what the leader Pi is told about us, ten times a second
STATE = {"s": link.WAITING, "why": ""}


def set_state(s, why=""):
    STATE["s"], STATE["why"] = s, why


def feedback_loop():
    while True:
        LINK.send_feedback(STATE["s"], FOL.fresh_q(), STATE["why"])
        time.sleep(0.1)


threading.Thread(target=feedback_loop, daemon=True).start()

# ── startup checks (confirmation before anything moves) ─────────
FOL.connect("192.168.1.250/24")
problems = []
if FOL.healthy():
    say(f"[OK] UR10e {FOL.mode} / {FOL.safety}", GRN)
else:
    problems.append(f"UR10e is {FOL.mode} / {FOL.safety}; needs RUNNING / NORMAL "
                    f"(clear any stop, power on + release brakes on its pendant)")
rc = FOL.dash.cmd("is in remote control") or ""
om = FOL.dash.cmd("get operational mode") or ""
if "false" in rc.lower():
    problems.append("UR10e is not in Remote Control (pendant: profile icon top right -> Remote)")
else:
    say("[OK] UR10e in Remote Control", GRN)
if "MANUAL" in om.upper():
    problems.append("UR10e is in MANUAL mode; switch it to Automatic first (it ignored the Pi's programs in Manual)")
elif om:
    say(f"[OK] UR10e operational mode: {om}", GRN)
if problems:
    for p in problems:
        say("[!!] " + p, RED, "ERROR")
    say("Fix the items above and run again. Nothing was moved.", YEL)
    sys.exit(1)

STOP_F = "def s():\n  stopj(2.0)\nend\n"

# ── follow ───────────────────────────────────────────────────────
srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", args.port))
srv.listen(1)

# Unchanged from follow_socket.py v2.1. The servo loop never waits on the
# network: a background thread receives targets from this Pi into `tgt`, and the
# main loop calls servoj every control cycle. If this Pi stops sending for 0.5 s
# the robot stops itself.
FOLLOW = f"""def pi_follow():
  textmsg("pi_follow: connecting")
  if not socket_open("{args.pi}", {args.port}, "pi"):
    popup("pi_follow: cannot reach Pi {args.pi}:{args.port}", "Follow", error=True, blocking=False)
    halt
  end
  global tgt = get_actual_joint_positions()
  global lost = False
  thread reader():
    while not lost:
      q = socket_read_ascii_float(6, "pi", 0.5)
      if q[0] == 6:
        global tgt = [q[1], q[2], q[3], q[4], q[5], q[6]]
      else:
        global lost = True
      end
    end
  end
  thrd = run reader()
  textmsg("pi_follow: connected, following")
  while not lost:
    servoj(tgt, t={DT}, lookahead_time=0.2, gain=200)
  end
  textmsg("pi_follow: link lost, stopping")
  stopj(2.0)
end
"""


def leader_ready():
    """The newest leader sample if the leader is live, started and healthy; else (None, reason)."""
    s = LINK.latest()
    if s is None or time.monotonic() - s.at > args.hold_after * 2:
        age = LINK.link_age()
        return None, ("no leader Pi heard yet (is leader_pi.py running? same link key? right --peer?)"
                      if age == float("inf") else
                      "leader Pi is linked, waiting for it to send joints" if age < 1.0 else
                      f"leader Pi silent for {age:.0f} s")
    if s.flags & link.F_FAULT:
        return None, "leader Pi reports a problem with the UR3e"
    if not s.flags & link.F_ACTIVE:
        return None, "leader Pi is linked; waiting for Enter to be pressed there"
    return s, ""


def run_follow():
    set_state(link.READY)
    say("[..] waiting for the leader Pi to start (press Enter there)")
    shown = ""
    while True:
        FOL.check()
        first, why = leader_ready()
        if first:
            break
        if why != shown:
            shown = why
            say("     " + why, YEL)
        time.sleep(0.05)
    say(f"[OK] leader Pi live at {LINK.addr[0]}  (packet loss so far {LINK.loss_pct():.1f}%)", GRN)

    send_script(FOL.ip, FOLLOW)
    say(f"[..] waiting for UR10e to connect back to {args.pi}:{args.port}")
    srv.settimeout(0.5)
    t0 = time.time()
    while True:
        FOL.check()
        try:
            conn, addr = srv.accept(); break
        except socket.timeout:
            if time.time() - t0 > 10:
                ps = FOL.dash.cmd("programState") or "?"
                raise Fault(f"UR10e never connected back (programState: {ps}). It ignored the program "
                            "or can't reach the Pi. Check Remote + Automatic + Security->Services "
                            "and the pendant Log tab.")
    conn.settimeout(1.0)
    try:
        first, why = leader_ready()
        if not first:
            raise Fault("leader Pi dropped out while the UR10e was starting: " + why)
        l0 = list(first.q)                      # anchor: UR3e pose now
        f0 = list(FOL.q)                        # anchor: UR10e pose now
        # mirror mode: keep whole turns on base and wrists, so a UR10e wrist at
        # 270 deg does not spin a full turn to reach the UR3e's -90 deg
        turns = [0.0] * 6
        if args.absolute:
            for i in (0, 3, 4, 5):
                turns[i] = round((f0[i] - l0[i]) / TWO_PI) * TWO_PI
        filt, prev, prev_t, last_seq = list(l0), list(l0), first.t, first.seq
        pos, vel = list(f0), [0.0] * 6
        alpha = DT / (args.smooth + DT) if args.smooth > 0 else 1.0
        dv_max = args.amax * DT
        mode = "ABSOLUTE (drives to the UR3e pose first!)" if args.absolute else \
               f"RELATIVE x{args.scale:g} (UR10e moves {args.scale:.0%} of what the UR3e moves)"
        say(f"[OK] UR10e connected from {addr[0]}: FOLLOWING, {mode}. Ctrl-C to stop.", GRN)
        set_state(link.FOLLOWING)
        n, last, holds, holding = 0, 0.0, 0, False
        tick = time.perf_counter()
        while True:
            FOL.check()
            # the robot never sends anything now, so "readable" means it closed the link
            if select.select([conn], [], [], 0)[0] and not conn.recv(16):
                raise Fault("UR10e closed the link (protective stop or program stopped)")

            s = LINK.latest()
            if s is None:
                raise Fault("the leader Pi restarted; press r then Enter to follow it again")
            age = time.monotonic() - s.at
            if s.seq != last_seq:               # a new reading arrived over Wi-Fi
                if s.flags & link.F_BYE:
                    raise Fault("the leader Pi was stopped (Ctrl-C or quit there)")
                if s.flags & link.F_FAULT:
                    raise Fault("the leader Pi reports a problem with the UR3e (look at its terminal)")
                if not s.flags & link.F_ACTIVE:
                    raise Fault("the leader Pi paused")
                gap = max(0.0, s.t - prev_t)    # measured on the leader's own clock, so Wi-Fi bunching doesn't matter
                jump = max(abs(a - b) for a, b in zip(s.q, prev))
                if jump > JUMP_LIMIT + LEADER_VMAX * gap:
                    raise Fault(f"UR3e reading jumped {math.degrees(jump):.0f} deg in {gap * 1000:.0f} ms; stopped to be safe")
                prev, prev_t, last_seq = list(s.q), s.t, s.seq
            if age > args.link_timeout:
                raise Fault(f"no data from the leader Pi for {age:.1f} s (Wi-Fi dropped, or leader_pi.py stopped)")
            was, holding = holding, age > args.hold_after
            if holding and not was:
                holds += 1
                set_state(link.HOLD)
                con.quiet(f"HOLD: no leader data for {age * 1000:.0f} ms")
            elif was and not holding:
                set_state(link.FOLLOWING)
            if not holding:                     # while holding, the goal stays where it was
                filt = [f + alpha * (r - f) for f, r in zip(filt, prev)]
            if args.absolute:
                goal = [max(-JOINT_LIMIT, min(JOINT_LIMIT, f + t)) for f, t in zip(filt, turns)]
            else:
                goal = [b + args.scale * (l - a) for b, l, a in zip(f0, filt, l0)]
            for i in range(6):
                e = goal[i] - pos[i]
                mag = abs(e) - DEADBAND
                vd = math.copysign(min(args.vmax, math.sqrt(2 * args.amax * mag)), e) if mag > 0 else 0.0
                vel[i] += max(-dv_max, min(dv_max, vd - vel[i]))
                pos[i] += vel[i] * DT
            conn.sendall(("(" + ",".join(f"{x:.6f}" for x in pos) + ")\n").encode())
            n += 1
            tick += DT                          # steady 125 Hz stream
            delay = tick - time.perf_counter()
            if delay > 0: time.sleep(delay)
            elif delay < -0.1: tick = time.perf_counter()
            if time.time() - last > 0.5:
                last = time.time()
                fq = FOL.fresh_q()
                lag = max(abs(a - b) for a, b in zip(pos, fq)) if fq else 0.0
                if math.degrees(lag) > args.max_lag:
                    raise Fault(f"UR10e is {math.degrees(lag):.0f} deg behind its command (blocked or stopped?)")
                con.status((col(YEL, "● HOLD     ") if holding else col(GRN, "● FOLLOWING")) +
                           f"  cmds {n}  speed {max(abs(v) for v in vel):.2f} rad/s  lag {math.degrees(lag):4.1f}°"
                           f"  |  Wi-Fi: age {age * 1000:3.0f} ms  loss {LINK.loss_pct():.1f}%  holds {holds}"
                           f"  |  UR10e {FOL.mode}/{FOL.safety}")
    finally:
        conn.close()


# ── fault handling: tell you, then ask ──────────────────────────
def show_fault(why):
    time.sleep(0.6)
    FOL.poll()
    bar = "=" * 70
    lines = [bar, "  FAULT: the UR10e was sent STOP (the leader Pi is told, and locks the UR3e)", bar,
             f"  What happened: {why}",
             f"  UR10e  {FOL.mode} / {FOL.safety}" + ("" if FOL.healthy() else f"   <- {FOL.hint()}")]
    if FOL.msgs:
        lines.append("  Recent UR10e messages:")
        lines += ["    " + m for m in FOL.msgs[-4:]]
    lines += [f"  (all of this is also in {args.log})", bar]
    for l in lines:
        say(l, RED, "FAULT")


def recover():
    ok = FOL.unlock_if_protective_stop()
    if "false" in (FOL.dash.cmd("is in remote control") or "").lower():
        ok = False
        say("[!!] UR10e dropped out of Remote Control: profile icon -> Remote", YEL)
    return ok


def fault_dialog(why):
    FOL.raise_fault(why)
    set_state(link.FAULTED, FOL.fault_why)
    FOL.stop(STOP_F)
    show_fault(FOL.fault_why)
    while True:
        a = input(col(YEL, "\n  [r] recover + check the UR10e   [q] quit  > ")).strip().lower()
        if a == "q":
            return False
        if a != "r":
            continue
        if not recover():
            say("Not ready yet. Fix the items above, then press r again.", YEL)
            continue
        a = input(col(GRN, "  UR10e healthy. It will follow from where it is now, once the leader Pi is started again.\n"
                           "  Press Enter to RESUME, q to quit > ")).strip().lower()
        if a == "q":
            return False
        FOL.fault.clear()
        say("[OK] resuming", GRN)
        return True


# ── main ─────────────────────────────────────────────────────────
try:
    if not args.no_home:
        try:
            set_state(link.HOMING)
            do_home(FOL, args.home_speed, 0.4)
        except Fault as f:
            FOL.raise_fault(str(f))
            set_state(link.FAULTED, FOL.fault_why)
            FOL.stop(STOP_F)
            show_fault(FOL.fault_why)
            sys.exit(1)
    set_state(link.WAITING)
    what = "copies the UR3e's joint angles" if args.absolute else f"follows the UR3e at x{args.scale:g}"
    input(col(GRN, f"\n  Ready. The UR10e {what} as soon as the leader Pi is started.\n"
                   "  Press Enter to ARM the UR10e, Ctrl-C to cancel... "))
    while True:
        FOL.watch.set()
        try:
            run_follow()
        except (Fault, OSError) as f:
            if not fault_dialog(str(f)):
                break
except (KeyboardInterrupt, EOFError):
    pass
finally:
    set_state(link.FAULTED, "follower_pi.py was stopped")
    FOL.stop(STOP_F)
    LINK.send_feedback(link.FAULTED, None, "follower_pi.py was stopped")
    say("[*] stopped: UR10e stop sent")
    srv.close()
