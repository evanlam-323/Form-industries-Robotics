// ═══════════════════════════════════════════════════════════
// STATE — shared mutable state across all modules
// ═══════════════════════════════════════════════════════════

let _uid = 0;
export const uid = () => 'u' + (_uid++);

export let positions = [
  {id:uid(), name:'HOME',     j:[0.00,-1.5708,0.00,-1.5708,-1.5708,0.00], c:[-0.2667,-0.1304,0.6942,-1.2113,-1.2071,1.2057]},
  {id:uid(), name:'APPROACH', j:[0.00,-1.5708,0.00,-1.5708,-1.5708,0.00], c:[-0.2667,-0.1304,0.6942,-1.2113,-1.2071,1.2057]},
  {id:uid(), name:'PICK',     j:[0.00,-1.5708,0.00,-1.5708,-1.5708,0.00], c:[-0.2667,-0.1304,0.6942,-1.2113,-1.2071,1.2057]},
  {id:uid(), name:'PLACE',    j:[0.00,-1.5708,0.00,-1.5708,-1.5708,0.00], c:[-0.2667,-0.1304,0.6942,-1.2113,-1.2071,1.2057]},
];
export function setPositions(arr) { positions = arr; }

export let steps = [];
export function setSteps(arr) { steps = arr; }

// Live telemetry
export let latestJoints = null;
export let latestTcp    = null;
export function setLatestJoints(v) { latestJoints = v; }
export function setLatestTcp(v)    { latestTcp    = v; }

// Freedrive
export let isFreedrive = false;
export function setIsFreedrive(v) { isFreedrive = v; }

// Jogging (Cartesian — speedl)
export let isJogging = false;
export function setIsJogging(v) { isJogging = v; }

// Jogging (Joint — speedj)
export let isJointJogging = false;
export function setIsJointJogging(v) { isJointJogging = v; }

export let fdAxes = [1,1,1,1,1,1];
export function setFdAxis(index, val) { fdAxes[index] = val; }

// Selection
export let selectedStepId = null;
export function setSelectedStepId(id) { selectedStepId = id; }

// Telemetry state
export let isLiveMonitoring = false;
export function setIsLiveMonitoring(v) { isLiveMonitoring = v; }

// Gripper active state
export let gripperActivated = false;
export function setGripperActivated(v) { gripperActivated = v; }

// Gripper open/closed (last commanded direction)
export let isGripperOpen = true;
export function setIsGripperOpen(v) { isGripperOpen = v; }

// ── Simulation Mode ──────────────────────────────────────────
export let isSimulationMode = false;
export function setIsSimulationMode(val) { isSimulationMode = val; }

// Virtual joint state — starts at HOME position
export let simJoints = [0, -1.5708, 0, -1.5708, -1.5708, 0];
export function setSimJoints(joints) { simJoints = joints; }

// Virtual TCP state — matches HOME joint position
export let simTcp = [-0.2667, -0.1304, 0.6942, -1.2113, -1.2071, 1.2057];
export function setSimTcp(tcp) { simTcp = tcp; }

// Convenience getters — return sim or real values depending on mode
export function getCurrentJoints() {
  return isSimulationMode ? simJoints : latestJoints;
}
export function getCurrentTcp() {
  return isSimulationMode ? simTcp : latestTcp;
}

// Global settings (Default Motion, TCP, Payload settings)
export let globalSettings = {
  js: 1.05, ja: 1.4, ls: 0.25, la: 1.2, br: 0.0,
  tcpX: 0.0, tcpY: 0.0, tcpZ: 0.165, tcpRx: 0.0, tcpRy: 0.0, tcpRz: 0.0,
  plW: 0.9, plX: 0.0, plY: 0.0, plZ: 0.06
};
export function setGlobalSettings(obj) {
  globalSettings = { ...globalSettings, ...obj };
  // Re-render the 3D viewer immediately when TCP offset changes
  const tcp = globalSettings;
  import('./viewer3d.js').then(v => v.updateViewer(null, {
    x: tcp.tcpX, y: tcp.tcpY, z: tcp.tcpZ,
    rx: tcp.tcpRx, ry: tcp.tcpRy, rz: tcp.tcpRz
  }));
}

// ── Relay IP (persisted across sessions) ────────────────────
const RELAY_IP_KEY     = 'ur3e_relay_ip';
const RELAY_IP_DEFAULT = '169.254.110.37';

export function getRelayIp() {
  return localStorage.getItem(RELAY_IP_KEY) || RELAY_IP_DEFAULT;
}

export function saveRelayIp(val) {
  const clean = (val || '').trim();
  if (clean) localStorage.setItem(RELAY_IP_KEY, clean);
}