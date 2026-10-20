// ═══════════════════════════════════════════════════════════
// TAB-FOLLOWER — UR3e (leader, real or virtual) drives a simulated UR10e
//
// • Live mirror: joint angles map 1:1 (both are 6-joint UR arms, same
//   kinematic layout), so no IK is needed. The sim UR10e tracks the leader
//   with UR10e joint-speed limits, so you can see where a real one would lag.
// • Pick & place: capture HOME / approach / pick / place on the UR3e
//   (freedrive by hand), then preview it on the sim UR10e or run it on the
//   real UR3e.
// • Path record: record a hand-guided path (+ gripper) and replay it on the
//   sim UR10e, or export it as JSON for the real UR10e later.
// The UR10e here is simulation only — nothing is ever sent to a UR10e.
// ═══════════════════════════════════════════════════════════
import * as S from './state.js';
import { RELAY, sendDirect, resetFreedriveUI } from './network.js';
import { toggleFreedrive, setGripper } from './tab-setup.js';

const PI = Math.PI, TWO_PI = 2 * Math.PI;

// ── Robot models (official UR DH parameters) ──────────────
const ROBOTS = {
  ur3e: {
    name: 'UR3e', a: [0, -0.24355, -0.2132, 0, 0, 0], d: [0.15185, 0, 0, 0.13105, 0.08535, 0.0921],
    r: 0.03, color: 0x60a5fa, reach: 0.5,
  },
  ur10e: {
    name: 'UR10e', a: [0, -0.6127, -0.57155, 0, 0, 0], d: [0.1807, 0, 0, 0.17415, 0.11985, 0.11655],
    r: 0.055, color: 0xf97316, reach: 1.3,
    vmax: [2.094, 2.094, 3.142, 3.142, 3.142, 3.142],   // rad/s: 120°/s base+shoulder, 180°/s others
    limit: TWO_PI,                                        // ±360° on every joint
  },
};
const ALPHA = [PI / 2, 0, 0, PI / 2, -PI / 2, 0];
const TOOL_LEN = 0.15;              // flange → fingertip (Robotiq 2F-85 approx)
const HOME_J = [0, -PI / 2, 0, -PI / 2, -PI / 2, 0];
const SLOTS = ['HOME', 'PICK_APPROACH', 'PICK', 'PLACE_APPROACH', 'PLACE'];
const LS_KEY = 'ur3e_follower_pp_v1';
const J_NAMES = ['Base', 'Shoulder', 'Elbow', 'Wrist 1', 'Wrist 2', 'Wrist 3'];

// ── State ─────────────────────────────────────────────────
let T = null;                       // THREE namespace
let scene, camera, renderer, controls, container;
let leaderViz, followerViz, box, trail, trailPts = [], ghost;
let inited = false;

let source = 'live';                // 'live' | 'virtual'
let liveJ = null, liveAt = 0;
let virtualJ = HOME_J.slice();
let leaderG = 0;                    // leader gripper 0=open 1=closed
let mirror = true;
let speedPct = 100;                 // UR10e speed limit % (mirror + playback)
let follower = HOME_J.slice(), followerG = 0, followerTarget = HOME_J.slice(), followerGTarget = 0;
let w3Turns = null;                 // wrist-3 turn offset so UR3e's continuous J5 fits UR10e ±360°
let boxHeld = false;

let pp = loadPP();                  // { HOME: [6], PICK: [6], ... }
let playback = null;                // { kind:'pp'|'path', ... } — sim preview
let recording = null;               // { t0, samples: [] }
let lastRec = null;                 // last finished recording
let realRun = false;

// ── Persistence ───────────────────────────────────────────
function loadPP() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
}
function savePP() { try { localStorage.setItem(LS_KEY, JSON.stringify(pp)); } catch (e) { /* ignore */ } }

// ── Kinematics ────────────────────────────────────────────
// Returns frames in the robot base frame (z up): F[0..6] plus the mid-points M[0..5].
function fk(robot, q) {
  const F = [new T.Matrix4()], M = [];
  let cur = new T.Matrix4();
  for (let i = 0; i < 6; i++) {
    const m = cur.clone()
      .multiply(new T.Matrix4().makeRotationZ(q[i]))
      .multiply(new T.Matrix4().makeTranslation(0, 0, robot.d[i]));
    M.push(m.clone());
    cur = m.multiply(new T.Matrix4().makeTranslation(robot.a[i], 0, 0))
      .multiply(new T.Matrix4().makeRotationX(ALPHA[i]));
    F.push(cur.clone());
  }
  const tool = F[6].clone().multiply(new T.Matrix4().makeTranslation(0, 0, TOOL_LEN));
  return { F, M, tool };
}
const posOf = m => new T.Vector3().setFromMatrixPosition(m);

// ── Arm visual (primitives — no mesh downloads) ───────────
function buildArm(robot, opacity = 1) {
  const group = new T.Group();
  group.rotation.x = -PI / 2;                       // robot z-up → three y-up
  const mat = new T.MeshStandardMaterial({ color: robot.color, metalness: 0.2, roughness: 0.5, transparent: opacity < 1, opacity });
  const jmat = new T.MeshStandardMaterial({ color: 0xd4d4d8, metalness: 0.3, roughness: 0.4, transparent: opacity < 1, opacity });
  const cyl = new T.CylinderGeometry(1, 1, 1, 20);
  const links = [], joints = [];
  for (let i = 0; i < 12; i++) { const m = new T.Mesh(cyl, mat); m.castShadow = true; group.add(m); links.push(m); }
  for (let i = 0; i < 6; i++) { const m = new T.Mesh(cyl, jmat); m.castShadow = true; group.add(m); joints.push(m); }
  const base = new T.Mesh(cyl, jmat);
  base.scale.set(robot.r * 1.6, 0.02, robot.r * 1.6); base.rotation.x = PI / 2; base.position.z = 0.01;
  group.add(base);
  // Gripper: palm + two fingers, built in a tool group placed at the flange each frame
  const tool = new T.Group();
  const gmat = new T.MeshStandardMaterial({ color: 0x3f3f46, transparent: opacity < 1, opacity });
  const palm = new T.Mesh(new T.BoxGeometry(0.09, 0.04, 0.08), gmat); palm.position.z = 0.04; tool.add(palm);
  const fingers = [new T.Mesh(new T.BoxGeometry(0.012, 0.03, 0.07), gmat), new T.Mesh(new T.BoxGeometry(0.012, 0.03, 0.07), gmat)];
  fingers.forEach(f => { f.position.z = 0.115; tool.add(f); });
  group.add(tool);
  return { robot, group, links, joints, tool, fingers };
}

function placeCyl(mesh, a, b, r) {
  const dir = new T.Vector3().subVectors(b, a);
  const len = dir.length();
  mesh.visible = len > 1e-5;
  if (!mesh.visible) return;
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.normalize());
  mesh.scale.set(r, len, r);
}

function poseArm(viz, q, g) {
  const { F, M } = fk(viz.robot, q);
  const pts = [];
  for (let i = 0; i < 6; i++) { pts.push(posOf(F[i]), posOf(M[i])); }
  pts.push(posOf(F[6]));
  for (let i = 0; i < 12; i++) placeCyl(viz.links[i], pts[i], pts[i + 1], viz.robot.r * (i < 6 ? 0.85 : 0.7));
  for (let i = 0; i < 6; i++) {
    const p = posOf(F[i]);
    const z = new T.Vector3(0, 0, 1).applyQuaternion(new T.Quaternion().setFromRotationMatrix(F[i]));
    const h = viz.robot.r * 2.3;
    placeCyl(viz.joints[i], p.clone().addScaledVector(z, -h / 2), p.clone().addScaledVector(z, h / 2), viz.robot.r * 1.12);
  }
  F[6].decompose(viz.tool.position, viz.tool.quaternion, new T.Vector3());
  const half = 0.0425 * (1 - g) + 0.008;           // 85 mm stroke
  viz.fingers[0].position.x = half; viz.fingers[1].position.x = -half;
}

// ── Scene ─────────────────────────────────────────────────
async function waitThree() {
  for (let i = 0; i < 150; i++) {
    if (window.THREE && window.THREE.OrbitControls) return window.THREE;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('three.js did not load');
}

async function initScene() {
  T = await waitThree();
  container = document.getElementById('follower-viewer');
  renderer = new T.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.setClearColor(0x0e0e10, 1);
  container.appendChild(renderer.domElement);

  scene = new T.Scene();
  camera = new T.PerspectiveCamera(40, 1, 0.01, 30);
  camera.position.set(-0.3, 1.7, 3.1);
  controls = new T.OrbitControls(camera, renderer.domElement);
  controls.target.set(-0.25, 0.35, 0.2);
  controls.enableDamping = true;

  scene.add(new T.HemisphereLight(0xffffff, 0x222233, 0.7));
  const sun = new T.DirectionalLight(0xffffff, 0.8);
  sun.position.set(2, 4, 3); sun.castShadow = true; scene.add(sun);
  const grid = new T.GridHelper(5, 50, 0x333340, 0x222228); scene.add(grid);
  const floor = new T.Mesh(new T.PlaneGeometry(5, 5), new T.ShadowMaterial({ opacity: 0.35 }));
  floor.rotation.x = -PI / 2; floor.receiveShadow = true; scene.add(floor);

  leaderViz = buildArm(ROBOTS.ur3e);
  leaderViz.group.position.set(-1.05, 0, 0.7);
  followerViz = buildArm(ROBOTS.ur10e);
  followerViz.group.position.set(0.35, 0, 0);
  ghost = buildArm(ROBOTS.ur10e, 0.18);             // where the follower is being told to go
  ghost.group.position.copy(followerViz.group.position);
  [leaderViz, followerViz, ghost].forEach(v => scene.add(v.group));
  addReachRing(leaderViz, 0x60a5fa); addReachRing(followerViz, 0xf97316);
  addLabel('UR3e (leader)', leaderViz.group.position, '#60a5fa');
  addLabel('UR10e (sim follower)', followerViz.group.position, '#f97316');

  box = new T.Mesh(new T.BoxGeometry(0.06, 0.06, 0.06), new T.MeshStandardMaterial({ color: 0x22c55e }));
  box.castShadow = true; box.visible = false; followerViz.group.add(box);

  trail = new T.Line(new T.BufferGeometry(), new T.LineBasicMaterial({ color: 0xfbbf24 }));
  followerViz.group.add(trail);

  new ResizeObserver(resize).observe(container);
  resize();
  inited = true;
}

function addReachRing(viz, color) {
  const r = viz.robot.reach;
  const ring = new T.Mesh(new T.RingGeometry(r - 0.005, r + 0.005, 96), new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, side: T.DoubleSide }));
  ring.rotation.x = -PI / 2; ring.position.copy(viz.group.position); ring.position.y = 0.002;
  scene.add(ring);
}

function addLabel(text, pos, color) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 64;
  const ctx = c.getContext('2d'); ctx.font = 'bold 34px monospace'; ctx.fillStyle = color; ctx.fillText(text, 8, 44);
  const sp = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), transparent: true }));
  sp.scale.set(0.8, 0.1, 1); sp.position.set(pos.x, 0.02, pos.z + 0.35);
  scene.add(sp);
}

function resize() {
  if (!renderer || !container) return;
  const w = container.clientWidth || 1, h = container.clientHeight || 1;
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}

// ── Leader input ──────────────────────────────────────────
function leaderJoints() {
  if (source === 'virtual') return virtualJ;
  if (S.isSimulationMode) return S.simJoints;
  return (liveJ && Date.now() - liveAt < 1000) ? liveJ : null;
}

async function pollLive() {
  try {
    if (tabActive() && source === 'live' && !S.isSimulationMode) {
      const ip = document.getElementById('robot-ip')?.value.trim();
      if (ip) {
        const r = await fetch(RELAY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, action: 'state' }) });
        const d = await r.json();
        if (d.ok && Array.isArray(d.joints) && d.joints.length >= 6) { liveJ = d.joints.slice(0, 6); liveAt = Date.now(); }
      }
    }
  } catch (e) { /* relay down — shown as "no data" */ }
  setTimeout(pollLive, 100);
}

function leaderGripper() {
  if (source === 'virtual' || S.isSimulationMode) return leaderG;
  const raw = window._gripperRaw;                      // set by the gripper telemetry poller
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, (raw - 3) / 227)) : leaderG;
}

// UR3e wrist 3 is continuous; UR10e is ±360°. Apply a whole-turn offset so they fit.
function mapToFollower(q) {
  const out = q.slice();
  if (w3Turns === null || Math.abs(q[5] - w3Turns * TWO_PI) > ROBOTS.ur10e.limit) w3Turns = Math.round(q[5] / TWO_PI);
  out[5] = q[5] - w3Turns * TWO_PI;
  return out;
}

// ── Main loop ─────────────────────────────────────────────
let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  if (!inited || !tabActive()) return;

  const lq = leaderJoints();
  const lg = leaderGripper();
  if (lq) poseArm(leaderViz, lq, lg);

  // Decide follower target
  if (playback) stepPlayback(dt);
  else if (mirror && lq) { followerTarget = mapToFollower(lq); followerGTarget = lg; }

  // Speed-limited tracking (what a real UR10e could actually do)
  const f = speedPct / 100;
  let lag = 0;
  for (let i = 0; i < 6; i++) {
    const err = followerTarget[i] - follower[i];
    const stepMax = ROBOTS.ur10e.vmax[i] * f * dt;
    follower[i] += Math.max(-stepMax, Math.min(stepMax, err));
    lag = Math.max(lag, Math.abs(followerTarget[i] - follower[i]));
  }
  followerG += Math.max(-2 * dt, Math.min(2 * dt, followerGTarget - followerG));
  poseArm(followerViz, follower, followerG);
  poseArm(ghost, followerTarget, followerGTarget);
  ghost.group.visible = lag > 0.02;

  updateBox();
  updateTrail();
  updateReadout(lq, lag);

  if (recording && lq && now - (recording.lastAt || 0) > 100) {
    recording.lastAt = now;
    recording.samples.push({ t: (now - recording.t0) / 1000, q: lq.slice(), g: lg });
    setText('rec-info', `● Recording… ${((now - recording.t0) / 1000).toFixed(1)} s`, 'var(--rd)');
  }

  controls.update();
  renderer.render(scene, camera);
}

function tabActive() { return document.getElementById('tab-follower')?.classList.contains('on'); }

// ── Box (simulated part) ──────────────────────────────────
function tcpPose(q) { return fk(ROBOTS.ur10e, q).tool; }

function resetBox() {
  if (!box) return;
  if (!pp.PICK) { box.visible = false; boxHeld = false; return; }
  const m = tcpPose(mapToFollower(pp.PICK));
  m.decompose(box.position, box.quaternion, new T.Vector3());
  box.visible = true; boxHeld = false;
}

function updateBox() {
  if (!box.visible) return;
  const tip = tcpPose(follower);
  const tipPos = posOf(tip);
  if (!boxHeld && followerG > 0.6 && tipPos.distanceTo(box.position) < 0.05) boxHeld = true;
  if (boxHeld && followerG < 0.4) boxHeld = false;
  if (boxHeld) tip.decompose(box.position, box.quaternion, new T.Vector3());
}

function updateTrail() {
  trailPts.push(posOf(tcpPose(follower)));
  if (trailPts.length > 600) trailPts.shift();
  trail.geometry.setFromPoints(trailPts);
}

// ── Readout + warnings ────────────────────────────────────
function updateReadout(lq, lag) {
  const d = r => (r * 180 / PI).toFixed(1);
  const rows = J_NAMES.map((n, i) => `<tr><td>${n}</td><td>${lq ? d(lq[i]) : '—'}</td><td>${d(follower[i])}</td></tr>`).join('');
  const lt = lq ? posOf(fk(ROBOTS.ur3e, lq).tool) : null;
  const ft = posOf(tcpPose(follower));
  const xyz = v => v ? `${(v.x).toFixed(3)}, ${(v.y).toFixed(3)}, ${(v.z).toFixed(3)}` : '—';
  const el = document.getElementById('follower-readout');
  if (el) el.innerHTML =
    `<table style="width:100%;border-collapse:collapse;"><tr style="color:var(--tx3)"><td>Joint (°)</td><td>UR3e</td><td>UR10e</td></tr>${rows}</table>` +
    `<div style="margin-top:6px;color:var(--tx3)">TCP (m, base frame)</div>` +
    `<div>UR3e&nbsp; ${xyz(lt)}</div><div>UR10e ${xyz(ft)}</div>`;

  const warns = [];
  if (!lq) warns.push(source === 'live' ? 'No live data from the UR3e — Ping it, or switch to Virtual sliders.' : '');
  if (lag > 0.05) warns.push(`UR10e lagging ${(lag * 180 / PI).toFixed(0)}° behind (speed limit ${speedPct}%).`);
  const { F, tool } = fk(ROBOTS.ur10e, follower);
  const low = [...F.slice(2), tool].some(m => posOf(m).z < 0.0);
  if (low) warns.push('UR10e would go below its base plane (table/floor collision).');
  if (w3Turns) warns.push(`UR3e wrist 3 is ${w3Turns} turn(s) wound; UR10e mirrors it with a ${w3Turns}×360° offset.`);
  const w = document.getElementById('follower-warn');
  if (w) w.innerHTML = warns.filter(Boolean).map(t => `<div>⚠ ${t}</div>`).join('');
}

function setText(id, t, color) {
  const el = document.getElementById(id); if (!el) return;
  el.textContent = t; if (color) el.style.color = color;
}

// ── Pick & place program ──────────────────────────────────
// One program at a time, in one of two modes:
//   'waypoints' — 5 captured poses, played as a fixed pick → place sequence
//   'path'      — a hand-guided recording (joints + gripper), played back as recorded
let progMode = 'waypoints';
const SLOT_LABEL = { HOME: 'Home', PICK_APPROACH: 'Pick approach', PICK: 'Pick', PLACE_APPROACH: 'Place approach', PLACE: 'Place' };

function setMode(m) {
  progMode = m;
  document.querySelectorAll('[data-pmode]').forEach(b => b.classList.toggle('btn-ac', b.dataset.pmode === m));
  const wp = document.getElementById('pp-wp-panel'), rp = document.getElementById('pp-rec-panel');
  if (wp) wp.style.display = m === 'waypoints' ? 'flex' : 'none';
  if (rp) rp.style.display = m === 'path' ? 'flex' : 'none';
  renderProgramInfo();
}

function renderProgramInfo() {
  const n = SLOTS.filter(s => pp[s]).length;
  const dur = lastRec && lastRec.length ? lastRec[lastRec.length - 1].t : 0;
  setText('rec-info', recording ? '' : (lastRec && lastRec.length ? `Recorded: ${dur.toFixed(1)} s, ${lastRec.length} samples` : 'Nothing recorded yet.'), 'var(--tx3)');
  setText('pp-ready', progMode === 'waypoints' ? `${n}/5 poses captured` : (dur ? `Path ready (${dur.toFixed(1)} s)` : 'Record a path first'));
}

function capture(slot) {
  const q = leaderJoints();
  if (!q) { setText('pp-status', 'No UR3e joints to capture.', 'var(--rd)'); return; }
  pp[slot] = q.slice(); savePP(); renderSlots();
  if (slot === 'PICK') resetBox();
  setText('pp-status', `Captured ${SLOT_LABEL[slot]}.`, 'var(--gn)');
}

function renderSlots() {
  const el = document.getElementById('pp-slots'); if (!el) return;
  el.innerHTML = SLOTS.map((s, i) => `
    <div style="display:flex;align-items:center;gap:6px;">
      <span style="width:8px;height:8px;border-radius:50%;background:${pp[s] ? 'var(--gn)' : 'var(--tx3)'}"></span>
      <span style="flex:1;font-size:12px;">${i + 1}. ${SLOT_LABEL[s]}</span>
      <button class="btn btn-sm" data-cap="${s}">${pp[s] ? 'Re-capture' : 'Capture'}</button>
    </div>`).join('');
  el.querySelectorAll('button[data-cap]').forEach(b => b.addEventListener('click', () => capture(b.dataset.cap)));
  renderProgramInfo();
}

function ppSequence() {
  const miss = SLOTS.filter(s => !pp[s]);
  if (miss.length) return { error: `Capture first: ${miss.map(s => SLOT_LABEL[s]).join(', ')}` };
  const { HOME, PICK_APPROACH, PICK, PLACE_APPROACH, PLACE } = pp;
  return { seq: [
    { q: HOME }, { grip: 0 }, { q: PICK_APPROACH }, { q: PICK }, { grip: 1 }, { q: PICK_APPROACH },
    { q: PLACE_APPROACH }, { q: PLACE }, { grip: 0 }, { q: PLACE_APPROACH }, { q: HOME },
  ] };
}

// Real UR3e always replays at 100% (recorded timing), so the playback matches the recording.
function realSpeed() { return 1; }

// ── Recording ─────────────────────────────────────────────
function toggleRecord() {
  const btn = document.getElementById('btn-rec');
  if (!recording) {
    if (!leaderJoints()) { setText('pp-status', 'No UR3e joints to record — Ping the robot (or use Virtual sliders).', 'var(--rd)'); return; }
    if (playback) stopAll();
    recording = { t0: performance.now(), samples: [] };
    btn.textContent = '■ Stop recording'; btn.classList.add('btn-ac');
    setText('pp-status', 'Recording — move the arm and use the gripper, then press Stop.', 'var(--ac)');
  } else {
    lastRec = recording.samples; recording = null;
    btn.textContent = '● Record'; btn.classList.remove('btn-ac');
    if (lastRec.length < 2) { lastRec = null; setText('pp-status', 'Recording too short.', 'var(--rd)'); }
    else setText('pp-status', 'Recording done. Preview it, run it, or save it.', 'var(--gn)');
    renderProgramInfo();
  }
}

// ── Preview on the sim UR10e ──────────────────────────────
function preview() {
  if (recording) toggleRecord();
  if (progMode === 'waypoints') {
    const r = ppSequence();
    if (r.error) { setText('pp-status', r.error, 'var(--rd)'); return; }
    resetBox(); followerGTarget = 0;
    playback = { kind: 'pp', seq: r.seq, i: 0, wait: 0 };
  } else {
    if (!lastRec || lastRec.length < 2) { setText('pp-status', 'Record a path first.', 'var(--rd)'); return; }
    // Map every sample to UR10e joints once (wrist-3 turn offset applied in order)
    const qs = lastRec.map(x => mapToFollower(x.q));
    playback = { kind: 'path', samples: lastRec, qs, phase: 'approach', t: lastRec[0].t, k: 0, hold: 0 };
  }
  setText('pp-status', 'Previewing on the sim UR10e…', 'var(--tx2)');
}

function stepPlayback(dt) {
  const pb = playback;
  if (pb.kind === 'pp') {
    if (pb.wait > 0) { pb.wait -= dt; return; }
    const st = pb.seq[pb.i];
    if (!st) { playback = null; setText('pp-status', 'Preview done.', 'var(--gn)'); return; }
    if (st.grip !== undefined) { followerGTarget = st.grip; pb.wait = 0.6; pb.i++; return; }
    followerTarget = mapToFollower(st.q);
    if (follower.every((v, i) => Math.abs(v - followerTarget[i]) < 0.003)) { pb.i++; pb.wait = 0.15; }
  } else {
    const s = pb.samples, qs = pb.qs, last = s.length - 1;
    const lagNow = () => Math.max(...follower.map((v, i) => Math.abs(v - followerTarget[i])));
    if (pb.phase === 'approach') {
      // 1. Drive to the first recorded pose before the clock starts
      followerTarget = qs[0].slice(); followerGTarget = s[0].g || 0;
      setText('pp-status', 'Preview: moving the UR10e to the start pose…', 'var(--tx2)');
      if (lagNow() < 0.005) { pb.phase = 'play'; pb.t = s[0].t; pb.k = 0; }
      return;
    }
    if (pb.phase === 'play') {
      // 2. Play the recording. If the UR10e can't keep up (speed limit), slow the
      //    clock so the whole path is still traced instead of being skipped.
      const lag = lagNow();
      pb.t += dt * (lag < 0.08 ? 1 : lag < 0.25 ? 0.35 : 0);
      while (pb.k < last && s[pb.k + 1].t <= pb.t) pb.k++;
      const a = s[pb.k], b = s[Math.min(pb.k + 1, last)];
      const u = b.t > a.t ? Math.min(1, Math.max(0, (pb.t - a.t) / (b.t - a.t))) : 1;
      followerTarget = qs[pb.k].map((v, i) => v + (qs[Math.min(pb.k + 1, last)][i] - v) * u);
      followerGTarget = (u < 0.5 ? a.g : b.g) || 0;
      const total = s[last].t - s[0].t;
      setText('pp-status', `Preview: ${(pb.t - s[0].t).toFixed(1)} / ${total.toFixed(1)} s`, 'var(--tx2)');
      if (pb.k >= last) pb.phase = 'settle';
      return;
    }
    if (pb.phase === 'settle') {
      // 3. Let the UR10e reach the final pose, then hold it briefly before mirroring resumes
      followerTarget = qs[last].slice(); followerGTarget = s[last].g || 0;
      if (lagNow() < 0.005) { pb.phase = 'hold'; pb.hold = 1.5; setText('pp-status', 'Preview done.', 'var(--gn)'); }
      return;
    }
    pb.hold -= dt;
    if (pb.hold <= 0) playback = null;
  }
}

function stopAll() {
  playback = null;
  followerTarget = follower.slice();
  if (realRun) { sendDirect('def stop_pp():\n  stopj(3.0)\nend\n'); realRun = false; }
  setText('pp-status', 'Stopped.', 'var(--tx2)');
}

// ── Run on the real UR3e ──────────────────────────────────
const rqSend = c => `  socket_send_string("${c}", "rq")\n  socket_send_byte(10, "rq")\n`;
const rqOpen = () => '  socket_close("rq")\n  socket_open("127.0.0.1", 63352, "rq")\n' + rqSend('SET GTO 1') + rqSend('SET SPE 200') + rqSend('SET FOR 100');
const qStr = q => `[${q.slice(0, 6).map(x => x.toFixed(5)).join(',')}]`;

function runOnUR3e() {
  if (recording) toggleRecord();
  if (S.isSimulationMode) { setText('pp-status', 'SIM is ON — use Preview, or turn SIM off in the Run tab.', 'var(--rd)'); return; }
  const f = realSpeed();
  let code;
  if (progMode === 'waypoints') {
    const r = ppSequence();
    if (r.error) { setText('pp-status', r.error, 'var(--rd)'); return; }
    if (!confirm(`Run the pick & place on the REAL UR3e?\nKeep a hand on the e-stop.`)) return;
    const v = (S.globalSettings.js || 1.05) * f, a = Math.max(0.1, (S.globalSettings.ja || 1.4) * f);
    code = 'def pick_place():\n' + rqOpen();
    for (const st of r.seq) {
      if (st.grip !== undefined) code += rqSend(`SET POS ${st.grip ? 255 : 0}`) + '  sleep(1.0)\n';
      else code += `  movej(${qStr(st.q)}, a=${a.toFixed(3)}, v=${v.toFixed(3)})\n`;
    }
  } else {
    if (!lastRec || lastRec.length < 2) { setText('pp-status', 'Record a path first.', 'var(--rd)'); return; }
    const dur = (lastRec[lastRec.length - 1].t - lastRec[0].t) / f;
    if (!confirm(`Replay the recorded path on the REAL UR3e (~${dur.toFixed(0)} s, recorded speed)?\nIt first moves slowly to the start pose. Keep a hand on the e-stop.`)) return;
    code = 'def replay_path():\n' + rqOpen() + pathScript(lastRec, f);
    code += '  stopj(2.0)\n';
  }
  code += '  socket_close("rq")\nend\n';
  if (S.isFreedrive) resetFreedriveUI();   // the new program ends Freedrive on the robot
  sendDirect(code);
  realRun = true;
  setText('pp-status', 'Running on the UR3e — the sim UR10e mirrors it.', 'var(--ac)');
}

// Recorded path → URScript. Samples are ~10 Hz and can have gaps or idle stretches,
// so: idle stretches become sleep(), each move is split into ≤0.1 s servoj steps,
// and any step that would exceed the UR3e joint-speed limits is stretched in time.
const UR3E_VMAX = [3.14, 3.14, 3.14, 6.28, 6.28, 6.28].map(v => v * 0.6);   // rad/s, 60% margin
function pathScript(rec, f) {
  const startV = ((S.globalSettings.js || 1.05) * Math.min(f, 0.25)).toFixed(3);
  let lastPos = Math.round((rec[0].g || 0) * 255);
  let code = rqSend(`SET POS ${lastPos}`) + '  sleep(0.8)\n' +
    `  movej(${qStr(rec[0].q)}, a=0.8, v=${startV})\n`;
  let prev = rec[0].q.slice(0, 6), idle = 0;
  for (let i = 1; i < rec.length; i++) {
    const smp = rec[i], q = smp.q.slice(0, 6);
    const dt = Math.max(0, (smp.t - rec[i - 1].t) / f);
    const d = q.map((v, j) => v - prev[j]);
    const big = Math.max(...d.map(Math.abs));
    if (big < 0.0005) idle += dt;                       // arm not moving
    else {
      if (idle > 0.02) code += `  sleep(${idle.toFixed(3)})\n`;
      idle = 0;
      const need = Math.max(...d.map((v, j) => Math.abs(v) / UR3E_VMAX[j]));   // fastest allowed time
      const T = Math.max(dt, need, 0.008);
      const n = Math.max(1, Math.ceil(T / 0.1));
      for (let k = 1; k <= n; k++) {
        const qk = prev.map((v, j) => v + d[j] * k / n);
        code += `  servoj(${qStr(qk)}, t=${(T / n).toFixed(3)}, lookahead_time=0.1, gain=300)\n`;
      }
      prev = q;
    }
    const pos = Math.round((smp.g || 0) * 255);
    if (Math.abs(pos - lastPos) > 20) {
      if (idle > 0.02) { code += `  sleep(${idle.toFixed(3)})\n`; idle = 0; }
      code += rqSend(`SET POS ${pos}`); lastPos = pos;
    }
  }
  if (idle > 0.02) code += `  sleep(${Math.min(idle, 2).toFixed(3)})\n`;
  return code;
}

// ── Saved programs (browser) + file export/import ─────────
const LIB_KEY = 'ur3e_follower_library_v1';
function loadLib() { try { return JSON.parse(localStorage.getItem(LIB_KEY)) || []; } catch (e) { return []; } }
function saveLib(lib) {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); return true; }
  catch (e) { setText('pp-status', 'Could not save in the browser — use Export file instead.', 'var(--rd)'); return false; }
}
const itemType = it => it.type || (it.path && it.path.length ? 'path' : 'waypoints');

function renderLibrary(selectId) {
  const sel = document.getElementById('lib-select'); if (!sel) return;
  const lib = loadLib();
  sel.innerHTML = lib.length
    ? '<option value="">Saved programs…</option>' + lib.map(it => `<option value="${it.id}">${it.name.replace(/</g, '&lt;')} — ${itemType(it) === 'path' ? 'recorded path' : 'waypoints'}</option>`).join('')
    : '<option value="">No saved programs yet</option>';
  sel.value = selectId || '';
}

function currentProgram(name) {
  return progMode === 'waypoints'
    ? (Object.keys(pp).length ? { type: 'waypoints', name, pp: JSON.parse(JSON.stringify(pp)) } : null)
    : (lastRec && lastRec.length ? { type: 'path', name, path: lastRec } : null);
}

function saveProgram() {
  const nameEl = document.getElementById('lib-name');
  const name = (nameEl?.value || '').trim();
  if (!name) { setText('pp-status', 'Type a name, then Save.', 'var(--rd)'); nameEl?.focus(); return; }
  const prog = currentProgram(name);
  if (!prog) { setText('pp-status', progMode === 'waypoints' ? 'Capture some poses first.' : 'Record a path first.', 'var(--rd)'); return; }
  const lib = loadLib();
  const existing = lib.find(it => it.name === name);
  if (existing && !confirm(`Overwrite saved program "${name}"?`)) return;
  const item = { id: existing?.id || ('p' + Date.now()), savedAt: new Date().toISOString(), ...prog };
  const out = existing ? lib.map(it => it.id === existing.id ? item : it) : [...lib, item];
  if (saveLib(out)) { renderLibrary(item.id); setText('pp-status', `Saved "${name}".`, 'var(--gn)'); }
}

function applyProgram(it) {
  if (itemType(it) === 'path') { lastRec = it.path; setMode('path'); }
  else { pp = JSON.parse(JSON.stringify(it.pp || {})); savePP(); renderSlots(); resetBox(); setMode('waypoints'); }
  const nameEl = document.getElementById('lib-name'); if (nameEl) nameEl.value = it.name || '';
}

function onLibSelect() {
  const id = document.getElementById('lib-select')?.value; if (!id) return;
  const it = loadLib().find(x => x.id === id); if (!it) return;
  applyProgram(it);
  setText('pp-status', `Loaded "${it.name}". Preview it or run it on the UR3e.`, 'var(--gn)');
}

function deleteProgram() {
  const id = document.getElementById('lib-select')?.value;
  const lib = loadLib(); const it = lib.find(x => x.id === id);
  if (!it) { setText('pp-status', 'Choose a saved program to delete.', 'var(--rd)'); return; }
  if (!confirm(`Delete saved program "${it.name}"?`)) return;
  saveLib(lib.filter(x => x.id !== id)); renderLibrary(); setText('pp-status', `Deleted "${it.name}".`, 'var(--tx2)');
}

function exportFile() {
  const name = (document.getElementById('lib-name')?.value || '').trim() || 'ur3e_program';
  const prog = currentProgram(name);
  if (!prog) { setText('pp-status', 'Nothing to export yet.', 'var(--rd)'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ ...prog, exported: new Date().toISOString(), units: 'rad' }, null, 2)], { type: 'application/json' }));
  a.download = name.replace(/[^a-z0-9_-]+/gi, '_') + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importFile(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const d = JSON.parse(rd.result);
      const valid = q => Array.isArray(q) && q.length >= 6 && q.slice(0, 6).every(Number.isFinite);
      const ppIn = d.pp || d.pick_place;   // pick_place = older export format
      const it = {
        name: d.name || file.name.replace(/\.json$/i, ''),
        type: d.type,
        pp: ppIn && typeof ppIn === 'object' ? Object.fromEntries(Object.entries(ppIn).filter(([k, q]) => SLOTS.includes(k) && valid(q))) : null,
        path: Array.isArray(d.path) ? d.path.filter(x => x && valid(x.q) && Number.isFinite(x.t)) : null,
      };
      if (!it.type) it.type = it.path && it.path.length > 1 ? 'path' : 'waypoints';
      if (it.type === 'path' ? !(it.path && it.path.length > 1) : !(it.pp && Object.keys(it.pp).length)) throw new Error('no poses or path found');
      applyProgram(it);
      setText('pp-status', `Imported ${file.name}. Press Save to keep it in the list.`, 'var(--gn)');
    } catch (e) { setText('pp-status', `Import failed: ${e.message}`, 'var(--rd)'); }
  };
  rd.readAsText(file);
}

// ── Virtual leader sliders ────────────────────────────────
function renderSliders() {
  const el = document.getElementById('virtual-sliders'); if (!el) return;
  el.innerHTML = J_NAMES.map((n, i) => `
    <div style="display:flex;align-items:center;gap:6px;font-size:10px;">
      <span style="width:52px;color:var(--tx3)">${n}</span>
      <input type="range" min="-360" max="360" step="0.5" value="${(virtualJ[i] * 180 / PI).toFixed(1)}" data-vj="${i}" style="flex:1">
      <span id="vj-lbl-${i}" style="width:42px;text-align:right;font-family:var(--mono)">${(virtualJ[i] * 180 / PI).toFixed(0)}°</span>
    </div>`).join('') +
    `<div style="display:flex;gap:6px;margin-top:4px;">
       <button class="btn btn-sm" id="vj-home">To HOME pose</button>
       <button class="btn btn-sm" id="vj-grip">Toggle gripper</button>
     </div>`;
  el.querySelectorAll('input[data-vj]').forEach(s => s.addEventListener('input', () => {
    const i = +s.dataset.vj; virtualJ[i] = +s.value * PI / 180; setText(`vj-lbl-${i}`, `${(+s.value).toFixed(0)}°`);
  }));
  document.getElementById('vj-home').addEventListener('click', () => { virtualJ = HOME_J.slice(); renderSliders(); });
  document.getElementById('vj-grip').addEventListener('click', () => { leaderG = leaderG > 0.5 ? 0 : 1; });
}

// ── Init ──────────────────────────────────────────────────
export function initFollowerTab() {
  const $ = id => document.getElementById(id);
  renderSlots(); renderSliders();

  $('fl-source')?.addEventListener('change', e => {
    source = e.target.value;
    $('virtual-sliders').style.display = source === 'virtual' ? 'flex' : 'none';
  });
  $('fl-mirror')?.addEventListener('change', e => { mirror = e.target.checked; });
  $('fl-speed')?.addEventListener('input', e => { speedPct = +e.target.value; setText('fl-speed-lbl', `${speedPct}%`); });
  $('btn-fl-freedrive')?.addEventListener('click', () => toggleFreedrive());
  const gripTo = pos => {
    leaderG = pos / 255;
    if (source === 'virtual' || S.isSimulationMode) return;
    setGripper(pos);
  };
  $('btn-fl-open')?.addEventListener('click', () => gripTo(0));
  $('btn-fl-close')?.addEventListener('click', () => gripTo(255));
  $('btn-box-reset')?.addEventListener('click', () => { resetBox(); trailPts = []; });

  // Pick & place program
  document.querySelectorAll('[data-pmode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.pmode)));
  $('btn-pp-clear')?.addEventListener('click', () => { pp = {}; savePP(); renderSlots(); resetBox(); });
  $('btn-rec')?.addEventListener('click', toggleRecord);
  $('btn-pp-sim')?.addEventListener('click', preview);
  $('btn-pp-real')?.addEventListener('click', runOnUR3e);
  $('btn-pp-stop')?.addEventListener('click', stopAll);
  $('btn-lib-save')?.addEventListener('click', saveProgram);
  $('lib-select')?.addEventListener('change', onLibSelect);
  $('btn-lib-del')?.addEventListener('click', deleteProgram);
  $('btn-export')?.addEventListener('click', exportFile);
  $('lib-import')?.addEventListener('change', e => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; });
  renderLibrary();
  setMode('waypoints');

  // Keep the Freedrive button label in sync with the shared state
  setInterval(() => {
    const b = $('btn-fl-freedrive'); if (!b) return;
    b.textContent = S.isFreedrive ? 'Freedrive: ON (move UR3e by hand)' : 'Freedrive: OFF';
    b.classList.toggle('btn-ac', S.isFreedrive);
  }, 250);

  // Build the 3D scene the first time the tab is opened (needs a real size)
  document.querySelector('.tab[data-target="tab-follower"]')?.addEventListener('click', async () => {
    if (!inited) {
      try { await initScene(); resetBox(); } catch (e) { setText('follower-warn', 'Could not load the 3D view: ' + e.message, 'var(--rd)'); }
    } else { setTimeout(resize, 0); }
  });

  pollLive();
  requestAnimationFrame(frame);
}
