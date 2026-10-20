// ═══════════════════════════════════════════════════════════
// TAB-SETUP — Positions list, Robot Controls, Live viewer
// ═══════════════════════════════════════════════════════════
import { positions, setPositions, steps, setSteps, latestJoints, latestTcp, uid, isFreedrive, setIsFreedrive, fdAxes, setIsGripperOpen } from './state.js';
import { sendDirect, resetFreedriveUI, fetchRobotState, RELAY } from './network.js';
import { renderSteps, refreshCode } from './tab-program.js';

export const JOINT_LABELS = ['J0','J1','J2','J3','J4','J5'];
export const CART_LABELS  = ['X','Y','Z','Rx','Ry','Rz'];

export function toDisp(rad) { return (rad * 180 / Math.PI).toFixed(2); }
export function fromDisp(deg) { return (parseFloat(deg) || 0) * Math.PI / 180; }

export function renderPositions() {
  const el = document.getElementById('positions-list');
  if (!el) return;
  el.innerHTML = positions.map(pos => {
    if (!pos.c) pos.c = [...pos.j];
    return `
    <div class="pos-card" id="pc-${pos.id}"
      onmouseenter="window._setup.hoverPos('${pos.id}', true)"
      onmouseleave="window._setup.hoverPos('${pos.id}', false)"
      style="background:var(--sf2);border:1px solid var(--bd);border-radius:var(--r);padding:10px;margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <div style="width:8px;height:8px;border-radius:50%;background:${posComplete(pos)?'var(--gn)':'var(--tx3)'}"></div>
        <input style="flex:1;background:transparent;border:none;border-bottom:1px solid var(--bd);color:var(--tx);font-weight:600;font-size:13px;padding:2px 4px;" 
          value="${pos.name}"
          onchange="window._setup.renamePos('${pos.id}',this.value)"
          onblur="window._setup.renamePos('${pos.id}',this.value)"/>
        <button class="btn btn-sm" style="font-size:10px;padding:3px 8px;" 
          onmousedown="window._setup.startMoveHere('${pos.id}')" 
          onmouseup="window._setup.stopMoveHere()" 
          onmouseleave="window._setup.stopMoveHere()">Move Here</button>
        <button class="btn btn-sm" style="font-size:10px;padding:3px 8px;" 
          onclick="window._setup.setToCurrent('${pos.id}')">Set Current</button>
        <button class="btn btn-sm" style="font-size:10px;padding:3px 6px;color:var(--rd);border-color:var(--rdlo);" onclick="window._setup.deletePos('${pos.id}')">✕</button>
      </div>
      <div style="font-size:10px;color:var(--tx3);text-transform:uppercase;margin-bottom:4px;">Joints (°)</div>
      <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:4px;margin-bottom:8px;">
        ${JOINT_LABELS.map((name, ji) => `
          <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
            <div style="font-size:9px;color:var(--tx3);">${name}</div>
            <input style="width:100%;background:var(--sf);border:1px solid var(--bd);border-radius:4px;color:var(--tx);font-size:11px;padding:2px;text-align:center;" 
              type="number" step="0.1" value="${toDisp(pos.j[ji])}"
              oninput="window._setup.liveJoint(this,'${pos.id}',${ji},false)"/>
          </div>`).join('')}
      </div>
      <div style="font-size:10px;color:var(--tx3);text-transform:uppercase;margin-bottom:4px;">Cartesian (m/rad)</div>
      <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:4px;">
        ${CART_LABELS.map((name, ci) => `
          <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
            <div style="font-size:9px;color:var(--tx3);">${name}</div>
            <input style="width:100%;background:var(--sf);border:1px solid var(--bd);border-radius:4px;color:var(--tx);font-size:11px;padding:2px;text-align:center;" 
              type="number" step="0.0001" value="${pos.c[ci].toFixed(4)}"
              oninput="window._setup.liveJoint(this,'${pos.id}',${ci},true)"/>
          </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function posComplete(pos) {
  return pos.j.some(v => v !== 0) || (pos.c && pos.c.some(v => v !== 0));
}

export function liveJoint(el, pid, index, isCart) {
  const pos = positions.find(p => p.id === pid);
  if (!pos) return;
  if (isCart) {
    if (!pos.c) pos.c = [0,0,0,0,0,0];
    pos.c[index] = parseFloat(el.value) || 0;
  } else {
    pos.j[index] = fromDisp(el.value);
  }
  refreshCode();
}

export function renamePos(pid, val) {
  const pos = positions.find(p=>p.id===pid); if (!pos) return;
  pos.name = val.toUpperCase().replace(/\s+/g,'_').replace(/[^A-Z0-9_]/g,'') || pos.name;
  refreshCode(); renderSteps();
}

export function addPos() {
  positions.push({id:uid(), name:'POS_'+(positions.length+1), j:[0,0,0,0,0,0], c:[0,0,0,0,0,0]});
  renderPositions(); renderSteps(); refreshCode();
}

export function deletePos(pid) {
  if (positions.length <= 1) return;
  setPositions(positions.filter(p=>p.id!==pid));
  // Null out any steps that reference this position
  import('./state.js').then(s => {
    s.setSteps(s.steps.map(st=>{
      if ((st.type==='movej'||st.type==='movel')&&st.pid===pid) return {...st, pid:null};
      if (st.type==='movec'&&st.via===pid) return {...st, via:null};
      if (st.type==='movec'&&st.to===pid)  return {...st, to:null};
      return st;
    }));
    renderPositions(); renderSteps(); refreshCode();
  });
}

export function startMoveHere(pid) {
  const pos = positions.find(p => p.id === pid);
  if (!pos) return;
  if (pos.name === 'HOME') { window._homeHold = true; import('./homing.js').then(h => h.goHome()); return; }

  import('./state.js').then(s => {
    if (s.isSimulationMode) {
      // ── SIM MODE: Animate simJoints toward the target joint values ──
      if (!pos.j || pos.j.every(v => v === 0)) {
        console.warn('[Sim] No joint data for position:', pos.name);
        return;
      }
      const TARGET  = [...pos.j];
      const STEPS   = 60;   // frames to complete the move
      const START   = [...s.simJoints];
      let frame     = 0;

      // Store cancel handle so stopMoveHere can abort it
      window._simMoveRaf = true;

      function step() {
        if (!window._simMoveRaf) return;
        frame++;
        const t = Math.min(frame / STEPS, 1);
        // Smooth-step easing
        const ease = t * t * (3 - 2 * t);
        const j = START.map((v, i) => v + (TARGET[i] - v) * ease);
        s.setSimJoints(j);
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          window._simMoveRaf = false;
        }
      }
      requestAnimationFrame(step);
      return;
    }

    // ── REAL MODE ──
    const hasJ = pos.j && pos.j.length === 6 && !pos.j.every(v => v === 0);
    if (!hasJ && !pos.c) return;
    const target = hasJ
      ? `[${pos.j.map(v => v.toFixed(4)).join(',')}]`
      : `p[${pos.c.map(v => v.toFixed(4)).join(',')}]`;
    const urscript = `def move_here():\n  movej(${target}, a=1.2, v=0.25)\nend\n`;
    resetFreedriveUI();
    sendDirect(urscript);
  });
}

export function stopMoveHere() {
  if (window._homeHold) { window._homeHold = false; import('./homing.js').then(h => h.stopHome()); return; }
  import('./state.js').then(s => {
    if (s.isSimulationMode) {
      window._simMoveRaf = false; // Cancel the RAF loop
      return;
    }
    sendDirect("def stop_move():\n  stopl(2.5)\nend\n");
  });
}

export function setToCurrent(pid) {
  import('./state.js').then(s => {
    const pos = positions.find(p => p.id === pid);
    if (!pos) return;

    if (s.isSimulationMode) {
      // ── SIM MODE: Capture current simulated joint/TCP values ──
      pos.j = [...s.simJoints];
      pos.c = [...(s.simTcp || [0,0,0,0,0,0])];
      renderPositions(); renderSteps(); refreshCode();
      return;
    }

    // ── REAL MODE ──
    if (!s.latestJoints || !s.latestTcp) {
      alert("Enable Live Tracker first to get the robot's current coordinates.");
      return;
    }
    pos.j = [...s.latestJoints];
    pos.c = [...s.latestTcp];
    renderPositions(); renderSteps(); refreshCode();
  });
}

export function recordLivePosition() {
  import('./state.js').then(s => {
    if (s.isSimulationMode) {
      // ── SIM MODE: Record current simulated pose as a new position ──
      positions.push({
        id: uid(),
        name: 'SIM_' + (positions.length + 1),
        j: [...s.simJoints],
        c: [...(s.simTcp || [0,0,0,0,0,0])]
      });
      renderPositions(); renderSteps(); refreshCode();
      return;
    }

    // ── REAL MODE ──
    if (!s.latestJoints || !s.latestTcp) {
      alert("Enable Live Tracker first to get the robot's current coordinates.");
      return;
    }
    positions.push({
      id: uid(),
      name: 'POS_' + (positions.length + 1),
      j: [...s.latestJoints],
      c: [...s.latestTcp]
    });
    renderPositions(); renderSteps(); refreshCode();
  });
}

export function toggleFreedrive() {
  import('./state.js').then(s => {
    if (s.isSimulationMode) {
      // Freedrive is a physical robot feature — not available in sim
      const btn = document.getElementById('btn-freedrive');
      const orig = btn?.textContent;
      if (btn) { btn.textContent = 'N/A in Sim'; btn.style.opacity = '0.5'; }
      setTimeout(() => { if (btn) { btn.textContent = orig; btn.style.opacity = ''; } }, 1500);
      return;
    }
    const ip = document.getElementById('robot-ip').value;
    if (!ip) return alert("Enter Robot IP first.");
    const btn = document.getElementById('btn-freedrive');
    if (!s.isFreedrive) {
      s.setIsFreedrive(true);
      btn.textContent = 'Freedrive: ON';
      btn.classList.add('btn-ac');
      sendDirect(`def fd_on():\n  freedrive_mode([${s.fdAxes.join(',')}], p[0,0,0,0,0,0])\n  while True:\n    sync()\n  end\nend\n`);
    } else {
      s.setIsFreedrive(false);
      btn.textContent = 'Freedrive: OFF';
      btn.classList.remove('btn-ac');
      sendDirect(`def fd_off():\n  end_freedrive_mode()\nend\n`);
    }
  });
}

export function toggleFdAxis(index) {
  import('./state.js').then(s => {
    const val = s.fdAxes[index] === 1 ? 0 : 1;
    s.setFdAxis(index, val);
    const btn = document.getElementById(`fd-ax-${index}`);
    if (btn) btn.classList.toggle('on', val === 1);
    if (s.isFreedrive) {
      sendDirect(`def fd_on():\n  freedrive_mode([${s.fdAxes.join(',')}], p[0,0,0,0,0,0])\n  while True:\n    sync()\n  end\nend\n`);
    }
  });
}

export function activateGripper() {
  import('./state.js').then(s => {
    if (s.isSimulationMode) {
      // In sim mode, skip physical activation and just show the gripper controls
      const actBtn = document.getElementById('btn-gripper-activate');
      const grpBox = document.getElementById('gripper-actions-box');
      if (actBtn) actBtn.style.display = 'none';
      if (grpBox) grpBox.style.display = 'flex';
      import('./gripper3d.js').then(gr => gr.animateGripper(0)); // start open
      return;
    }
    const ip = document.getElementById('robot-ip').value.trim();
    if (!ip) { alert("Enter Robot IP first."); return; }
    const btn = document.getElementById('btn-gripper-activate');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Activating...';
    }
    const urscript = `def live_grp():\n  socket_close("rq_srv")\n  socket_open("127.0.0.1", 63352, "rq_srv")\n  socket_send_string("SET ACT 1", "rq_srv")\n  socket_send_byte(10, "rq_srv")\n  sync()\n  socket_send_string("SET GTO 1", "rq_srv")\n  socket_send_byte(10, "rq_srv")\n  sync()\n  socket_close("rq_srv")\nend\nlive_grp()`;
    sendDirect(urscript);
  });
}

// Gripper actions
// Gripper. pos: 0 = open … 255 = closed.
// First choice: the relay talks to the Robotiq URCap directly (port 63352). No URScript
// program is sent, so Freedrive (or anything else running) keeps going untouched.
// Fallback (relay can't reach the gripper): send a URScript program. In Freedrive that
// program re-enters freedrive_mode() afterwards so the arm stays hand-guidable.
function gripLines(pos) {
  const send = c => `  socket_send_string("${c}", "rq_srv")\n  socket_send_byte(10, "rq_srv")\n  sync()\n`;
  return '  socket_close("rq_srv")\n  socket_open("127.0.0.1", 63352, "rq_srv")\n' +
    send('SET ACT 1') + send(`SET POS ${pos}`) + send('SET SPE 255') + send('SET FOR 255') + send('SET GTO 1') +
    '  socket_close("rq_srv")\n';
}

function gripScriptFallback(pos) {
  if (isFreedrive) {
    sendDirect(`def fd_grip():\n${gripLines(pos)}  freedrive_mode([${fdAxes.join(',')}], p[0,0,0,0,0,0])\n  while True:\n    sync()\n  end\nend\n`);
  } else {
    sendDirect(`def grp():\n${gripLines(pos)}end\n`);
  }
}

// Show what the gripper did (follower tab status line + browser console)
function gripMsg(text, color) {
  console.log('[Gripper]', text);
  const el = document.getElementById('pp-status');
  if (el) { el.textContent = text; el.style.color = color; }
}

export async function setGripper(pos) {
  pos = Math.max(0, Math.min(255, Math.round(pos)));
  const word = pos < 128 ? 'Open' : 'Close';
  import('./gripper3d.js').then(gr => gr.animateGripper(0.8 * pos / 255));
  setIsGripperOpen(pos < 128);
  const s = await import('./state.js');
  if (s.isSimulationMode) return;
  const ip = document.getElementById('robot-ip')?.value.trim();
  if (!ip) { gripMsg('Gripper: enter the robot IP first.', 'var(--rd)'); return; }
  gripMsg(`Gripper: ${word}…`, 'var(--tx2)');
  let d;
  try {
    const r = await fetch(RELAY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, action: 'gripper_move', pos, speed: 255, force: 255 }),
    });
    d = await r.json();
  } catch (e) {
    gripMsg('Gripper: cannot reach relay.py — is it running?', 'var(--rd)');
    return;
  }
  if (d.v !== 2) {
    // Old relay still running: it can't drive the gripper directly
    gripMsg('Gripper: relay.py is out of date — stop it and start it again. Trying fallback…', 'var(--rd)');
    gripScriptFallback(pos);
    return;
  }
  if (!d.ok) {
    gripMsg(`Gripper error: ${d.error}. Trying fallback…`, 'var(--rd)');
    gripScriptFallback(pos);
    return;
  }
  const moved = Math.abs(d.after - d.before) > 3 || Math.abs(d.after - pos) < 15;
  if (moved) gripMsg(`Gripper: ${word} ✓ (position ${d.before} → ${d.after})`, 'var(--gn)');
  else gripMsg(`Gripper accepted ${word} but did not move (position ${d.after}, fault ${d.fault}). Check the relay window.`, 'var(--rd)');
}

export function openGripper()  { setGripper(0); }
export function closeGripper() { setGripper(255); }

export function hoverPos(pid, show) {
  const pos = positions.find(p => p.id === pid);
  if (!pos) return;
  import('./viewer3d.js').then(v => {
    if (show) {
      if (pos.j && pos.j.some(val => val !== 0)) {
        v.showPreview(pos.j);
      }
    } else {
      v.hidePreview();
    }
  });
}

// ── Joint Edit Mode ──
export function enterEditMode() {
  import('./state.js').then(s => {
    const joints = s.isSimulationMode ? s.simJoints : s.latestJoints;
    if (!joints) {
      alert("No joint data available.");
      return;
    }
    for (let i = 0; i < 6; i++) {
      const inp = document.getElementById(`edit-j${i}`);
      if (inp) inp.value = toDisp(joints[i]);
    }
    document.getElementById('jnt-display').style.display = 'none';
    document.getElementById('btn-edit-joints').style.display = 'none';
    
    document.getElementById('jnt-editor').style.display = 'flex';
    document.getElementById('btn-finish-edit').style.display = 'inline-flex';
    document.getElementById('btn-apply-joints').style.display = 'inline-flex';
    
    updateEditPreview();
  });
}

export function updateEditPreview() {
  const targetJ = [];
  for (let i = 0; i < 6; i++) {
    const inp = document.getElementById(`edit-j${i}`);
    targetJ.push(fromDisp(inp.value || 0));
  }
  import('./viewer3d.js').then(v => {
    v.showPreview(targetJ);
  });
}

export function finishEditMode() {
  document.getElementById('jnt-editor').style.display = 'none';
  document.getElementById('btn-finish-edit').style.display = 'none';
  document.getElementById('btn-apply-joints').style.display = 'none';
  
  document.getElementById('jnt-display').style.display = 'flex';
  document.getElementById('btn-edit-joints').style.display = 'inline-flex';
  
  import('./viewer3d.js').then(v => v.hidePreview());
}

export function startApplyJoints() {
  const targetJ = [];
  for (let i = 0; i < 6; i++) {
    const inp = document.getElementById(`edit-j${i}`);
    targetJ.push(fromDisp(inp.value));
  }
  
  import('./state.js').then(s => {
    if (s.isSimulationMode) {
      const START = [...s.simJoints];
      const STEPS = 60;
      let frame = 0;
      window._simApplyRaf = true;
      function step() {
        if (!window._simApplyRaf) return;
        frame++;
        const t = Math.min(frame / STEPS, 1);
        const ease = t * t * (3 - 2 * t);
        const j = START.map((v, i) => v + (targetJ[i] - v) * ease);
        s.setSimJoints(j);
        if (t < 1) requestAnimationFrame(step);
        else window._simApplyRaf = false;
      }
      requestAnimationFrame(step);
      return;
    }
    
    const jStr = targetJ.map(v => v.toFixed(4)).join(',');
    const urscript = `def apply_j():\n  movej([${jStr}], a=1.2, v=0.25)\nend\n`;
    resetFreedriveUI();
    sendDirect(urscript);
  });
}

export function stopApplyJoints() {
  import('./state.js').then(s => {
    if (s.isSimulationMode) {
      window._simApplyRaf = false;
      return;
    }
    sendDirect("def stop_j():\n  stopj(2.5)\nend\n");
  });
}

// Expose to window for inline HTML event handlers
export function exposeSetup() {
  window._setup = {
    liveJoint, renamePos, addPos, deletePos,
    startMoveHere, stopMoveHere, setToCurrent, recordLivePosition,
    toggleFreedrive, openGripper, closeGripper, toggleFdAxis, activateGripper,
    hoverPos, enterEditMode, finishEditMode, startApplyJoints, stopApplyJoints,
    updateEditPreview
  };
}