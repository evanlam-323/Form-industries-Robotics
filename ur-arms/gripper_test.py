#!/usr/bin/env python3
"""Talks straight to the Robotiq gripper (no relay, no browser) and reports what it says.
Usage:  python3 gripper_test.py [robot_ip]      (default 169.254.190.160)"""
import socket, sys, time

ip = sys.argv[1] if len(sys.argv) > 1 else "169.254.190.160"

def cmd(s, c):
    s.sendall((c + "\n").encode())
    r = s.recv(64).decode(errors="ignore").strip()
    print(f"  {c:<12} -> {r}")
    return r

print(f"Connecting to {ip}:63352 …")
with socket.create_connection((ip, 63352), timeout=3) as s:
    s.settimeout(3)
    cmd(s, "GET STA"); cmd(s, "GET ACT"); cmd(s, "GET FLT"); cmd(s, "GET POS")
    if "3" not in cmd(s, "GET STA"):
        print("Not activated — activating…"); cmd(s, "SET ACT 1"); time.sleep(3); cmd(s, "GET STA")
    for target, name in ((0, "OPEN"), (255, "CLOSE"), (0, "OPEN")):
        print(f"\n{name}:")
        for c in (f"SET POS {target}", "SET SPE 255", "SET FOR 255", "SET GTO 1"):
            cmd(s, c)
        time.sleep(1.5); cmd(s, "GET POS"); cmd(s, "GET OBJ"); cmd(s, "GET FLT")
print("\nDone.")
