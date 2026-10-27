// ═══════════════════════════════════════════════════════════
// ROBOT INIT — remote "Initialize Robot" (power on + brake release)
// and a movement lock until the arm reports RUNNING.
// ═══════════════════════════════════════════════════════════
import { RELAY } from './network.js';

console.log('[Init] robot-init.js build 2026-10-27b');

// Every control that can move the arm or the gripper. E-STOP / Stop are never locked.
const LOCKED_SELECTORS = [
  '#btn-freedrive', '#btn-go-home', '#btn-jog-ready', '#btn-apply-joints',
  '.jog-btn', '.joint-jog-btn',
  '#btn-gripper-activate', '#btn-open-gripper', '#btn-close-gripper',
  '#btn-fl-freedrive', '#btn-fl-open', '#btn-fl-close', '#btn-pp-real',
  '[onmousedown*="startMoveHere"]',   // Saved Positions → Move Here (re-rendered, so matched by handler)
];
const LOCKED_KEYS = ['f', 'g'];   // Freedrive / gripper shortcuts in main.js

export let robotReady = false;
window.robotReady = false;

let lastMode = '';
let initBusy = false;
let armTimer = null;   // two-press confirm timer

const $ = id => document.getElementById(id);
const ip = () => ($('robot-ip')?.value || '').trim();

function parseMode(raw) {
  // "Robotmode: POWER_OFF" -> "POWER_OFF"
  if (!raw) return '';
  const m = raw.split(':').pop().trim().toUpperCase();
  return m;
}

const LABELS = {
  '':              ['No robot connection',       'var(--tx3)'],
  NO_CONTROLLER:   ['Controller not ready',      'var(--rd)'],
  DISCONNECTED:    ['Arm disconnected',          'var(--rd)'],
  CONFIRM_SAFETY:  ['Confirm safety on pendant', 'var(--rd)'],
  BOOTING:         ['Booting…',                  'var(--yl,#f59e0b)'],
  POWER_OFF:       ['Powered off',               'var(--rd)'],
  POWER_ON:        ['Powering on…',              'var(--yl,#f59e0b)'],
  IDLE:            ['Powered, brakes locked',    'var(--yl,#f59e0b)'],
  BACKDRIVE:       ['Backdrive',                 'var(--yl,#f59e0b)'],
  RUNNING:         ['Ready',                     'var(--gn)'],
};

function setLocked(locked) {
  robotReady = !locked;
  window.robotReady = robotReady;
  document.body.classList.toggle('robot-locked', locked);
  document.querySelectorAll(LOCKED_SELECTORS.join(',')).forEach(el => {
    el.classList.add('needs-init');
    el.title = locked ? 'Initialize the robot first' : (el.dataset.origTitle ?? el.title);
  });
}

function render(data) {
  const mode   = parseMode(data?.mode);
  const safety = parseMode(data?.safety);
  const init   = data?.init || {};
  initBusy = !!init.busy;
  lastMode = mode;

  const [label, color] = LABELS[mode] || [mode, 'var(--tx2)'];
  const running = mode === 'RUNNING';
  const safetyBad = safety && !['NORMAL', 'REDUCED'].includes(safety);

  // Header pill
  const pill = $('init-pill');
  if (pill) {
    pill.textContent = running ? '● READY' : '● BOOT UP FIRST';
    pill.style.color = running ? 'var(--gn)' : 'var(--rd)';
    pill.style.borderColor = running ? 'var(--gn)' : 'var(--rd)';
  }

  // Panel
  const modeEl = $('init-mode');
  if (modeEl) { modeEl.textContent = label; modeEl.style.color = color; }

  const msg = $('init-msg');
  if (msg) {
    if (init.busy)           msg.textContent = init.step || 'Working…';
    else if (init.error)     msg.textContent = '✕ ' + init.error;
    else if (safetyBad)      msg.textContent = `Safety: ${safety}. Clear it before initializing.`;
    else if (!mode)          msg.textContent = 'Waiting for the robot… check the IP and relay.';
    else if (running)        msg.textContent = 'Robot is live. Movement controls unlocked.';
    else                     msg.textContent = 'Boot up first: press Initialize Robot before moving anything.';
    msg.style.color = init.error || safetyBad ? 'var(--rd)' : 'var(--tx3)';
  }

  const btn = $('btn-init-robot');
  if (btn && !armTimer) {
    btn.disabled = init.busy || running || !mode;
    btn.textContent = init.busy ? 'Initializing…' : running ? '✓ Initialized' : 'Initialize Robot';
  }
  const off = $('btn-power-off');
  if (off && !off.dataset.armed) off.disabled = init.busy || !mode || mode === 'POWER_OFF';

  const panel = $('init-panel');
  if (panel) panel.style.borderColor = running ? 'var(--bd)' : 'var(--rd)';

  setLocked(!running);
}

async function poll() {
  try {
    if (ip()) {
      const r = await fetch(RELAY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dashboard_status', ip: ip() }),
      });
      render(await r.json());
    } else render(null);
  } catch { render(null); }
  setTimeout(poll, 500);
}

function onInitClick() {
  const btn = $('btn-init-robot');
  if (!btn || initBusy) return;
  // Two-press confirm: brakes release with an audible click and the arm can settle slightly.
  if (!armTimer) {
    btn.textContent = 'Press again: brakes will release';
    btn.style.background = 'var(--yl,#f59e0b)'; btn.style.color = '#000';
    armTimer = setTimeout(() => { armTimer = null; btn.style.background = ''; btn.style.color = ''; }, 4000);
    return;
  }
  clearTimeout(armTimer); armTimer = null;
  btn.style.background = ''; btn.style.color = '';
  btn.disabled = true; btn.textContent = 'Initializing…';
  fetch(RELAY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'dashboard_init', ip: ip() }),
  }).then(r => r.json()).then(d => {
    if (!d.ok && $('init-msg')) $('init-msg').textContent = '✕ ' + (d.error || 'Relay refused');
  }).catch(() => { if ($('init-msg')) $('init-msg').textContent = '✕ Cannot reach the relay'; });
}

function onPowerOffClick() {
  const btn = $('btn-power-off');
  if (!btn) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1'; btn.textContent = 'Press again to power off';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Power Off'; }, 4000);
    return;
  }
  delete btn.dataset.armed; btn.textContent = 'Power Off';
  fetch(RELAY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'dashboard_power_off', ip: ip() }),
  });
}

function flashNotReady() {
  const pill = $('init-pill'), panel = $('init-panel');
  [pill, panel].forEach(el => {
    if (!el) return;
    el.classList.remove('init-flash'); void el.offsetWidth; el.classList.add('init-flash');
  });
  const msg = $('init-msg');
  if (msg) { msg.textContent = 'Boot up first: press Initialize Robot before moving anything.'; msg.style.color = 'var(--rd)'; }
}

export function initRobotInit() {
  LOCKED_SELECTORS.forEach(sel => document.querySelectorAll(sel).forEach(el => {
    el.dataset.origTitle = el.title || '';
  }));

  $('btn-init-robot')?.addEventListener('click', onInitClick);
  $('btn-power-off')?.addEventListener('click', onPowerOffClick);
  $('init-pill')?.addEventListener('click', () => {
    document.querySelector('.tab[data-target="tab-positions"]')?.click();
    flashNotReady();
  });

  // Capture-phase guard: swallow presses on locked controls before their own handlers run.
  const guard = e => {
    if (robotReady) return;
    const hit = e.target.closest?.(LOCKED_SELECTORS.join(','));
    if (!hit) return;
    e.stopImmediatePropagation(); e.preventDefault();
    if (e.type !== 'mouseup' && e.type !== 'touchend') flashNotReady();
  };
  ['mousedown', 'click', 'touchstart'].forEach(t => document.addEventListener(t, guard, true));

  document.addEventListener('keydown', e => {
    if (robotReady) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (LOCKED_KEYS.includes(e.key.toLowerCase())) {
      e.stopImmediatePropagation(); e.preventDefault(); flashNotReady();
    }
  }, true);

  setLocked(true);   // locked until the first poll says RUNNING
  poll();
}
