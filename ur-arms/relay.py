# relay.py — UR3e Relay Server
# Run with: python3 relay.py
from http.server import HTTPServer, BaseHTTPRequestHandler
import socket, json, struct, time, threading, os, urllib.request, urllib.error

ROBOT_PORT   = 30002   # URScript injection
STATE_PORT   = 30003   # Real-time client (robot telemetry)
GRIPPER_PORT = 63352   # Robotiq 2F-85 URCap Modbus TCP daemon

# ── 🤖 Gemini AI Assistant Config ───────────────────────────────────────
# Never hardcode the key here. Set it as an environment variable before
# launching the relay, e.g.:
#   macOS/Linux:  export GEMINI_API_KEY="your-key-here"
#   Windows CMD:  set GEMINI_API_KEY=your-key-here
# Get a free key at https://aistudio.google.com/apikey
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL   = "gemini-3.1-flash-lite"
GEMINI_URL     = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

AI_SYSTEM_PROMPT = """You are the built-in assistant for a custom UR3e robot arm web pendant
(a UR3e with a Robotiq 2F-85 gripper). You help operators build, understand, and debug
robot programs.

The app has three AI modes:
- Ask: answer questions about positions, steps, settings, and how the builder works.
- Generate: build a brand-new program from scratch (switch to Generate mode to do this).
- Modify: make targeted edits to the existing program (switch to Modify mode to do this).

The program builder's step types are: movej, movel, movec, guarded_move, activate_gripper,
open_gripper, close_gripper, read_gripper, loop_start, if_start, else_if, else, wait_cond,
thread_start, end, assign, timer, sleep, textmsg, popup, halt, set_digital_out, set_payload,
set_tcp, set_gravity, zero_ftsensor, set_baselight, comment, folder.

You will be given the current state of the user's project (positions, steps, settings, and
whether Simulation Mode is on) as JSON context. Use it to answer questions concretely
(e.g. "what does PICK's Z look like", "why would my loop never run", "what will step 4 do").

Rules:
- Be concise. Prefer short, direct answers over long essays.
- When asked to write or modify a program, describe what to do AND suggest switching to
  Generate or Modify mode so it can be done automatically.
- If something in their program looks like a mistake (e.g. an if_start with no matching end,
  or a movec missing a via/to position), point it out proactively but briefly.
- If you don't have enough context to answer, say so plainly instead of guessing.
"""

# ── 🛠 Program-generation system prompt (Stage 2: JSON program output) ──
# This is deliberately a condensed version of JSONBuilderCode.md. Keep the
# two in sync if the step schema ever changes.
PROGRAM_GEN_SYSTEM_PROMPT = """You generate a UR3e Program Builder project as JSON. The robot is a
UR3e with a Robotiq 2F-85 gripper. Output MUST be a single JSON object and NOTHING ELSE —
no markdown fences, no commentary, no explanation before or after.

TOP-LEVEL SHAPE (all three keys required):
{
  "positions": [ ... ],
  "steps": [ ... ],
  "settings": { "js": 1.05, "ja": 1.4, "ls": 0.25, "la": 1.2 }
}
Do not add other top-level keys or other settings keys.

POSITIONS — each item:
{ "id": "gp0", "name": "APPROACH", "j": [6 numbers, radians], "c": [6 numbers: x,y,z,rx,ry,rz in metres/radians] }
- "id" must be unique among positions you generate. Prefix generated ids with "gp" (gp0, gp1, ...)
  so they cannot collide with the user's existing position ids.
- Reuse an EXISTING position (by its given id) from the context below instead of creating a
  duplicate whenever the user's request refers to a place they already have saved (e.g. "HOME").
- Only invent new positions with placeholder joint/cartesian values when the user's request needs
  a position that doesn't exist yet; make clear in your numbers that these are placeholders
  the user must jog/teach for real (e.g. keep them near an existing related position's values,
  don't fabricate wildly different numbers).

STEPS — every step has "id" (prefix generated ids with "gs", unique, e.g. gs0, gs1, ...) and "type".
Allowed "type" values and their REQUIRED fields (use exactly these key names):
  movej            { pid }                          — joint move to a saved position
  movel            { pid }                          — linear move to a saved position
  movec            { via, to }                       — circular move through one position to another
  guarded_move     { speed (m/s), retract (mm) }      — force/contact search move
  activate_gripper {}                                 — activate the Robotiq gripper
  open_gripper     {}
  close_gripper    {}
  read_gripper     { varName }                        — reads gripper position into a variable
  loop_start       { loopType: "forever" | "times", loopCount (only if loopType=="times") }
  if_start         { condition }                       — URScript-style boolean expression string
  else_if          { condition }
  else             {}
  wait_cond        { condition }
  thread_start     { threadName }
  end              {}                                  — closes the most recent loop_start/if_start/thread_start/folder
  assign           { varName, varValue }               — varValue is a string expression
  timer            { timerAct: "start" | "read", timerVar }
  sleep            { sec (number) }
  textmsg          { msg }
  popup            { msg, pType: "msg" }
  halt             {}
  set_digital_out  { port (number), val (boolean) }
  set_payload      { weight (kg) }
  set_tcp          { pose: "x,y,z,rx,ry,rz" as a comma-separated string }
  set_gravity      { gravX (number), gravY (number), gravZ (number) }   — set gravity vector
  zero_ftsensor    {}                                                     — zero force/torque sensor
  set_baselight    { color: "white"|"blue"|"green"|"red"|"off" }         — set robot base LED
  comment          { commentTxt }
  folder           { folderName }                      — closed with "end"

RULES:
- Every loop_start / if_start / thread_start / folder MUST have a matching "end" later in the
  same steps array, correctly nested (don't close outer blocks before inner ones).
- movej/movel "pid" and movec "via"/"to" must reference a position id that exists — either an
  existing id given in context, or one you created in this response's "positions" array.
- Use numbers as JSON numbers, not strings, except where the field is explicitly text
  (condition, msg, varValue, pose, commentTxt, folderName, threadName, varName, pType).
- Do not invent step types outside the list above.
- Keep the program only as long as needed to satisfy the request — don't pad with unrelated steps.
"""

# ── 🩹 Program-modification system prompt (Stage 3: targeted patches) ──
# Deliberately NOT a full-program regenerator. Emits a small ordered list
# of patch operations against the user's EXISTING step ids, so edits stay
# minimal, reviewable, and never silently rewrite untouched parts of the
# program.
STEP_FIELD_TABLE = """  movej            { pid }                          — joint move to a saved position
  movel            { pid }                          — linear move to a saved position
  movec            { via, to }                       — circular move through one position to another
  guarded_move     { speed (m/s), retract (mm) }      — force/contact search move
  activate_gripper {}
  open_gripper     {}
  close_gripper    {}
  read_gripper     { varName }
  loop_start       { loopType: "forever" | "times", loopCount (only if loopType=="times") }
  if_start         { condition }
  else_if          { condition }
  else             {}
  wait_cond        { condition }
  thread_start     { threadName }
  end              {}
  assign           { varName, varValue }
  timer            { timerAct: "start" | "read", timerVar }
  sleep            { sec (number) }
  textmsg          { msg }
  popup            { msg, pType: "msg" }
  halt             {}
  set_digital_out  { port (number), val (boolean) }
  set_payload      { weight (kg) }
  set_tcp          { pose: "x,y,z,rx,ry,rz" as a comma-separated string }
  set_gravity      { gravX (number), gravY (number), gravZ (number) }
  zero_ftsensor    {}
  set_baselight    { color: "white"|"blue"|"green"|"red"|"off" }
  comment          { commentTxt }
  folder           { folderName }"""

MODIFY_SYSTEM_PROMPT = f"""You modify an EXISTING UR3e Program Builder project by emitting a small,
targeted set of patch operations. You do NOT regenerate the whole program, and you do NOT re-emit
steps that aren't changing. Output MUST be a single JSON object and NOTHING ELSE — no markdown
fences, no commentary.

OUTPUT SHAPE:
{{
  "ops": [ ... ],
  "newPositions": [ ... ]   // optional — only if the request needs a position that doesn't exist yet,
                             // same shape as position generation: {{ "id": "gp0", "name", "j": [...], "c": [...] }}
}}

You will be given the user's CURRENT steps (each with its real "id", "type", and parameters) and
current positions as context. Reference EXISTING step ids EXACTLY as given in that context —
never invent, guess, or renumber a step id.

ALLOWED OPERATIONS in "ops" (applied in the order you list them):
  {{ "op": "insert_before", "targetId": "<existing step id>", "steps": [ <new step objects> ] }}
  {{ "op": "insert_after",  "targetId": "<existing step id>", "steps": [ <new step objects> ] }}
  {{ "op": "delete",        "targetId": "<existing step id>" }}
  {{ "op": "replace",       "targetId": "<existing step id>", "step": <one new step object> }}

Note on "replace": the fields you provide in "step" are MERGED onto the existing step — you only
need to include the fields you're actually changing. Any field you omit keeps its current value.

New step objects use the exact same schema as below (type + its required fields). Do NOT include
an "id" field on new steps — ids are assigned automatically when applied.

STEP TYPES AND REQUIRED FIELDS:
{STEP_FIELD_TABLE}

COMMON PATTERN — inserting a new branch into an existing if/elseif/else chain:
To add a new "else_if" branch in the middle of an existing chain, use "insert_before" targeting
the id of whichever step currently comes right after where the new branch should go (the next
else_if, the else, or the closing end of that if-block). Example — inserting a branch before the
existing step with id "u18":
  {{ "op": "insert_before", "targetId": "u18", "steps": [
      {{ "type": "else_if", "condition": "part_size == 230" }},
      {{ "type": "movel", "pid": "u2" }},
      {{ "type": "open_gripper" }}
  ] }}
Note: an inserted else_if branch does NOT need its own "end" — it's joining an if-block that's
already open and already has one closing "end" later in the sequence.

RULES:
- Make the smallest edit that satisfies the request. Don't touch or re-emit unrelated steps.
- Any loop_start/if_start/thread_start/folder YOU insert as a whole new block must include its
  own matching "end" within the same insert. Branch-only insertions (else_if/else content) do not.
- movej/movel "pid" and movec "via"/"to" in new steps must reference a position id that already
  exists in context, or one you add via "newPositions".
- Use numbers as JSON numbers, not strings, except explicitly-text fields (condition, msg,
  varValue, pose, commentTxt, folderName, threadName, varName, pType).
- If the request is ambiguous about WHERE to insert, pick the most sensible existing target id
  based on the step list given and proceed — don't ask a question, this is a single-shot API call.
"""

# ── 💬 Popup State ──────────────────────────────────────────────────────
popup_msg = None
popup_resolved = False
ignore_popups_until = 0

# ── 🌟 Global State (Digital Twin Caching) ──────────────────────────────
target_ip = None
ui_logs = []

robot_state = {
    "connected": False,
    "joints": None,
    "tcp": None
}

robot_dashboard_state = {
    "prog": "",
    "mode": ""
}

# ── 🧵 Background Thread 1: Kinematics (Port 30003) ───────────────────
def state_monitor():
    """Background thread that persistently reads telemetry from the robot."""
    global target_ip, robot_state
    current_socket = None
    logged_connecting = False
    last_logged_ip = None

    while True:
        if not target_ip:
            time.sleep(0.5)
            continue

        if target_ip != last_logged_ip:
            logged_connecting = False
            last_logged_ip = target_ip

        try:
            if current_socket is None:
                if not logged_connecting:
                    print(f"📡 [Kinematics] Connecting to {target_ip}:{STATE_PORT}...")
                    logged_connecting = True
                current_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                current_socket.settimeout(2.0)
                current_socket.connect((target_ip, STATE_PORT))
                current_socket.settimeout(5.0) 
                print(f"✅ [Kinematics] Connected!")
                logged_connecting = False

            size_data = recv_exact(current_socket, 4)
            size = struct.unpack('>i', size_data)[0]
            payload = recv_exact(current_socket, size - 4)

            if size >= 1220:
                q_actual = list(struct.unpack('>6d', payload[248:248+48]))
                p_actual = list(struct.unpack('>6d', payload[440:440+48]))
                robot_state['joints'] = q_actual
                robot_state['tcp'] = p_actual
                robot_state['connected'] = True
            else:
                time.sleep(0.01)

        except Exception as e:
            if robot_state['connected']:
                print(f"⚠️ [Kinematics] Connection lost: {e}. Retrying...")
            robot_state['connected'] = False
            robot_state['joints'] = None
            robot_state['tcp'] = None
            if current_socket:
                try: current_socket.close()
                except: pass
                current_socket = None
            time.sleep(1.0)

# ── 🧵 Background Thread 2: Dashboard (Port 29999) ────────────────────
def dashboard_monitor():
    """Background thread preventing socket exhaustion on the Dashboard Server while polling state & safety."""
    global target_ip, robot_dashboard_state, popup_msg, popup_resolved, ignore_popups_until
    current_socket = None
    logged_connecting = False
    last_logged_ip = None

    while True:
        if not target_ip:
            time.sleep(0.5)
            continue

        if target_ip != last_logged_ip:
            logged_connecting = False
            last_logged_ip = target_ip

        try:
            if current_socket is None:
                if not logged_connecting:
                    print(f"📡 [Dashboard] Connecting to {target_ip}:29999...")
                    logged_connecting = True
                current_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                current_socket.settimeout(2.0)
                current_socket.connect((target_ip, 29999))
                current_socket.settimeout(5.0)
                current_socket.recv(1024) 
                print(f"✅ [Dashboard] Connected!")
                logged_connecting = False

            

            # 1. Poll Program State
            current_socket.sendall(b"programState\n")
            raw_prog = current_socket.recv(1024).decode('utf-8', errors='ignore').strip()
            robot_dashboard_state["prog"] = raw_prog

            # --- Native Popup Interception Check ---
            # Only intercept if we are NOT in the 2-second UI dismiss cooldown period
            if time.time() > ignore_popups_until:
                if "Popup:" in raw_prog or "Warning:" in raw_prog or "Error:" in raw_prog:
                    clean_msg = raw_prog.replace("Popup:", "").replace("Warning:", "").strip()
                    print(f"🚨 [Native Pendant Alert] Intercepted: {clean_msg}")
                    popup_msg = f"[Pendant System Alert] {clean_msg}"
                    popup_resolved = False

            # 2. Poll Robot Mode
            current_socket.sendall(b"robotmode\n")
            robot_dashboard_state["mode"] = current_socket.recv(1024).decode('utf-8', errors='ignore').strip()

            # 3. Poll Safety Status (Protective & E-Stops)
            current_socket.sendall(b"safetystatus\n")
            raw_safety = current_socket.recv(1024).decode('utf-8', errors='ignore').strip()
            
            # Trigger custom popups based on the native safety states, respecting cooldown
            if time.time() > ignore_popups_until:
                if "PROTECTIVE_STOP" in raw_safety and (not popup_msg or "Protective Stop" not in popup_msg):
                    print(f"🚨 [Safety Alert] Intercepted: {raw_safety}")
                    popup_msg = "⚠️ Protective Stop Triggered! The robot detected a collision or excessive force."
                    popup_resolved = False
                    
                elif "EMERGENCY_STOP" in raw_safety and (not popup_msg or "EMERGENCY STOP" not in popup_msg):
                    print(f"🚨 [Safety Alert] Intercepted: {raw_safety}")
                    popup_msg = "🚨 EMERGENCY STOP ENGAGED! Release the physical E-Stop button to continue."
                    popup_resolved = False

            time.sleep(0.25) 

        except Exception as e:
            robot_dashboard_state["prog"] = ""
            robot_dashboard_state["mode"] = ""
            if current_socket:
                try: current_socket.close()
                except: pass
                current_socket = None
            time.sleep(2.0)

# ── Reliable socket reader ─────────────────────────────────────────────
def recv_exact(sock, n):
    buf = b''
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError(f"Socket closed after {len(buf)}/{n} bytes")
        buf += chunk
    return buf

# ── Gripper Helpers ────────────────────────────────────────────────────
def gripper_write_packet(action_byte, position, speed, force):
    data = bytes([action_byte, 0x00, 0x00, position, speed, force])
    pdu  = struct.pack('>BHH', 0x10, 0x03E8, 3) + bytes([6]) + data
    mbap = struct.pack('>HHH', 1, 0, 1 + len(pdu)) + bytes([9])
    return mbap + pdu

# ── HTTP Handler ───────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        # --- All globals declared ONCE at the very top of the function ---
        global target_ip, popup_msg, popup_resolved, ignore_popups_until, ui_logs
        
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        data = json.loads(body) if body else {}

        ip = data.get('ip', '')
        action = data.get('action', 'send')
        resp = b'{"ok":false}'

        # ── Script sending ─────────────────────────────────────────────
        if action == 'send':
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.settimeout(2.0)
                    s.connect((ip, ROBOT_PORT))
                    s.sendall(data['code'].encode())
                resp = b'{"ok":true}'
            except Exception as e:
                resp = json.dumps({"ok": False, "error": str(e)}).encode()

        # ── Direct URScript execution (for Hold-to-Move) ───────────────
        elif action == 'urscript':
            try:
                script = data.get('script', '') + '\n'
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.settimeout(2.0)
                    s.connect((ip, ROBOT_PORT))
                    s.sendall(script.encode())
                resp = b'{"ok":true}'
            except Exception as e:
                resp = json.dumps({"ok": False, "error": str(e)}).encode()

        # ── Get Live Position (INSTANT CACHE READ) ─────────────────────
        elif action in ['state', 'get_position']:
            req_ip = data.get('ip', '')
            
            if req_ip and target_ip != req_ip:
                target_ip = req_ip
                time.sleep(0.2) 

            if robot_state['connected'] and robot_state['joints']:
                resp = json.dumps({
                    "ok": True,
                    "joints": robot_state['joints'],
                    "tcp": robot_state['tcp'],
                    "cartesian": robot_state['tcp'] 
                }).encode()
            else:
                resp = json.dumps({"ok": False, "error": "Connecting..."}).encode()

        # ── Get Dashboard Status (INSTANT CACHE READ) ──────────────────
        elif action == 'dashboard_status':
            req_ip = data.get('ip', '')
            
            if req_ip and target_ip != req_ip:
                target_ip = req_ip
                time.sleep(0.2)
                
            resp = json.dumps({
                "ok": True, 
                "prog": robot_dashboard_state["prog"],
                "mode": robot_dashboard_state["mode"]
            }).encode()

        # ── Dashboard Server Execution Controls ────────────────────────
        elif action in ['dashboard_pause', 'dashboard_stop', 'dashboard_play']:
            try:
                # This neatly extracts "pause\n", "stop\n", or "play\n"
                cmd = action.split('_')[1] + "\n" 
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.settimeout(2.0)
                    s.connect((ip, 29999))
                    s.recv(1024) # Consume the robot's welcome message
                    s.sendall(cmd.encode())
                resp = b'{"ok":true}'
            except Exception as e:
                resp = json.dumps({"ok": False, "error": str(e)}).encode()

        # ── Hardware Speed Override (Port 30003) ───────────────────────
        elif action == 'dashboard_speed':
            try:
                # 1. Grab 'fraction' instead of 'speed' to match network.js
                frac_speed = float(data.get('fraction', 1.0))
                
                # 2. Hard safety bounds (1% to 100%)
                frac_speed = max(0.01, min(frac_speed, 1.0))
                
                # 3. Connect to Port 30003 (Real-Time Port) and use 'set speed'
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.settimeout(2.0)
                    s.connect((ip, 30003))
                    # Port 30003 does not have a welcome message, so no recv() needed
                    s.sendall(f"set speed {frac_speed}\n".encode())
                resp = b'{"ok":true}'
            except Exception as e:
                resp = json.dumps({"ok": False, "error": str(e)}).encode()

        # ── Gripper Move ───────────────────────────────────────────────
        elif action == 'gripper_move':
            pos = data.get('pos', 255)
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.settimeout(2.0)
                    s.connect((ip, GRIPPER_PORT))
                    s.sendall(gripper_write_packet(0x09, pos, 255, 150))
                    recv_exact(s, 12)
                resp = b'{"ok":true}'
            except Exception as e:
                resp = json.dumps({"ok": False, "error": str(e)}).encode()

        # ── Gripper status (ASCII Protocol) ────────────────────────────
        elif action == 'gripper_status':
            try:
                import re
                def extract_num(text):
                    nums = re.findall(r'\d+', text)
                    return int(nums[-1]) if nums else 0

                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.settimeout(2.0)
                    s.connect((ip, 63352))
                    
                    s.sendall(b"GET STA\n")
                    sta_raw = s.recv(1024).decode('utf-8').strip()
                    
                    s.sendall(b"GET OBJ\n")
                    obj_raw = s.recv(1024).decode('utf-8').strip()

                    s.sendall(b"GET POS\n")
                    pos_raw = s.recv(1024).decode('utf-8').strip()

                    gsta = extract_num(sta_raw)
                    gobj = extract_num(obj_raw)
                    gpo  = extract_num(pos_raw)

                    resp = json.dumps({
                        "ok": True,
                        "gsta": gsta,
                        "gobj": gobj,
                        "position_raw": gpo
                    }).encode()

            except Exception as e:
                resp = json.dumps({"ok": False, "error": str(e)}).encode()

        # ── Popups ─────────────────────────────────────────────────────
        elif action == 'check_popup':
                # The UI polls this endpoint to see if a message is waiting
                resp = json.dumps({"ok": True, "msg": popup_msg}).encode()
                
        elif action == 'resolve_popup':
                popup_resolved = True
                popup_msg = None  # Clear the message so the UI drops it
                
                # Blindfold the monitor for 2 seconds so the robot has time to close the window
                ignore_popups_until = time.time() + 2.0
                
                # Auto-dismiss pendant popups AND clear protective stops
                if target_ip:
                    try:
                        dash_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                        dash_sock.connect((target_ip, 29999))
                        
                        # Command sequence to clear standard popups and safety faults
                        dash_sock.sendall(b"close popup\n")
                        dash_sock.sendall(b"close safety popup\n")
                        dash_sock.sendall(b"unlock protective stop\n")
                        
                        dash_sock.close()
                    except Exception as e:
                        print(f"Failed to auto-dismiss pendant popup: {e}")
                
                resp = json.dumps({"ok": True}).encode()
        # ── AI Assistant (Gemini) ───────────────────────────────────────
        elif action == 'ai_ask':
            if not GEMINI_API_KEY:
                resp = json.dumps({
                    "ok": False,
                    "error": "GEMINI_API_KEY is not set on the relay server. "
                             "Set it as an environment variable and restart relay.py."
                }).encode()
            else:
                try:
                    question = data.get('question', '').strip()
                    context  = data.get('context', {})
                    history  = data.get('history', [])  # [{role:'user'|'model', text:'...'}]

                    if not question:
                        resp = json.dumps({"ok": False, "error": "Empty question"}).encode()
                    else:
                        contents = []
                        # Prior turns, so follow-up questions have memory
                        for turn in history[-10:]:
                            role = 'model' if turn.get('role') == 'model' else 'user'
                            contents.append({"role": role, "parts": [{"text": turn.get('text', '')}]})

                        user_text = (
                            f"Current project context (JSON):\n{json.dumps(context)}\n\n"
                            f"Question: {question}"
                        )
                        contents.append({"role": "user", "parts": [{"text": user_text}]})

                        payload = {
                            "contents": contents,
                            "systemInstruction": {"parts": [{"text": AI_SYSTEM_PROMPT}]},
                            "generationConfig": {"temperature": 0.3, "maxOutputTokens": 1500}
                        }

                        req = urllib.request.Request(
                            f"{GEMINI_URL}?key={GEMINI_API_KEY}",
                            data=json.dumps(payload).encode(),
                            headers={"Content-Type": "application/json"},
                            method="POST"
                        )
                        with urllib.request.urlopen(req, timeout=20) as r:
                            result = json.loads(r.read().decode())

                        candidates = result.get('candidates', [])
                        if candidates and candidates[0].get('content', {}).get('parts'):
                            answer = candidates[0]['content']['parts'][0].get('text', '').strip()
                            resp = json.dumps({"ok": True, "answer": answer}).encode()
                        else:
                            reason = candidates[0].get('finishReason') if candidates else 'no candidates'
                            resp = json.dumps({"ok": False, "error": f"No answer returned ({reason})"}).encode()

                except urllib.error.HTTPError as e:
                    try:
                        err_body = json.loads(e.read().decode())
                        err_msg = err_body.get('error', {}).get('message', str(e))
                    except Exception:
                        err_msg = str(e)
                    resp = json.dumps({"ok": False, "error": f"Gemini API error: {err_msg}"}).encode()
                except Exception as e:
                    resp = json.dumps({"ok": False, "error": str(e)}).encode()

        # ── AI Program Generation (Gemini, JSON mode) ───────────────────
        elif action == 'ai_generate_program':
            if not GEMINI_API_KEY:
                resp = json.dumps({
                    "ok": False,
                    "error": "GEMINI_API_KEY is not set on the relay server. "
                             "Set it as an environment variable and restart relay.py."
                }).encode()
            else:
                try:
                    prompt  = data.get('prompt', '').strip()
                    context = data.get('context', {})

                    if not prompt:
                        resp = json.dumps({"ok": False, "error": "Empty prompt"}).encode()
                    else:
                        user_text = (
                            "Existing project context (JSON) — reuse these position ids where "
                            f"relevant, do not duplicate them:\n{json.dumps(context)}\n\n"
                            f"Generate a program for this request:\n{prompt}"
                        )

                        payload = {
                            "contents": [{"role": "user", "parts": [{"text": user_text}]}],
                            "systemInstruction": {"parts": [{"text": PROGRAM_GEN_SYSTEM_PROMPT}]},
                            "generationConfig": {
                                "temperature": 0.2,
                                "maxOutputTokens": 4000,
                                "responseMimeType": "application/json"
                            }
                        }

                        req = urllib.request.Request(
                            f"{GEMINI_URL}?key={GEMINI_API_KEY}",
                            data=json.dumps(payload).encode(),
                            headers={"Content-Type": "application/json"},
                            method="POST"
                        )
                        with urllib.request.urlopen(req, timeout=30) as r:
                            result = json.loads(r.read().decode())

                        candidates = result.get('candidates', [])
                        if not candidates or not candidates[0].get('content', {}).get('parts'):
                            reason = candidates[0].get('finishReason') if candidates else 'no candidates'
                            resp = json.dumps({"ok": False, "error": f"No program returned ({reason})"}).encode()
                        else:
                            raw_text = candidates[0]['content']['parts'][0].get('text', '')
                            try:
                                # responseMimeType=application/json guarantees syntactic JSON,
                                # but we still parse defensively in case of truncation.
                                program = json.loads(raw_text)
                                resp = json.dumps({"ok": True, "program": program}).encode()
                            except json.JSONDecodeError as e:
                                resp = json.dumps({
                                    "ok": False,
                                    "error": f"Model output was not valid JSON: {e}",
                                    "raw": raw_text[:2000]
                                }).encode()

                except urllib.error.HTTPError as e:
                    try:
                        err_body = json.loads(e.read().decode())
                        err_msg = err_body.get('error', {}).get('message', str(e))
                    except Exception:
                        err_msg = str(e)
                    resp = json.dumps({"ok": False, "error": f"Gemini API error: {err_msg}"}).encode()
                except Exception as e:
                    resp = json.dumps({"ok": False, "error": str(e)}).encode()

        # ── AI Program Modification (Gemini, JSON mode, patch ops) ──────
        elif action == 'ai_modify_program':
            if not GEMINI_API_KEY:
                resp = json.dumps({
                    "ok": False,
                    "error": "GEMINI_API_KEY is not set on the relay server. "
                             "Set it as an environment variable and restart relay.py."
                }).encode()
            else:
                try:
                    prompt  = data.get('prompt', '').strip()
                    context = data.get('context', {})

                    if not prompt:
                        resp = json.dumps({"ok": False, "error": "Empty prompt"}).encode()
                    else:
                        user_text = (
                            "Current project context (JSON) — 'steps' has the real ids you must "
                            f"target, 'positions' has real position ids you may reference:\n"
                            f"{json.dumps(context)}\n\n"
                            f"Modification request:\n{prompt}"
                        )

                        payload = {
                            "contents": [{"role": "user", "parts": [{"text": user_text}]}],
                            "systemInstruction": {"parts": [{"text": MODIFY_SYSTEM_PROMPT}]},
                            "generationConfig": {
                                "temperature": 0.2,
                                "maxOutputTokens": 4000,
                                "responseMimeType": "application/json"
                            }
                        }

                        req = urllib.request.Request(
                            f"{GEMINI_URL}?key={GEMINI_API_KEY}",
                            data=json.dumps(payload).encode(),
                            headers={"Content-Type": "application/json"},
                            method="POST"
                        )
                        with urllib.request.urlopen(req, timeout=30) as r:
                            result = json.loads(r.read().decode())

                        candidates = result.get('candidates', [])
                        if not candidates or not candidates[0].get('content', {}).get('parts'):
                            reason = candidates[0].get('finishReason') if candidates else 'no candidates'
                            resp = json.dumps({"ok": False, "error": f"No patch returned ({reason})"}).encode()
                        else:
                            raw_text = candidates[0]['content']['parts'][0].get('text', '')
                            try:
                                patch = json.loads(raw_text)
                                resp = json.dumps({"ok": True, "patch": patch}).encode()
                            except json.JSONDecodeError as e:
                                resp = json.dumps({
                                    "ok": False,
                                    "error": f"Model output was not valid JSON: {e}",
                                    "raw": raw_text[:2000]
                                }).encode()

                except urllib.error.HTTPError as e:
                    try:
                        err_body = json.loads(e.read().decode())
                        err_msg = err_body.get('error', {}).get('message', str(e))
                    except Exception:
                        err_msg = str(e)
                    resp = json.dumps({"ok": False, "error": f"Gemini API error: {err_msg}"}).encode()
                except Exception as e:
                    resp = json.dumps({"ok": False, "error": str(e)}).encode()

        # ── Fetch Live UI Logs ─────────────────────────────────────────
        elif action == 'fetch_logs':
            # Send the current logs
            resp = json.dumps({"ok": True, "logs": ui_logs}).encode()
            ui_logs.clear()

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(resp)

    def log_message(self, *a):
        pass
     
def popup_server():
    """Listens for popup messages from the URScript socket."""
    global popup_msg, popup_resolved
    
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    # Bind to all interfaces on port 50000
    server.bind(('0.0.0.0', 50000))
    server.listen(1)
    print("💬 [Popup] Listening for robot messages on port 50000...")
    
    while True:
        try:
            conn, addr = server.accept()
            data = conn.recv(1024).decode('utf-8')
            if data:
                print(f"📩 [Popup] Received: {data}")
                popup_msg = data
                popup_resolved = False
                
                # Halt this thread until the web UI says "Continue"
                while not popup_resolved:
                    time.sleep(0.1)
                
                # Send the confirmation back to the robot so it can resume
                conn.sendall(b"continue")
                popup_msg = None # Clear the message
                
            conn.close()
        except Exception as e:
            print(f"⚠️ [Popup] Error: {e}")

def log_server():
    """Listens for fire-and-forget log messages from the URScript socket."""
    global ui_logs
    
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(('0.0.0.0', 50001))
    server.listen(5)
    print("📝 [Logger] Listening for robot logs on port 50001...")
    
    while True:
        try:
            conn, addr = server.accept()
            data = conn.recv(1024).decode('utf-8')
            if data:
                print(f"📝 [Log] {data}")
                ui_logs.append(data)
            conn.close()
        except Exception as e:
            pass

if __name__ == '__main__':
    print("╔══════════════════════════════════════╗")
    print("║     UR3e Relay  —  localhost:5678    ║")
    print("╚══════════════════════════════════════╝")
    
    # Start all background threads safely
    threading.Thread(target=state_monitor, daemon=True).start()
    threading.Thread(target=dashboard_monitor, daemon=True).start()
    threading.Thread(target=popup_server, daemon=True).start()
    threading.Thread(target=log_server, daemon=True).start()
    HTTPServer(('', 5678), Handler).serve_forever()