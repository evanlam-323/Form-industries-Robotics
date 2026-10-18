// ═══════════════════════════════════════════════════════════
// SIM-EXECUTOR — Execute program steps in simulation mode
// Interpolates movements smoothly and updates the 3D viewer
// ═══════════════════════════════════════════════════════════

import { steps, positions, simJoints, setSimJoints, simTcp, setSimTcp, globalSettings } from './state.js';
import { updateViewer } from './viewer3d.js';

let isRunning = false;
let isPaused = false;
let currentStepIdx = 0;
let speedMultiplier = 1.0;

function logSim(msg) {
  const el = document.getElementById('live-logs');
  if (!el) return;
  const ts = new Date().toLocaleTimeString();
  el.innerHTML += `\n<span style="color:var(--tx3)">[${ts}]</span> <span style="color:var(--ac)">[SIM]</span> ${msg}`;
  el.scrollTop = el.scrollHeight;
}

function lerpArray(a, b, t) {
  return a.map((v, i) => v + (b[i] - v) * t);
}

function getPositionJoints(posId) {
  const pos = positions.find(p => p.id === posId);
  return pos ? pos.j : null;
}

async function executeMovement(fromJoints, toJoints, durationMs) {
  return new Promise(resolve => {
    const startTime = performance.now();
    const animate = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / durationMs, 1);

      if (!isPaused) {
        const current = lerpArray(fromJoints, toJoints, progress);
        setSimJoints(current);
        updateViewer(current, {
          x: globalSettings.tcpX, y: globalSettings.tcpY, z: globalSettings.tcpZ,
          rx: globalSettings.tcpRx, ry: globalSettings.tcpRy, rz: globalSettings.tcpRz
        });
      }

      if (progress >= 1) {
        setSimJoints(toJoints);
        updateViewer(toJoints, {
          x: globalSettings.tcpX, y: globalSettings.tcpY, z: globalSettings.tcpZ,
          rx: globalSettings.tcpRx, ry: globalSettings.tcpRy, rz: globalSettings.tcpRz
        });
        resolve();
      } else if (isRunning) {
        requestAnimationFrame(animate);
      }
    };
    requestAnimationFrame(animate);
  });
}

function getMovementDuration(fromJoints, toJoints, isLinear = false) {
  const speed = isLinear ? globalSettings.ls : globalSettings.js;
  const maxDelta = Math.max(...toJoints.map((v, i) => Math.abs(v - fromJoints[i])));
  const accel = isLinear ? globalSettings.la : globalSettings.ja;
  const estimatedTime = maxDelta / (speed * speedMultiplier * 0.7) * 1000;
  return Math.max(estimatedTime, 300);
}

export async function executeProgramSim(speed = 1.0) {
  speedMultiplier = speed;

  if (isRunning && isPaused) {
    // Resume from pause
    isPaused = false;
    logSim('Program execution resumed');
    return;
  }

  if (isRunning) return;
  isRunning = true;
  isPaused = false;
  currentStepIdx = 0;

  logSim('Program execution started in simulation mode');

  try {
    while (currentStepIdx < steps.length && isRunning) {
      while (isPaused && isRunning) {
        await new Promise(r => setTimeout(r, 100));
      }
      if (!isRunning) break;

      const step = steps[currentStepIdx];
      await executeStep(step);
      currentStepIdx++;
    }

    if (isRunning) {
      logSim('Program execution completed');
    }
  } catch (err) {
    logSim(`Error during execution: ${err.message}`);
    console.error(err);
  } finally {
    isRunning = false;
  }
}

async function executeStep(step) {
  const current = simJoints;

  switch (step.type) {
    case 'movej': {
      const target = getPositionJoints(step.pid);
      if (!target) {
        logSim(`⚠ movej: Target position not found`);
        break;
      }
      logSim(`MOVEJ to ${positions.find(p => p.id === step.pid)?.name || 'unknown'}`);
      const duration = getMovementDuration(current, target, false);
      await executeMovement(current, target, duration);
      setSimJoints(target);
      break;
    }

    case 'movel': {
      const target = getPositionJoints(step.pid);
      if (!target) {
        logSim(`⚠ movel: Target position not found`);
        break;
      }
      logSim(`MOVEL to ${positions.find(p => p.id === step.pid)?.name || 'unknown'}`);
      const duration = getMovementDuration(current, target, true);
      await executeMovement(current, target, duration);
      setSimJoints(target);
      break;
    }

    case 'movec': {
      const via = getPositionJoints(step.via);
      const to = getPositionJoints(step.to);
      if (!via || !to) {
        logSim(`⚠ movec: Target positions not found`);
        break;
      }
      logSim(`MOVEC via ${positions.find(p => p.id === step.via)?.name} to ${positions.find(p => p.id === step.to)?.name}`);
      const dur1 = getMovementDuration(current, via, true);
      await executeMovement(current, via, dur1);
      const dur2 = getMovementDuration(via, to, true);
      await executeMovement(via, to, dur2);
      setSimJoints(to);
      break;
    }

    case 'sleep': {
      logSim(`WAIT ${step.sec ?? 1}s`);
      await new Promise(r => setTimeout(r, (step.sec ?? 1) * 1000));
      break;
    }

    case 'textmsg': {
      logSim(`LOG: ${step.msg ?? ''}`);
      break;
    }

    case 'set_digital_out': {
      logSim(`DOUT ${step.port ?? 0}: ${step.val !== false ? 'HIGH' : 'LOW'}`);
      break;
    }

    case 'open_gripper': {
      logSim(`GRIP: OPEN`);
      try {
        const gr = await import('./gripper3d.js');
        gr.animateGripper(0);
      } catch (err) {}
      await new Promise(r => setTimeout(r, 500));
      break;
    }

    case 'close_gripper': {
      logSim(`GRIP: CLOSE`);
      try {
        const gr = await import('./gripper3d.js');
        gr.animateGripper(0.8);
      } catch (err) {}
      await new Promise(r => setTimeout(r, 500));
      break;
    }

    case 'activate_gripper': {
      logSim(`GRIP: ACTIVATE`);
      try {
        const gr = await import('./gripper3d.js');
        gr.animateGripper(0); // initialize to open
      } catch (err) {}
      await new Promise(r => setTimeout(r, 800));
      break;
    }

    case 'comment':
    case 'popup':
    case 'set_payload':
    case 'set_tcp':
    case 'assign':
    case 'timer':
    case 'guarded_move':
      logSim(`[${step.type}] (skipped in sim)`);
      break;

    case 'read_gripper': {
      logSim(`GRIP: READ - awaiting user input for ${step.varName ?? 'part_size'}`);
      const value = prompt(`Enter value for ${step.varName ?? 'part_size'}:`, '0');
      if (value !== null) {
        logSim(`GRIP: READ - ${step.varName ?? 'part_size'} = ${value}`);
      }
      break;
    }

    case 'end':
    case 'folder':
      break;

    default:
      break;
  }
}

export function pauseSimExecution() {
  isPaused = true;
}

export function resumeSimExecution() {
  isPaused = false;
}

export function stopSimExecution() {
  isRunning = false;
  isPaused = false;
  currentStepIdx = 0;
}

export function isSimExecutionRunning() {
  return isRunning;
}
