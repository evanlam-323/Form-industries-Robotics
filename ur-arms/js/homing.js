// ═══════════════════════════════════════════════════════════
// HOMING — encoder-checked, staged move to the HOME position
//
// Why staged: a single movej interpolates all six joints at once, so the
// wrist (J3/J4/J5) can sweep the gripper through the forearm on the way.
// Here the arm homes in this order:
//   1. J0-J2 (base/shoulder/elbow) with the wrist FROZEN, so the gripper
//      keeps the same orientation relative to the forearm while the arm
//      unfolds to its upright HOME posture.
//   2. J3, then J4, then J5 one at a time, now that the arm is upright and
//      clear of the tool.
// Before and after every stage the REAL joint encoders are re-read from the
// robot (via the relay), and the move is aborted if anything is off.
// ═══════════════════════════════════════════════════════════
import { positions, isSimulationMode, simJoints, setSimJoints, globalSettings } from './state.js';
import { sendDirect, fetchRobotState, resetFreedriveUI } from './network.js';

// ── Tunables ──────────────────────────────────────────────
const TWO_PI        = 2 * Math.PI;
// UR3e: base..wrist 2 are +/-360 deg; wrist 3 (J5) rotates continuously (no limit),
// so a wound-up reading like -2500 deg is real, not a bad encoder.
const JOINT_LIMITS  = [TWO_PI, TWO_PI, TWO_PI, TWO_PI, TWO_PI, Infinity];
const SKIP_DELTA    = 0.005;      // rad - ignore stages smaller than this
const ARRIVE_TOL    = 0.01;       // rad - "reached target" tolerance
const SETTLED_TOL   = 0.002;      // rad per poll - joints considered stopped
const FROZEN_DRIFT  = 0.05;       // rad - a joint that should be still moved: abort
const POLL_MS       = 120;
const BASE_STAGE    = [0, 1, 2];  // moved together first
const WRIST_ORDER   = [3, 4, 5];  // then one at a time (edit to reorder)
const SPEED_KEY     = 'ur3e_home_speed_pct';
const UNWIND_KEY    = 'ur3e_home_unwind_w3';
const SPEED_DEFAULT = 25;         // % of the Default-Motion joint speed
const V_MIN         = 0.05;       // rad/s floor so 1% is not "stuck"
const J_NAMES       = ['Base', 'Shoulder', 'Elbow', 'Wrist 1', 'Wrist 2', 'Wrist 3'];

let homing = false;

// ── Speed setting (persisted) ─────────────────────────────
export function getHomeSpeedPct() {
  try {
    const v = parseFloat(localStorage.getItem(SPEED_KEY));
    if (v >= 1 && v <= 100) return v;
  } catch (e) { /* storage unavailable */ }
  return SPEED_DEFAULT;
}

export function setHomeSpeedPct(pct) {
  const clean = Math.max(1, Math.min(100, parseFloat(pct) || SPEED_DEFAULT));
  try { localStorage.setItem(SPEED_KEY, String(clean)); } catch (e) { /* ignore */ }
  const lbl = document.getElementById('home-speed-label');
  if (lbl) lbl.textContent = `${Math.round(clean)}%  (${homeMotion(clean).v.toFixed(2)} rad/s)`;
  return clean;
}

// Wrist 3 is continuous. true  = go to HOME's saved J5 exactly (unwinds any extra turns, untwists the cable)
//                        false = go to the nearest equivalent angle (shortest, leaves turns wound)
export function getUnwind() {
  try { return localStorage.getItem(UNWIND_KEY) !== '0'; } catch (e) { return true; }
}
export function setUnwind(on) {
  try { localStorage.setItem(UNWIND_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
}

// Apply the wrist-3 choice to a target, given the current joints.
function resolveTarget(q0, home) {
  const t = home.slice();
  if (!getUnwind()) {
    const turns = Math.round((q0[5] - home[5]) / TWO_PI);
    t[5] = home[5] + turns * TWO_PI;
  }
  return t;
}

function homeMotion(pct) {
  const vMax = globalSettings.js || 1.05;
  const aMax = globalSettings.ja || 1.4;
  const f = pct / 100;
  return { v: Math.max(V_MIN, vMax * f), a: Math.max(0.1, aMax * f) };
}

// ── Helpers ───────────────────────────────────────────────
const deg = r => (r * 180 / Math.PI).toFixed(1) + '°';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const validJoints = q => Array.isArray(q) && q.length >= 6 && q.slice(0, 6).every(Number.isFinite);

function status(msg, level = 'info') {
  const el = document.getElementById('home-status');
  if (el) {
    el.textContent = msg;
    el.style.color = level === 'err' ? 'var(--rd)' : level === 'ok' ? 'var(--gn)' : 'var(--tx2, var(--tx3))';
  }
  (level === 'err' ? console.error : console.log)('[Home]', msg);
}

function aborted() { return window._homingAbort === true; }

async function readEncoders() {
  const res = await fetchRobotState();
  const q = res && res.joints;
  return validJoints(q) ? q.slice(0, 6) : null;
}

function findHomeTarget() {
  const pos = positions.find(p => p.name === 'HOME');
  if (!pos) return { error: 'No position named HOME exists.' };
  const j = pos.j;
  if (!validJoints(j) || j.every(v => v === 0)) return { error: 'HOME has no joint values. Move the arm there and press Set Current.' };
  const bad = j.findIndex((v, i) => Math.abs(v) > JOINT_LIMITS[i]);
  if (bad >= 0) return { error: `HOME ${J_NAMES[bad]} (${deg(j[bad])}) is outside the +/-360° joint range.` };
  return { target: j.slice(0, 6) };
}

// Build the staged plan from the REAL starting joints.
function buildPlan(q0, home) {
  const stages = [];
  const baseMoves = BASE_STAGE.filter(i => Math.abs(home[i] - q0[i]) > SKIP_DELTA);
  if (baseMoves.length) stages.push({ label: 'Base/Shoulder/Elbow', joints: baseMoves });
  for (const i of WRIST_ORDER) {
    if (Math.abs(home[i] - q0[i]) > SKIP_DELTA) stages.push({ label: J_NAMES[i], joints: [i] });
  }
  return stages;
}

// Run one stage; returns the encoder reading at the end, or throws Error.
async function runStage(stage, qStart, home, mot) {
  const target = qStart.slice();
  stage.joints.forEach(i => { target[i] = home[i]; });
  const frozen = [0, 1, 2, 3, 4, 5].filter(i => !stage.joints.includes(i));

  const maxDelta = Math.max(...stage.joints.map(i => Math.abs(target[i] - qStart[i])));
  const estimate = maxDelta / mot.v + mot.v / mot.a;
  const timeoutMs = (estimate * 2 + 4) * 1000;

  const urscript = `def home_stage():\n  movej([${target.map(v => v.toFixed(5)).join(',')}], a=${mot.a.toFixed(3)}, v=${mot.v.toFixed(3)})\nend\n`;
  sendDirect(urscript);

  const t0 = Date.now();
  let prev = null;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(POLL_MS);
    if (aborted()) { sendDirect('def stop_home():\n  stopj(3.0)\nend\n'); throw new Error('Stopped by user.'); }

    const q = await readEncoders();
    if (!q) continue; // transient read failure - keep waiting until timeout

    // Joints that must stay still must stay still.
    for (const i of frozen) {
      if (Math.abs(q[i] - qStart[i]) > FROZEN_DRIFT) {
        sendDirect('def stop_home():\n  stopj(3.0)\nend\n');
        throw new Error(`${J_NAMES[i]} moved ${deg(q[i] - qStart[i])} when it should be holding still. Stopped.`);
      }
    }
    const atTarget = target.every((t, i) => Math.abs(q[i] - t) < ARRIVE_TOL);
    const settled = prev && q.every((v, i) => Math.abs(v - prev[i]) < SETTLED_TOL);
    prev = q;
    if (atTarget && settled) return q;
  }
  sendDirect('def stop_home():\n  stopj(3.0)\nend\n');
  throw new Error(`${stage.label} did not reach its target in time (protective stop or blocked?). Stopped.`);
}

// ── Public API ────────────────────────────────────────────
export async function goHome() {
  if (homing) return;
  window._homingAbort = false;

  const found = findHomeTarget();
  if (found.error) { status(found.error, 'err'); return; }
  let home = found.target;

  const pct = getHomeSpeedPct();
  const mot = homeMotion(pct);

  if (isSimulationMode) { return simHome(resolveTarget(simJoints, home), pct); }

  homing = true;
  setButtons(true);
  try {
    resetFreedriveUI();
    status('Reading joint encoders…');
    let q = await readEncoders();
    if (!q) throw new Error('No encoder data from the robot. Ping it, check the relay, then try again.');
    const badIdx = q.findIndex((v, i) => Math.abs(v) > JOINT_LIMITS[i] + 0.05);
    if (badIdx >= 0) throw new Error(`Encoder reading for ${J_NAMES[badIdx]} (${deg(q[badIdx])}) is outside the joint range. Not moving.`);

    home = resolveTarget(q, home);
    const extra = Math.abs(q[5] - home[5]);
    const stages = buildPlan(q, home);
    if (!stages.length) { status('Already at HOME.', 'ok'); return; }

    status(`Plan: ${stages.map(s => s.label).join(' → ')}  @ ${Math.round(pct)}% speed` + (extra > Math.PI ? ` (wrist 3 unwinds ${(extra / TWO_PI).toFixed(1)} turns)` : ''));
    for (let n = 0; n < stages.length; n++) {
      if (aborted()) throw new Error('Stopped by user.');
      const st = stages[n];
      status(`Stage ${n + 1}/${stages.length}: ${st.label}…`);
      q = await runStage(st, q, home, mot);
    }

    // Final check against the encoders themselves.
    const err = Math.max(...home.map((h, i) => Math.abs(h - q[i])));
    if (err > ARRIVE_TOL * 2) throw new Error(`Finished, but encoders are ${deg(err)} off HOME.`);
    status('At HOME (verified by encoders).', 'ok');
  } catch (e) {
    status(e.message, 'err');
  } finally {
    homing = false;
    setButtons(false);
  }
}

export function stopHome() {
  window._homingAbort = true;
  if (isSimulationMode) { window._simHomeRaf = false; return; }
  if (homing) sendDirect('def stop_home():\n  stopj(3.0)\nend\n');
}

function setButtons(busy) {
  const go = document.getElementById('btn-go-home');
  if (go) { go.disabled = busy; go.textContent = busy ? 'Homing…' : 'Go Home'; }
}

// Simulation: same staging, animated in the viewer; speed slider scales duration.
function simHome(home, pct) {
  const stagesDone = () => { status('At HOME (sim).', 'ok'); };
  const q0 = simJoints.slice();
  const stages = buildPlan(q0, home);
  if (!stages.length) { status('Already at HOME.', 'ok'); return; }
  const mot = homeMotion(pct);
  let cur = q0.slice();
  let n = 0;
  window._simHomeRaf = true;
  const runNext = () => {
    if (!window._simHomeRaf || aborted()) return;
    if (n >= stages.length) { window._simHomeRaf = false; stagesDone(); return; }
    const st = stages[n++];
    const from = cur.slice();
    const to = cur.slice();
    st.joints.forEach(i => { to[i] = home[i]; });
    const dur = (Math.max(...st.joints.map(i => Math.abs(to[i] - from[i]))) / mot.v) * 1000 + 200;
    const t0 = performance.now();
    const tick = now => {
      if (!window._simHomeRaf || aborted()) return;
      const t = Math.min((now - t0) / dur, 1);
      const e = t * t * (3 - 2 * t);
      setSimJoints(from.map((v, i) => v + (to[i] - v) * e));
      if (t < 1) requestAnimationFrame(tick); else { cur = to; runNext(); }
    };
    requestAnimationFrame(tick);
  };
  status(`Sim plan: ${stages.map(s => s.label).join(' → ')}`);
  runNext();
}

export function initHoming() {
  const slider = document.getElementById('home-speed-slider');
  if (slider) {
    slider.value = getHomeSpeedPct();
    setHomeSpeedPct(slider.value);
    slider.addEventListener('input', () => setHomeSpeedPct(slider.value));
  }
  const chk = document.getElementById('home-unwind-chk');
  if (chk) { chk.checked = getUnwind(); chk.addEventListener('change', () => setUnwind(chk.checked)); }
  document.getElementById('btn-go-home')?.addEventListener('click', goHome);
  document.getElementById('btn-stop-home')?.addEventListener('click', stopHome);
}
