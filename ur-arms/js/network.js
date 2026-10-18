// ═══════════════════════════════════════════════════════════
// NETWORK — all fetch() calls to relay.py
// ═══════════════════════════════════════════════════════════
import { steps, positions, isJogging, setIsJogging, isFreedrive, setIsFreedrive, fdAxes, isJointJogging, setIsJointJogging, isSimulationMode, simJoints, setSimJoints, globalSettings } from './state.js';
import { updateViewer } from './viewer3d.js';

export const RELAY = 'http://localhost:5678';

export function setDot(state) {
  const dot = document.getElementById('robot-dot');
  const map = {
    idle:    {bg:'var(--tx3)',          shadow:'none'},
    pinging: {bg:'var(--yl,#f59e0b)',   shadow:'none'},
    ok:      {bg:'var(--gn)',           shadow:'0 0 7px var(--gn)'},
    err:     {bg:'var(--rd)',           shadow:'none'},
    sending: {bg:'var(--bl)',           shadow:'0 0 7px var(--bl)'},
  };
  const cfg = map[state] || map.idle;
  if (dot) { dot.style.background = cfg.bg; dot.style.boxShadow = cfg.shadow; }
}

export async function pingRobot() {
  const btn = document.getElementById('ping-btn');
  const ip  = document.getElementById('robot-ip').value.trim();
  if (!ip) { alert('Enter the robot IP address first.'); return; }
  btn.textContent = '…';
  btn.disabled = true;
  setDot('pinging');
  try {
    const res  = await fetch(RELAY, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ip, code:'# ping\n'})
    });
    const data = await res.json();
    if (data.ok) {
      setDot('ok');
      btn.textContent = '✓ Connected';
      btn.style.color = 'var(--gn)';
    } else {
      throw new Error(data.error || 'Robot refused connection');
    }
  } catch(e) {
    setDot('err');
    btn.textContent = 'Failed';
    btn.style.color = 'var(--rd)';
    const isRelay = e.message.includes('fetch') || e.message.includes('Failed to fetch');
    setTimeout(() => alert(
      isRelay
        ? 'Cannot reach the relay server.\n\nMake sure it is still running:\n  python3 relay.py'
        : `Could not connect to robot at ${ip}.\n\nError: ${e.message}`
    ), 50);
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Ping'; btn.style.color = ''; }, 3000);
  }
}

export function sendDirect(codeStr) {
  // In simulation mode, never send anything to the real robot
  if (isSimulationMode) return;
  const ip = document.getElementById('robot-ip').value.trim();
  if (!ip) return;
  fetch(RELAY, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ip, code: codeStr, action:'send'})
  });
}

export function emergencyStop() {
  console.error('EMERGENCY STOP TRIGGERED');
  sendDirect('protective_stop()\n');
  resetFreedriveUI();
}

export function resetFreedriveUI() {
  setIsFreedrive(false);
  const btn = document.getElementById('btn-freedrive');
  if (btn) {
    btn.textContent = 'Freedrive: OFF';
    btn.classList.remove('btn-ac');
    btn.style.opacity = '';
  }
}

export function startFreedriveDetection() {
  const ip = document.getElementById('robot-ip').value;
  if (!ip) return setTimeout(startFreedriveDetection, 250);

  fetch(RELAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'dashboard_status', ip: ip })
  })
  .then(r => r.json())
  .then(data => {
    // 🎯 FIX: Track the hardware execution mode (data.mode), not the dashboard program
    if (data.ok && data.mode) {
      if (isFreedrive && (data.mode.includes("IDLE") || data.mode.includes("POWER_OFF"))) {
        resetFreedriveUI();
      }
    }
  })
  .finally(() => {
    setTimeout(startFreedriveDetection, 250);
  });
}

export async function fetchRobotState() {
  const ip = document.getElementById('robot-ip').value.trim();
  if (!ip) return;
  const statusEl = document.getElementById('telemetry-status');
  try {
    const res  = await fetch(RELAY, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ip, action:'state'})
    });
    const data = await res.json();
    const tcp    = data.tcp    || data.actual_TCP_pose || data.pose || data.cartesian;
    const joints = data.joints || data.actual_joint_positions || data.q_actual || data.q;

    if (statusEl) {
      statusEl.textContent = 'Connected';
      statusEl.style.color = 'var(--gn)';
    }

    const updateText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    if (tcp && tcp.length >= 6) {
      const s = await import('./state.js');
      s.setLatestTcp(tcp);
      updateText('live-x', tcp[0].toFixed(4));
      updateText('live-y', tcp[1].toFixed(4));
      updateText('live-z', tcp[2].toFixed(4));
      updateText('live-rx', tcp[3].toFixed(4));
      updateText('live-ry', tcp[4].toFixed(4));
      updateText('live-rz', tcp[5].toFixed(4));
    }
    if (joints && joints.length >= 6) {
      const s = await import('./state.js');
      s.setLatestJoints(joints);
      const gs = await import('./state.js').then(s => s.globalSettings);
      updateViewer(joints, { x: gs.tcpX, y: gs.tcpY, z: gs.tcpZ, rx: gs.tcpRx, ry: gs.tcpRy, rz: gs.tcpRz });
      const toDisp = rad => (rad * 180 / Math.PI).toFixed(2);
      updateText('live-j0', toDisp(joints[0]));
      updateText('live-j1', toDisp(joints[1]));
      updateText('live-j2', toDisp(joints[2]));
      updateText('live-j3', toDisp(joints[3]));
      updateText('live-j4', toDisp(joints[4]));
      updateText('live-j5', toDisp(joints[5]));
    }

    // ── Populate Live Variables panel (Run tab) ──
    const liveVars = document.getElementById('live-variables');
    if (liveVars && tcp && joints) {
      const toD = rad => (rad * 180 / Math.PI).toFixed(2);
      const row = (label, val, color) =>
        `<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid var(--bd);">`+
        `<span style="color:${color};font-weight:bold;min-width:48px;">${label}</span>`+
        `<span style="color:var(--tx);font-family:var(--mono);">${val}</span></div>`;
      liveVars.innerHTML =
        `<div style="font-size:9px;color:var(--tx3);text-transform:uppercase;font-weight:bold;margin-bottom:6px;">TCP Position (m / rad)</div>`+
        row('X',  tcp[0]?.toFixed(4) ?? '—', 'var(--ac)')+
        row('Y',  tcp[1]?.toFixed(4) ?? '—', 'var(--ac)')+
        row('Z',  tcp[2]?.toFixed(4) ?? '—', 'var(--ac)')+
        row('Rx', tcp[3]?.toFixed(4) ?? '—', '#a78bfa')+
        row('Ry', tcp[4]?.toFixed(4) ?? '—', '#a78bfa')+
        row('Rz', tcp[5]?.toFixed(4) ?? '—', '#a78bfa')+
        `<div style="font-size:9px;color:var(--tx3);text-transform:uppercase;font-weight:bold;margin:8px 0 6px;">Joint Angles (°)</div>`+
        ['Base','Shoulder','Elbow','W1','W2','W3'].map((name, i) =>
          row(name, toD(joints[i]) + '°', 'var(--gn)')
        ).join('');
    }
    return { tcp, joints };
  } catch(e) {
    console.error('Failed to read robot state', e);
    if (statusEl) {
      statusEl.textContent = 'Failed';
      statusEl.style.color = 'var(--rd)';
    }
  }
}

export function startTelemetryPoller() {
  async function poll() {
    try {
      const s = await import('./state.js');

      if (s.isSimulationMode) {
        // ── SIM MODE: Feed simJoints to the 3D viewer and telemetry display ──
        updateViewer(s.simJoints, {
          x: s.globalSettings.tcpX, y: s.globalSettings.tcpY, z: s.globalSettings.tcpZ,
          rx: s.globalSettings.tcpRx, ry: s.globalSettings.tcpRy, rz: s.globalSettings.tcpRz
        });
        const toDisp = rad => (rad * 180 / Math.PI).toFixed(2);
        ['live-j0','live-j1','live-j2','live-j3','live-j4','live-j5'].forEach((id, i) => {
          const el = document.getElementById(id);
          if (el) el.textContent = toDisp(s.simJoints[i]);
        });
        // Update TCP display from simTcp
        const tcp = s.simTcp;
        if (tcp) {
          ['live-x','live-y','live-z','live-rx','live-ry','live-rz'].forEach((id, i) => {
            const el = document.getElementById(id);
            if (el) el.textContent = tcp[i].toFixed(4);
          });
        }
      } else if (s.isLiveMonitoring) {
        // ── REAL MODE ──
        const ip = document.getElementById('robot-ip').value.trim();
        const dot = document.getElementById('robot-dot')?.style.background;
        if (ip && dot !== 'var(--bl)') {
          await fetchRobotState();
        }
      }
    } catch(e) {
      console.error('Telemetry polling error', e);
    }
    setTimeout(poll, 250);
  }
  setTimeout(poll, 1000);
}

export function startGripperTelemetry() {
  async function poll() {
    // Skip gripper polling entirely in sim mode
    const s = await import('./state.js');
    if (s.isSimulationMode) { setTimeout(poll, 500); return; }

    const ip = document.getElementById('robot-ip')?.value?.trim();
    if (!ip) {
      setTimeout(poll, 1000);
      return;
    }

    try {
      const res = await fetch(RELAY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'gripper_status', ip: ip })
      });
      const data = await res.json();
      
      const s = await import('./state.js');
      if (data.ok) {
        let raw = data.position_raw;
        if (raw !== undefined) {
          if (raw < 3) raw = 3;
          if (raw > 230) raw = 230;
          let pct = Math.round(((raw - 3) / (230 - 3)) * 100);
          const posEl = document.getElementById('live-gripper-pos');
          if (posEl) posEl.textContent = `${raw} (${pct}%)`;
          // Drive 3D gripper: raw 3=open (0 rad), 230=closed (0.8 rad)
          const gripperQ = ((raw - 3) / (230 - 3)) * 0.8;
          import('./gripper3d.js').then(gr => gr.animateGripper(gripperQ, 150));
        }

        const objEl = document.getElementById('live-gripper-obj');
        if (objEl) {
          if (data.gobj === 1 || data.gobj === 2) {
            objEl.style.display = 'inline';
          } else {
            objEl.style.display = 'none';
          }
        }

        const isActivated = (data.gsta === 3);
        if (s.gripperActivated !== isActivated) {
          s.setGripperActivated(isActivated);
          const actBtn = document.getElementById('btn-gripper-activate');
          const grpBox = document.getElementById('gripper-actions-box');
          if (actBtn && grpBox) {
            if (isActivated) {
              actBtn.style.display = 'none';
              grpBox.style.display = 'flex';
            } else {
              actBtn.style.display = 'block';
              grpBox.style.display = 'none';
              actBtn.disabled = false;
              actBtn.textContent = 'Activate Gripper';
            }
          }
        }
      }
    } catch(err) {
      const posEl = document.getElementById('live-gripper-pos');
      if (posEl) posEl.textContent = "---";
      const objEl = document.getElementById('live-gripper-obj');
      if (objEl) objEl.style.display = 'none';
    }
    setTimeout(poll, 250);
  }
  setTimeout(poll, 1000);
}

export function startJog(axis, direction) {
  setIsJogging(true);
  resetFreedriveUI();

  if (isSimulationMode) {
    // ── SIM MODE: Nudge simTcp in the requested Cartesian axis ──
    // Uses module-level simTcp (imported at top) for zero-overhead RAF loop
    const LINEAR_SPEED  = 0.003;  // m per frame (~60fps)
    const ANGULAR_SPEED = 0.015;  // rad per frame

    function simCartJogLoop() {
      if (!isJogging) return;
      import('./state.js').then(s => {
        const tcp = [...s.simTcp];
        tcp[axis] += axis < 3 ? LINEAR_SPEED * direction : ANGULAR_SPEED * direction;
        s.setSimTcp(tcp);
        const ids = ['live-x','live-y','live-z','live-rx','live-ry','live-rz'];
        ids.forEach((id, i) => {
          const el = document.getElementById(id);
          if (el) el.textContent = tcp[i].toFixed(4);
        });
      });
      requestAnimationFrame(simCartJogLoop);
    }
    simCartJogLoop();
    return;
  }

  // ── REAL MODE ──
  let vector = [0, 0, 0, 0, 0, 0];
  vector[axis] = direction * (axis < 3 ? 0.05 : 0.25);
  const speedlCmd = `def jog():\n  while True:\n    speedl([${vector.join(',')}], a=0.3, t=0.1)\n  end\nend\n`;
  sendDirect(speedlCmd);
}

export function stopJog() {
  if (!isJogging) return;
  setIsJogging(false);
  // In sim mode sendDirect is already a no-op, but we still clear the flag
  if (!isSimulationMode) {
    sendDirect("def stop_jog():\n  stopl(2.5)\nend\n");
  }
}

export function startJogJoint(jointIdx, direction) {
  setIsJointJogging(true);
  resetFreedriveUI();

  if (isSimulationMode) {
    // ── SIM MODE: Animate simJoints via RAF ──
    const speed = 0.02 * direction; // rad per frame at ~60fps
    function jogLoop() {
      if (!isJointJogging) return;
      import('./state.js').then(s => {
        const j = [...s.simJoints];
        j[jointIdx] = Math.max(-2*Math.PI, Math.min(2*Math.PI, j[jointIdx] + speed));
        s.setSimJoints(j);
      });
      requestAnimationFrame(jogLoop);
    }
    jogLoop();
    return;
  }

  // ── REAL MODE ──
  let qd = [0, 0, 0, 0, 0, 0];
  qd[jointIdx] = direction * 0.3;
  const cmd = `def jog_j():\n  while True:\n    speedj([${qd.join(',')}], a=1.5, t=0.1)\n  end\nend\n`;
  sendDirect(cmd);
}

export function stopJogJoint() {
  if (!isJointJogging) return;
  setIsJointJogging(false);
  if (!isSimulationMode) {
    sendDirect("def stop_jog_j():\n  stopj(2.5)\nend\n");
  }
}

export async function dashPlay()  { const ip = document.getElementById('robot-ip').value.trim(); if (!ip) return; fetch(RELAY,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'dashboard_play',ip})}); }
export async function dashPause() { const ip = document.getElementById('robot-ip').value.trim(); if (!ip) return; fetch(RELAY,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'dashboard_pause',ip})}); }
export async function dashStop()  { const ip = document.getElementById('robot-ip').value.trim(); if (!ip) return; fetch(RELAY,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'dashboard_stop',ip})}); }
export async function dashSpeed(val) { const ip = document.getElementById('robot-ip').value.trim(); if (!ip) return; fetch(RELAY,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'dashboard_speed',ip,fraction:val/100})}); }

export function startPopupPoller() {
  function checkPopups() {
    fetch(RELAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check_popup' })
    })
    .then(r => r.json())
    .then(data => {
      const modal = document.getElementById('ui-modal');
      const msgEl = document.getElementById('ui-modal-msg');
      if (data.ok && data.msg) {
        msgEl.innerText = data.msg;
        modal.style.display = 'flex';
      } else {
        modal.style.display = 'none';
      }
    })
    .catch(err => console.log("Popup poll error:", err))
    .finally(() => { setTimeout(checkPopups, 500); });
  }
  setTimeout(checkPopups, 1000);
}

export function resolvePopup() {
  document.getElementById('ui-modal').style.display = 'none';
  fetch(RELAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'resolve_popup' })
  });
}