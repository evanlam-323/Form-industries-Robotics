// ═══════════════════════════════════════════════════════════
// MAIN — global init, tab switching, event wiring
// ═══════════════════════════════════════════════════════════
import { pingRobot, emergencyStop, startFreedriveDetection, startPopupPoller, resolvePopup, startJog, stopJog, startJogJoint, stopJogJoint } from './network.js';
import { getRelayIp, saveRelayIp } from './state.js';
import { initViewer } from './viewer3d.js';
import { renderPositions, exposeSetup, addPos, toggleFreedrive, openGripper, closeGripper, recordLivePosition } from './tab-setup.js';
import { initHoming } from './homing.js';
import { initFollowerTab } from './tab-follower.js';

// ── TAB SWITCHING ──
function initTabs() {
  document.querySelectorAll('.tab[data-target]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('on'));
      tab.classList.add('on');
      const target = document.getElementById(tab.dataset.target);
      if (target) target.classList.add('on');
    });
  });
}

// ── HEADER BUTTONS ──
function initHeader() {
  document.getElementById('ping-btn')?.addEventListener('click', pingRobot);
  document.getElementById('global-estop')?.addEventListener('click', emergencyStop);
  document.getElementById('btn-resolve-popup')?.addEventListener('click', resolvePopup);

  // Relay IP: restore saved value and persist on change
  const relayIpEl = document.getElementById('relay-ip');
  if (relayIpEl) {
    relayIpEl.value = getRelayIp();
    relayIpEl.addEventListener('input', () => {
      saveRelayIp(relayIpEl.value);
    });
  }
}

// ── POSITIONS TAB WIRING ──
function initPositionsTab() {
  document.getElementById('btn-freedrive')?.addEventListener('click', toggleFreedrive);
  initHoming();
  document.getElementById('btn-get-current')?.addEventListener('click', recordLivePosition);
  document.getElementById('btn-open-gripper')?.addEventListener('click', openGripper);
  document.getElementById('btn-close-gripper')?.addEventListener('click', closeGripper);
  document.getElementById('btn-gripper-activate')?.addEventListener('click', () => {
    import('./tab-setup.js').then(setup => setup.activateGripper());
  });

  // Telemetry refresh & live check
  document.getElementById('btn-refresh-telemetry')?.addEventListener('click', () => {
    import('./network.js').then(net => net.fetchRobotState());
  });
  document.getElementById('live-monitoring-chk')?.addEventListener('change', e => {
    import('./state.js').then(s => s.setIsLiveMonitoring(e.target.checked));
  });

  // Axis Mask
  for (let i = 0; i < 6; i++) {
    document.getElementById(`fd-ax-${i}`)?.addEventListener('click', () => {
      import('./tab-setup.js').then(setup => setup.toggleFdAxis(i));
    });
  }

  document.getElementById('btn-jog-ready')?.addEventListener('click', () => {
    import('./network.js').then(net => net.moveToJogReady());
  });

  // Jog Controls (Cartesian)
  document.querySelectorAll('.jog-btn').forEach(btn => {
    const axis = parseInt(btn.dataset.axis);
    const dir = parseInt(btn.dataset.dir);
    btn.addEventListener('mousedown', () => {
      import('./network.js').then(net => net.startJog(axis, dir));
    });
    btn.addEventListener('mouseup', () => {
      import('./network.js').then(net => net.stopJog());
    });
    btn.addEventListener('mouseleave', () => {
      import('./network.js').then(net => net.stopJog());
    });
  });

  // Jog Controls (Joint)
  document.querySelectorAll('.joint-jog-btn').forEach(btn => {
    const joint = parseInt(btn.dataset.joint);
    const dir   = parseInt(btn.dataset.dir);
    btn.addEventListener('mousedown', () => {
      import('./network.js').then(net => net.startJogJoint(joint, dir));
    });
    btn.addEventListener('mouseup', () => {
      import('./network.js').then(net => net.stopJogJoint());
    });
    btn.addEventListener('mouseleave', () => {
      import('./network.js').then(net => net.stopJogJoint());
    });
  });

  // Prevent touch hold from triggering drag
  document.querySelectorAll('.jog-btn, .joint-jog-btn').forEach(btn => {
    btn.addEventListener('touchstart', e => { e.preventDefault(); btn.dispatchEvent(new Event('mousedown')); });
    btn.addEventListener('touchend',   e => { e.preventDefault(); btn.dispatchEvent(new Event('mouseup')); });
  });

  // Add position button
  const addPosBtn = document.createElement('button');
  addPosBtn.className = 'btn btn-sm';
  addPosBtn.style.cssText = 'margin: 8px; font-size: 12px;';
  addPosBtn.textContent = '+ Add Position';
  addPosBtn.addEventListener('click', addPos);
  document.querySelector('.col-left .card-hdr')?.appendChild(addPosBtn);
}

// ── KEYBOARD SHORTCUTS ──
function initKeyboardShortcuts() {
  const TAB_TARGETS = ['tab-positions', 'tab-follower'];

  document.addEventListener('keydown', e => {
    // Never fire when the user is typing in an input, textarea, or select
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    switch (e.key) {

      case 'f':
      case 'F':
        e.preventDefault();
        toggleFreedrive();
        break;

      case 'e':
      case 'E':
        e.preventDefault();
        emergencyStop();
        break;

      case ' ':
        e.preventDefault();
        recordLivePosition();
        break;

      case '1':
      case '2': {
        e.preventDefault();
        const target = TAB_TARGETS[parseInt(e.key) - 1];
        const tab = document.querySelector(`.tab[data-target="${target}"]`);
        if (tab) tab.click();
        break;
      }

      case 'g':
      case 'G': {
        e.preventDefault();
        import('./state.js').then(s => {
          if (!s.gripperActivated) return; // ignore if gripper not yet activated
          if (s.isGripperOpen) {
            closeGripper();
          } else {
            openGripper();
          }
        });
        break;
      }
    }
  });
}

// ── BOOT ──
document.addEventListener('DOMContentLoaded', () => {
  // Expose module fns for inline HTML handlers
  exposeSetup();

  initTabs();
  initHeader();
  initKeyboardShortcuts();
  initPositionsTab();
  initFollowerTab();

  // Initial render
  renderPositions();

  // 3D viewer
  initViewer('robot-3d-view');

  // Background services
  startFreedriveDetection();
  startPopupPoller();
  import('./network.js').then(net => {
    net.startTelemetryPoller();
    net.startGripperTelemetry();
  });
});