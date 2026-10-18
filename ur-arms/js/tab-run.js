// ═══════════════════════════════════════════════════════════
// TAB-RUN — dashboard controls, log viewer, save/load
// ═══════════════════════════════════════════════════════════
import { positions, steps, setPositions, setSteps, uid } from './state.js';
import { RELAY, dashPause, dashStop, dashSpeed, setDot } from './network.js';
import { renderPositions } from './tab-setup.js';
import { renderSteps, refreshCode, buildCode } from './tab-program.js';

const inputIds = {
  js: 'settings-js',
  ja: 'settings-ja',
  ls: 'settings-ls',
  la: 'settings-la',
  br: 'settings-br',
  tcpX: 'settings-tcp-x',
  tcpY: 'settings-tcp-y',
  tcpZ: 'settings-tcp-z',
  tcpRx: 'settings-tcp-rx',
  tcpRy: 'settings-tcp-ry',
  tcpRz: 'settings-tcp-rz',
  plW: 'settings-pl-w',
  plX: 'settings-pl-x',
  plY: 'settings-pl-y',
  plZ: 'settings-pl-z'
};

function initSettingsInputs() {
  import('./state.js').then(s => {
    for (const [stateKey, inputId] of Object.entries(inputIds)) {
      const el = document.getElementById(inputId);
      if (el) {
        el.value = s.globalSettings[stateKey];
        el.addEventListener('input', () => {
          s.setGlobalSettings({ [stateKey]: parseFloat(el.value) || 0 });
          refreshCode();
        });
      }
    }
  });
}

export function initRunTab() {
  // Speed slider
  const slider = document.getElementById('dash-speed-slider');
  const label  = document.getElementById('speed-label');
  if (slider) {
    slider.addEventListener('input', () => {
      label.textContent = slider.value + '%';
      dashSpeed(+slider.value);
    });
  }

  // Simulation Mode Toggle
  const simBtn = document.getElementById('dash-sim-btn');
  if (simBtn) {
    simBtn.addEventListener('click', () => {
      import('./state.js').then(s => {
        s.setIsSimulationMode(!s.isSimulationMode);
        
        if (s.isSimulationMode) {
          simBtn.style.background = 'var(--ac)'; // Highlight with your accent color
          simBtn.style.borderColor = 'var(--ac)';
          simBtn.innerHTML = 'SIM: ON';
          logLine('Simulation Mode ENABLED. Hardware disconnected from viewer.');
        } else {
          simBtn.style.background = ''; // Reset to default styling
          simBtn.style.borderColor = '';
          simBtn.innerHTML = 'SIM: OFF';
          logLine('Simulation Mode DISABLED. Live telemetry restored.');
        }
      });
    });
  }

  // Dashboard play/pause/stop
  document.getElementById('dash-play')?.addEventListener('click',  playProgram);
  document.getElementById('dash-pause')?.addEventListener('click', dashPauseOrSim);
  document.getElementById('dash-stop')?.addEventListener('click',  dashStopOrSim);

  // Save / load project
  document.getElementById('btn-save-project')?.addEventListener('click', exportProject);
  document.getElementById('file-import-project')?.addEventListener('change', e => importProject(e.target));

  // Initialize defaults inputs
  initSettingsInputs();

  // Start log polling
  startLogPoller();
  startUiLogPoller();
}

async function dashPauseOrSim() {
  const simMode = (await import('./state.js')).isSimulationMode;
  if (simMode) {
    const { pauseSimExecution } = await import('./sim-executor.js');
    pauseSimExecution();
    logLine('Simulation paused');
  } else {
    dashSpeed(0);
    window._isPausedBySpeed = true;
    logLine('Hardware execution paused (speed set to 0%).');
    const btn = document.getElementById('dash-play');
    if (btn) btn.innerHTML = '▶︎ RESUME';
  }
}

async function dashStopOrSim() {
  const simMode = (await import('./state.js')).isSimulationMode;
  if (simMode) {
    const { stopSimExecution } = await import('./sim-executor.js');
    stopSimExecution();
    logLine('Simulation stopped');
  } else {
    dashStop();
    window._isPausedBySpeed = false;
  }
}

/**
 * SMART PLAY:
 * In sim mode: Execute program visually in the 3D viewer
 * In real mode: If paused, resume via Port 29999. If stopped, send fresh code.
 */
async function playProgram() {
  const simMode = (await import('./state.js')).isSimulationMode;

  // ── SIMULATION MODE: Execute in viewer ──
  if (simMode) {
    const { executeProgramSim } = await import('./sim-executor.js');
    const btn = document.getElementById('dash-play');
    btn.innerHTML = '▶︎ RUNNING...';
    btn.disabled = true;

    // Get speed multiplier from slider
    const sliderEl = document.getElementById('dash-speed-slider');
    const speedMult = sliderEl ? parseFloat(sliderEl.value) / 100 : 1.0;

    logLine(`Starting simulation mode execution at ${Math.round(speedMult * 100)}% speed...`);
    try {
      await executeProgramSim(speedMult);
      btn.innerHTML = '▶︎ COMPLETE';
      btn.style.background = 'var(--gn)';
      btn.style.borderColor = 'var(--gn)';
    } catch (err) {
      logLine(`Simulation error: ${err.message}`);
      btn.innerHTML = '✕ ERROR';
      btn.style.background = 'var(--rd)';
    } finally {
      setTimeout(() => {
        btn.innerHTML = '▶︎';
        btn.style.background = '';
        btn.style.borderColor = '';
        btn.disabled = false;
      }, 2000);
    }
    return;
  }

  // ── REAL MODE ──
  const ip = document.getElementById('robot-ip').value.trim();
  if (!ip) {
    alert('Enter the robot IP address first.');
    return;
  }

  const btn = document.getElementById('dash-play');
  const originalText = btn.innerHTML;
  
  // 1. Check if the robot is currently in a paused state
  const logs = document.getElementById('live-logs');
  const isNativePaused = logs && logs._lastStatus && logs._lastStatus.toLowerCase().includes('paused');

  if (window._isPausedBySpeed || isNativePaused) {
    // ── RESUME EXISTING PROGRAM ──
    btn.innerHTML = '▶︎ RESUMING...';
    btn.disabled = true;
    logLine('Resuming paused program...');
    
    const sliderEl = document.getElementById('dash-speed-slider');
    const speedVal = sliderEl ? parseFloat(sliderEl.value) : 100;
    dashSpeed(speedVal);
    window._isPausedBySpeed = false;
    
    try {
      if (isNativePaused) {
        const res = await fetch(RELAY, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'dashboard_play', ip: ip })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
      }
      
      btn.innerHTML = '▶︎ RUNNING!';
      btn.style.background = 'var(--gn)';
      btn.style.borderColor = 'var(--gn)';
      logLine('Program resumed successfully.');
    } catch(e) {
      logLine(`Error resuming program: ${e.message}`);
    } finally {
      setTimeout(() => {
        btn.innerHTML = originalText;
        btn.style.background = '';
        btn.style.borderColor = '';
        btn.disabled = false;
      }, 2500);
    }
    return; // Exit early so we don't send the new script!
  }

  // ── COMPILE AND SEND NEW PROGRAM (Port 30002) ──
  btn.innerHTML = '▶︎ SENDING...';
  btn.disabled = true;
  setDot('sending');
  logLine('Compiling and sending new program to robot...');

  try {
    let finalScript = buildCode(); 
    
    // Grab the slider value (e.g., 50% -> 0.50)
    const sliderEl = document.getElementById('dash-speed-slider');
    const multiplier = sliderEl ? parseFloat(sliderEl.value) / 100 : 1.0;

    // 🎯 THE FIX: Mathematically scale the configuration variables in the code!
    if (multiplier !== 1.0) {
      finalScript = finalScript
        .replace(/global JOINT_SPEED\s*=\s*([0-9.]+)/, (match, val) => `global JOINT_SPEED = ${(parseFloat(val) * multiplier).toFixed(4)}`)
        .replace(/global JOINT_ACCEL\s*=\s*([0-9.]+)/, (match, val) => `global JOINT_ACCEL = ${(parseFloat(val) * multiplier).toFixed(4)}`)
        .replace(/global LINEAR_SPEED\s*=\s*([0-9.]+)/, (match, val) => `global LINEAR_SPEED = ${(parseFloat(val) * multiplier).toFixed(4)}`)
        .replace(/global LINEAR_ACCEL\s*=\s*([0-9.]+)/, (match, val) => `global LINEAR_ACCEL = ${(parseFloat(val) * multiplier).toFixed(4)}`);
    }

    const res = await fetch(RELAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: ip, code: finalScript }) 
    });
    
    const data = await res.json();
    
    if (data.ok) {
      setDot('ok');
      btn.innerHTML = '▶︎ RUNNING!';
      btn.style.background = 'var(--gn)';
      btn.style.borderColor = 'var(--gn)';
      logLine(`Program accepted. Execution scaled to ${Math.round(multiplier * 100)}% speed.`);
    } else {
      throw new Error(data.error || 'Robot rejected the script');
    }
  } catch(e) {
    setDot('err');
    btn.innerHTML = '✕ FAILED';
    btn.style.background = 'var(--rd)';
    logLine(`Error sending program: ${e.message}`);
    alert(`Failed to send program:\n${e.message}`);
  } finally {
    setTimeout(() => {
      btn.innerHTML = originalText;
      btn.style.background = '';
      btn.style.borderColor = '';
      btn.disabled = false;
    }, 2500);
  }
}

function exportProject() {
  import('./state.js').then(s => {
    const data = { positions, steps, settings: s.globalSettings };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}));
    a.download = 'ur3e_project.json';
    a.click();
  });
}

function importProject(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.positions) setPositions(data.positions);
      if (data.steps) {
        const fixed = data.steps.map(s => ({ ...s, id: s.id || uid() }));
        setSteps(fixed);
      }
      import('./state.js').then(s => {
        if (data.settings) {
          s.setGlobalSettings(data.settings);
          for (const [stateKey, inputId] of Object.entries(inputIds)) {
            const el = document.getElementById(inputId);
            if (el) el.value = s.globalSettings[stateKey] ?? el.value;
          }
        }
        renderPositions();
        renderSteps();
        refreshCode();
        logLine('Project loaded successfully.');
      });
    } catch(err) {
      alert("Error loading project: " + err);
    }
  };
  reader.readAsText(file);
  input.value = '';
}

function logLine(msg) {
  const el = document.getElementById('live-logs');
  if (!el) return;
  const ts = new Date().toLocaleTimeString();
  el.innerHTML += `\n<span style="color:var(--tx3)">[${ts}]</span> ${msg}`;
  el.scrollTop = el.scrollHeight;
}

function startLogPoller() {
  async function poll() {
    const ip = document.getElementById('robot-ip').value.trim();
    if (ip) {
      try {
        const res  = await fetch(RELAY, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({action:'dashboard_status', ip})
        });
        const data = await res.json();
        if (data.ok && data.raw) {
          const el = document.getElementById('live-logs');
          // Only update if status actually changed
          if (el && el._lastStatus !== data.raw) {
            el._lastStatus = data.raw;
            logLine(`Robot status: ${data.raw.trim()}`);
          }
        }
      } catch(e) { /* silent */ }
    }
    setTimeout(poll, 2000);
  }
  setTimeout(poll, 2000);
}

function startUiLogPoller() {
  async function poll() {
    try {
      const res = await fetch(RELAY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fetch_logs' })
      });
      const data = await res.json();
      
      // If Python sends back an array of messages, print each one!
      if (data.ok && data.logs && data.logs.length > 0) {
        data.logs.forEach(msg => logLine(`[Robot] ${msg}`));
      }
    } catch(e) { 
      /* silently ignore network drops */ 
    }
    // Poll twice a second for near-instant updates
    setTimeout(poll, 500); 
  }
  setTimeout(poll, 1000);
}