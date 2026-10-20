// ═══════════════════════════════════════════════════════════
// JOG — Cartesian jogging (speedl) with singularity + joint-speed guard
// ═══════════════════════════════════════════════════════════
import { isJogging, setIsJogging, isSimulationMode, globalSettings } from './state.js';
import { sendDirect, resetFreedriveUI, fetchRobotState } from './network.js';
import { previewJog, cartesianStep, tcpPose, jogReadyTarget, jogJointSpeeds } from './kinematics.js';

export const JOG_BUILD = '2026-10-19d';
console.info(`[Jog] jog.js build ${JOG_BUILD} loaded`);

// speedl() makes the controller solve IK every cycle and keeps the TCP at a
// constant speed. Two consequences:
//  1. At / near a singular pose (e.g. straight-up HOME) the controller faults
//     with "no inverse kinematic solution".
//  2. Approaching full stretch, the joints must spin faster and faster to
//     keep the TCP speed constant — the arm visibly speeds up.
// We check before moving and run a watchdog while the button is held that
// stops the jog before either happens.
const LIN_SPEED = 0.05;                        // m/s
const ROT_SPEED = 0.25;                        // rad/s
const MAX_JOINT_SPEED = 30 * Math.PI / 180;    // rad/s — stop before any joint needs more than this
const JOINT_NAMES = ['Base', 'Shoulder', 'Elbow', 'Wrist 1', 'Wrist 2', 'Wrist 3'];

function jogTool() {
  return [globalSettings.tcpX || 0, globalSettings.tcpY || 0, globalSettings.tcpZ || 0];
}

// Jog messages go ONLY to #jog-status, which sits *below* the jog buttons.
// Writing to anything above the buttons changes the layout height, moves the
// button out from under the cursor, fires mouseleave and stops the jog.
function colorOf(level) {
  return level === 'err' ? 'var(--rd)' : level === 'ok' ? 'var(--gn)' : 'var(--yl,#f59e0b)';
}

function showJogStatus(msg, level = 'warn') {
  if (msg) console.warn('[Jog]', msg);
  const el = document.getElementById('jog-status');
  if (el) {
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
    el.style.color = colorOf(level);
  }
  const readyBtn = document.getElementById('btn-jog-ready');
  if (readyBtn && msg && level !== 'ok') readyBtn.classList.add('btn-ac');
  if (readyBtn && !msg) readyBtn.classList.remove('btn-ac');
}

// Jog-Ready messages go to #home-status (next to the button). Never cleared
// automatically while a jog button is held, for the same layout reason.
function showReadyStatus(msg, level = 'ok') {
  if (msg) console.warn('[Jog-ready]', msg);
  if (!msg && isJogging) return;
  const hs = document.getElementById('home-status');
  if (hs) { hs.textContent = msg || ''; hs.style.color = colorOf(level); }
  if (msg && level !== 'ok') showJogStatus('');
}

function axisName(axis, dir) {
  return ['X','Y','Z','Rx','Ry','Rz'][axis] + (dir > 0 ? '+' : '−');
}

function blockedMsg(axis, dir, reason) {
  return `${axisName(axis, dir)} blocked: ${reason}. Press "Jog-Ready Pose" (or use Joint jog) to move the arm somewhere with more room, then jog again.`;
}

// Combined look-ahead check: singularity/reach AND joint-speed limit.
function checkAhead(q, axis, dir, tool) {
  const speed = axis < 3 ? LIN_SPEED : ROT_SPEED;
  const r = jogJointSpeeds(q, axis, dir, tool, speed);
  if (r.maxW > MAX_JOINT_SPEED) {
    const deg = Math.round(r.maxW * 180 / Math.PI);
    return { ok: false, reason: `${JOINT_NAMES[r.joint]} would have to speed up to ${deg}°/s (limit ${Math.round(MAX_JOINT_SPEED * 180 / Math.PI)}°/s) — the arm is near full stretch or a singularity` };
  }
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true };
}

// Every press gets a new generation number. Anything async from an older
// press (a pending state read, a watchdog tick) sees a stale number and quits,
// so a quick release → re-press can never leave two jogs running or send a
// speedl for a button that is no longer held.
let jogGen = 0;
let jogWatchdogTimer = null;

export async function startJog(axis, direction) {
  const gen = ++jogGen;
  clearTimeout(jogWatchdogTimer);
  setIsJogging(true);
  resetFreedriveUI();
  const tool = jogTool();
  const live = () => gen === jogGen && isJogging;

  if (isSimulationMode) {
    // ── SIM MODE: real IK, time-based so speed doesn't depend on frame rate ──
    showJogStatus('');
    let last = performance.now();
    const loop = async (now) => {
      if (!live()) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const s = await import('./state.js');
      if (!live()) return;
      const q = s.simJoints;
      const pre = checkAhead(q, axis, direction, tool);
      if (!pre.ok) { setIsJogging(false); showJogStatus(blockedMsg(axis, direction, pre.reason)); return; }
      const nq = cartesianStep(q, axis, direction, (axis < 3 ? LIN_SPEED : ROT_SPEED) * dt, tool);
      if (nq) { s.setSimJoints(nq); s.setSimTcp(tcpPose(nq, tool)); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return;
  }

  // ── REAL MODE ──
  // 1. Fresh joints + look-ahead check before moving.
  const st = await fetchRobotState();
  if (!live()) return;                    // released (or re-pressed) while we waited
  const q = st && st.joints;
  if (!q || q.length < 6) {
    setIsJogging(false);
    showJogStatus('Cartesian jog refused: no live joint data from the relay (check relay.py is running and the robot IP). Joint jog still works.', 'err');
    return;
  }
  const pre = checkAhead(q, axis, direction, tool);
  if (!pre.ok) {
    setIsJogging(false);
    showJogStatus(blockedMsg(axis, direction, pre.reason));
    return;
  }
  showJogStatus('');

  // 2. Start the speedl loop.
  const vector = [0, 0, 0, 0, 0, 0];
  vector[axis] = direction * (axis < 3 ? LIN_SPEED : ROT_SPEED);
  sendDirect(`def jog():\n  while True:\n    speedl([${vector.join(',')}], a=0.3, t=0.1)\n  end\nend\n`);

  // 3. Watchdog: every 100 ms look ~2 cm / ~8° ahead; stop before a joint
  //    has to speed up past the limit or the controller would fault.
  const watch = async () => {
    if (!live()) return;
    const s2 = await fetchRobotState();
    if (!live()) return;
    const qn = s2 && s2.joints;
    if (!qn || qn.length < 6) {
      stopJog();
      showJogStatus(`Stopped ${axisName(axis, direction)}: lost live joint data from the relay.`, 'err');
      return;
    }
    const ahead = checkAhead(qn, axis, direction, tool);
    if (!ahead.ok) {
      stopJog();
      showJogStatus(`Stopped ${axisName(axis, direction)}: ${ahead.reason}.`);
      return;
    }
    jogWatchdogTimer = setTimeout(watch, 100);
  };
  jogWatchdogTimer = setTimeout(watch, 100);
}

export function stopJog() {
  jogGen++;                               // cancel anything pending from the last press
  clearTimeout(jogWatchdogTimer);
  if (!isJogging) return;
  setIsJogging(false);
  if (!isSimulationMode) sendDirect("def stop_jog():\n  stopl(2.5)\nend\n");
}

// ── Jog-Ready pose ───────────────────────────────────────────────────
// Bent, well-conditioned posture (tool down, ~0.2 m in front of the base).
// Confirmation is an in-page "press again" step, not window.confirm():
// browsers can silently suppress confirm() dialogs, which made the button
// look dead.
let readyArmed = null;   // { target, until }

function setReadyLabel(text) {
  const b = document.getElementById('btn-jog-ready');
  if (b) b.textContent = text;
}

export async function moveToJogReady() {
  try { await _moveToJogReady(); }
  catch (e) { console.error('[Jog-ready]', e); disarmReady(); showReadyStatus('Jog-Ready failed: ' + e.message, 'err'); }
}

function disarmReady() {
  readyArmed = null;
  setReadyLabel('Jog-Ready Pose');
}

async function _moveToJogReady() {
  const tool = jogTool();

  if (isSimulationMode) {
    const s = await import('./state.js');
    const start = s.simJoints.slice();
    const target = jogReadyTarget(start);
    const t0 = performance.now(), dur = 1500;
    showReadyStatus('Moving to jog-ready pose…', 'ok');
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const q = start.map((v, i) => v + (target[i] - v) * e);
      s.setSimJoints(q);
      s.setSimTcp(tcpPose(q, tool));
      if (k < 1) requestAnimationFrame(step); else showReadyStatus('At jog-ready pose — Cartesian jog has room in every direction.', 'ok');
    };
    requestAnimationFrame(step);
    return;
  }

  // Second press within 5 s → go.
  if (readyArmed && Date.now() < readyArmed.until) {
    const { target, q } = readyArmed;
    disarmReady();
    sendDirect(`def jog_ready():\n  movej([${target.map(v => v.toFixed(5)).join(',')}], a=0.8, v=0.5)\nend\n`);
    showReadyStatus('Moving to jog-ready pose…', 'ok');
    verifyReached(q, target);
    return;
  }

  // First press → read joints, show what will happen, ask for a second press.
  setReadyLabel('Reading joints…');
  showReadyStatus('Reading robot joints…', 'ok');
  const st = await fetchRobotState();
  const q = st && st.joints;
  if (!q || q.length < 6) {
    disarmReady();
    setReadyLabel('✕ No robot data');
    setTimeout(() => { if (!readyArmed) setReadyLabel('Jog-Ready Pose'); }, 3000);
    showReadyStatus('Jog-Ready: could not read the robot joints from the relay — check relay.py is running and the robot IP is set.', 'err');
    return;
  }
  const target = jogReadyTarget(q);
  const deg = v => (v * 180 / Math.PI).toFixed(0) + '°';
  readyArmed = { target, q, until: Date.now() + 5000 };
  setReadyLabel('Press again to move');
  showReadyStatus(`Press again within 5 s to move: Shoulder ${deg(target[1])}, Elbow ${deg(target[2])}, Wrist1 ${deg(target[3])}, Wrist2 ${deg(target[4])}. The arm folds forward/down — keep the area clear.`, 'warn');
  setTimeout(() => {
    if (readyArmed && Date.now() >= readyArmed.until) { disarmReady(); showReadyStatus(''); }
  }, 5100);
}

// Confirm the arm actually moved. If the controller is still faulted from an
// earlier IK error / protective stop, the script is silently ignored.
function verifyReached(q, target) {
  const startErr = Math.max(...q.map((v, i) => Math.abs(v - target[i])));
  const t0 = Date.now();
  const check = async () => {
    const s2 = await fetchRobotState();
    const qn = s2 && s2.joints;
    if (qn && qn.length >= 6) {
      const err = Math.max(...qn.map((v, i) => Math.abs(v - target[i])));
      if (err < 0.01) { showReadyStatus('At jog-ready pose — Cartesian jog has room in every direction.', 'ok'); setTimeout(() => showReadyStatus(''), 5000); return; }
      if (Date.now() - t0 > 2500 && err > startErr - 0.02) {
        showReadyStatus('The robot did not move. It is probably still faulted from an earlier error: clear the popup on the pendant (or press Resolve), make sure it is not in a protective stop, then press Jog-Ready again.', 'err');
        return;
      }
    }
    if (Date.now() - t0 < 20000) setTimeout(check, 300);
    else showReadyStatus('Timed out waiting for the arm to reach the jog-ready pose.', 'err');
  };
  setTimeout(check, 300);
}
