# Two Pis, one on each arm

One Raspberry Pi is wired to the UR3e and another to the UR10e. This folder is the code for both.

```
   UR3e ──cable── Pi A (leader)  ~~~ shop Wi-Fi ~~~  Pi B (follower) ──cable── UR10e
                     │                                   │
                     └──────── internet (HTTPS) ─────────┘
                                      │
                         arm-state relay on Hyperform
                                      │
                                 FactoryForm
```

Two separate jobs run on each Pi:

| Job | Files | Can it move a robot? |
|---|---|---|
| **Leader-follower.** You move the UR3e by hand and the UR10e follows. | `leader_pi.py` on Pi A, `follower_pi.py` on Pi B, plus `link.py` and `ur_common.py` | Yes: Pi B drives the UR10e, Pi A switches UR3e freedrive on and off. |
| **Live state.** Each Pi reports its arm's joints to the relay, for FactoryForm's twin. | `arm_state_pusher.py` on both, `relay/` on Hyperform | No. Listen-only. |

Everything on the Pis is Python 3 standard library: nothing to install.

**Status (2026-11-21): tested with pretend robots only, not yet on the real arms.** See "What has been tested" at the bottom before the first real run.

## 1. One-time setup on each Pi

Get the code (the repository is public, so no login is needed):

```
git clone -b feature/two-pi-link https://github.com/evanlam-323/Form-industries-Robotics.git ~/ur-arms
```

Later, to update: `cd ~/ur-arms && git pull`.

Give the Pi its address on the robot's cable. These do not survive a reboot or a replug (same as before), so repeat them when the script says it can't read the arm. Check the port name with `ip -br link`.

```
# Pi A (UR3e at 169.254.190.160)
sudo ip addr add 169.254.190.100/16 dev eth0

# Pi B (UR10e at 192.168.1.20)
sudo ip addr add 192.168.1.250/24 dev eth0
```

Make the link key **once**, on either Pi, and put the same key on **both**. It is what stops anything else on the Wi-Fi from steering the UR10e. Keep it out of chat and out of git.

```
python3 ~/ur-arms/two_pi/link.py --make-key
echo 'PASTE-THE-KEY-HERE' > ~/.ur_link_key && chmod 600 ~/.ur_link_key      # on both Pis
```

Find Pi B's Wi-Fi address (Pi A needs it): run `hostname -I` on Pi B and take the `172.16.…` one.

## 2. Leader-follower

Open two Terminal windows on the Mac, one SSH session to each Pi. The order doesn't matter.

**Pi B (UR10e)**: pendant in Automatic + Remote, then:

```
python3 ~/ur-arms/two_pi/follower_pi.py --absolute --vmax 1
```

**Pi A (UR3e)**:

```
python3 ~/ur-arms/two_pi/leader_pi.py --peer <Pi B's Wi-Fi address>
```

Each one checks its own arm, offers to home it, then waits for you to press Enter. When both have been started, the UR10e starts following and the UR3e goes into freedrive. Ctrl-C on either side stops both.

The options are the same as `follow_socket.py`, and they go on **Pi B** because that is the side that moves the UR10e: `--absolute` (mirror), `--scale 0.1`, `--vmax`, `--amax`, `--smooth`, `--no-home`. Pi A only takes `--no-home` and `--no-freedrive`.

### What happens when the Wi-Fi misbehaves

Pi B keeps its own steady 125 Hz stream to the UR10e over the cable, exactly as before, and treats what arrives over Wi-Fi as a moving goal. So late or lost Wi-Fi packets make the UR10e a little later, not jerky.

| Situation | UR10e (Pi B) | UR3e (Pi A) |
|---|---|---|
| Packets lost or late | keeps following smoothly | nothing |
| No data for 0.15 s (`--hold-after`) | **HOLD**: glides to a stop at the last goal, carries on when data returns | nothing |
| No data for 1.5 s (`--link-timeout`) | **FAULT**: stopped, asks before resuming | after 1 s without word from Pi B: freedrive **off** |
| UR10e protective stop or other fault | stopped, fault box as before | freedrive **off**, shows why |
| UR3e fault, or Ctrl-C on Pi A | **FAULT**: stopped | freedrive off |
| Pi B crashes or loses power | stops itself after 0.5 s without commands (this is in the robot's own program) | freedrive off after 1 s |

After any stop, each Pi asks for `r` (recover and check its arm) and Enter before anything moves again. The UR3e locking in your hand is the signal that something stopped.

The bottom line of Pi B's terminal shows the link: `Wi-Fi: age 12 ms  loss 0.4%  holds 0`. If `holds` climbs while you work, the Wi-Fi is too weak where the Pis sit; a network cable between the Pis fixes it and needs no change here (use the cable's addresses for `--peer`). If the motion feels nervous, try `--smooth 0.2`.

## 3. Live state to Hyperform and FactoryForm

Test by hand first (on either Pi; `--check` reads the arm once and prints it, compare with the pendant):

```
python3 ~/ur-arms/two_pi/arm_state_pusher.py --arm ur-small=169.254.190.160 --check     # Pi A
python3 ~/ur-arms/two_pi/arm_state_pusher.py --arm ur-large=192.168.1.20 --check        # Pi B
```

Then make it start on its own at boot: follow the five lines at the top of `arm-state.service`. `ur-small` and `ur-large` are the ids FactoryForm already uses for the UR3e and UR10e.

The relay (`relay/`) is a small web service for Hyperform. The Pis post to it with a key; FactoryForm reads from it with a key. It keeps the last reading of each arm in memory, marks an arm "not live" 2 s after it goes quiet, and has no route that can command a robot. It uses the same three addresses and the same JSON as FactoryForm's own `server/robot-live.js`.

Settings on Hyperform: root folder `two_pi/relay`, port 3001, public access, and two secret variables: `ROBOT_API_KEY` (the Pis post with it) and `ROBOT_READ_KEY` (FactoryForm reads with it).

Is it working? `https://THE-RELAY-ADDRESS/healthz` in a browser shows how many arms are live.

## What has been tested

Run the tests yourself (Linux or a Pi; about a minute): `python3 two_pi/tests/test_two_pi.py` and, in `two_pi/relay`, `node --test`.

Tested in a cloud Linux workspace with **pretend** UR controllers (`tests/sim_ur.py`) and a pretend Wi-Fi that drops, delays and cuts the link:

- mirror and scaled modes follow; speed and acceleration sent to the UR10e stay inside `--vmax` / `--amax`, also with 15% packet loss and 60 ms of jitter;
- a 0.6 s gap holds and carries on; a long gap stops the UR10e, switches UR3e freedrive off, and both recover with `r` + Enter;
- a Pi with the wrong key is ignored and nothing moves;
- Ctrl-C on Pi A, and a UR10e protective stop, each stop the other side;
- a UR10e that is not in Remote Control is refused before anything is sent;
- the relay: two pushers in, both arms out, keys enforced, stale after 2 s.

**Not tested: the real arms, real Pis, or the real shop Wi-Fi.** The parts that talk to the robots (the URScript sent to the UR10e, freedrive, homing, fault handling) are copied from `follow_socket.py` v2.1, which does work on the real arms, but the two-Pi split itself has never driven them. For the first real run: `--vmax 0.3` (the default), stand clear of the UR10e, hand on the e-stop, and pull Pi B's Wi-Fi on purpose once to watch it stop.

`follow_socket.py` (one Pi, both arms) is unchanged and still works as before.
