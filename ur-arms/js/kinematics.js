// ═══════════════════════════════════════════════════════════
// KINEMATICS — UR3e forward kinematics, Jacobian, singularity
// checks and a damped-least-squares Cartesian step.
//
// Why this exists: Cartesian jogging uses speedl(), which makes the
// controller solve inverse kinematics every cycle. If the arm is at
// (or jogs into) a singular pose, the controller aborts with
// "cannot reach the requested pose / no inverse kinematic solution".
// The default HOME pose [0,-90,0,-90,-90,0] is exactly such a pose:
// elbow straight (elbow singularity) AND the wrist sits right above
// the base axis (shoulder singularity). We check before and during
// each jog so the app can stop cleanly instead of faulting.
// ═══════════════════════════════════════════════════════════

// UR3e DH parameters (Universal Robots official values)
const D  = [0.15185, 0, 0, 0.13105, 0.08535, 0.0921];
const A  = [0, -0.24355, -0.2132, 0, 0, 0];
const AL = [Math.PI / 2, 0, 0, Math.PI / 2, -Math.PI / 2, 0];

const DEG = Math.PI / 180;

// Bent "jog-ready" posture: tool pointing down, ~0.2 m in front of the
// base, with at least ±10 cm of free Cartesian travel on every axis.
// Base (J0) and wrist 3 (J5) are kept at their current values.
export const JOG_READY_DEG = [null, -110, 90, -70, -90, null];

function matMul(a, b) {
  const r = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      for (let k = 0; k < 4; k++) r[i][j] += a[i][k] * b[k][j];
  return r;
}

function dh(i, q) {
  const ct = Math.cos(q), st = Math.sin(q), ca = Math.cos(AL[i]), sa = Math.sin(AL[i]);
  return [
    [ct, -st * ca,  st * sa, A[i] * ct],
    [st,  ct * ca, -ct * sa, A[i] * st],
    [0,   sa,       ca,      D[i]],
    [0,   0,        0,       1],
  ];
}

// Returns { T, frames } — T is the 4x4 TCP pose in the base frame.
// tool = [x, y, z] translation offset of the TCP from the flange (m).
export function fk(q, tool = [0, 0, 0]) {
  let T = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
  const frames = [T];
  for (let i = 0; i < 6; i++) { T = matMul(T, dh(i, q[i])); frames.push(T); }
  T = matMul(T, [[1,0,0,tool[0]],[0,1,0,tool[1]],[0,0,1,tool[2]],[0,0,0,1]]);
  return { T, frames };
}

function rotErr(Rg, R) {
  // Small-angle rotation vector of Rg * R^T
  const M = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) M[i][j] += Rg[i][k] * R[j][k];
  const c = Math.max(-1, Math.min(1, (M[0][0] + M[1][1] + M[2][2] - 1) / 2));
  const ang = Math.acos(c);
  const v = [M[2][1] - M[1][2], M[0][2] - M[2][0], M[1][0] - M[0][1]];
  const s = Math.sin(ang);
  const k = ang < 1e-6 ? 0.5 : ang / (2 * s);
  return v.map(x => x * k);
}

function rotFromVec(r) {
  const th = Math.hypot(r[0], r[1], r[2]);
  if (th < 1e-12) return [[1,0,0],[0,1,0],[0,0,1]];
  const [x, y, z] = r.map(v => v / th);
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [
    [c + x*x*C,   x*y*C - z*s, x*z*C + y*s],
    [y*x*C + z*s, c + y*y*C,   y*z*C - x*s],
    [z*x*C - y*s, z*y*C + x*s, c + z*z*C],
  ];
}

function rotOf(T) { return [T[0].slice(0,3), T[1].slice(0,3), T[2].slice(0,3)]; }
function posOf(T) { return [T[0][3], T[1][3], T[2][3]]; }

// Geometric Jacobian (6x6) at the TCP.
export function jacobian(q, tool = [0, 0, 0]) {
  const { T, frames } = fk(q, tool);
  const p = posOf(T);
  const J = [[],[],[],[],[],[]];
  for (let i = 0; i < 6; i++) {
    const F = frames[i];
    const z = [F[0][2], F[1][2], F[2][2]];
    const o = [F[0][3], F[1][3], F[2][3]];
    const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const lin = [z[1]*d[2] - z[2]*d[1], z[2]*d[0] - z[0]*d[2], z[0]*d[1] - z[1]*d[0]];
    J[0][i] = lin[0]; J[1][i] = lin[1]; J[2][i] = lin[2];
    J[3][i] = z[0];   J[4][i] = z[1];   J[5][i] = z[2];
  }
  return J;
}

function solve(M, b) {
  // Gaussian elimination with partial pivoting (n x n)
  const n = b.length;
  const a = M.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const piv = a[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / piv;
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = a[r][n];
    for (let k = r + 1; k < n; k++) s -= a[r][k] * x[k];
    x[r] = s / (a[r][r] || 1e-12);
  }
  return x;
}

// Damped least squares: dq = J^T (J J^T + λ² I)^-1 e
function dls(J, e, lambda = 0.01) {
  const JJt = [];
  for (let i = 0; i < 6; i++) {
    JJt.push([]);
    for (let j = 0; j < 6; j++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += J[i][k] * J[j][k];
      JJt[i].push(s + (i === j ? lambda * lambda : 0));
    }
  }
  const y = solve(JJt, e);
  const dq = new Array(6).fill(0);
  for (let k = 0; k < 6; k++) for (let i = 0; i < 6; i++) dq[k] += J[i][k] * y[i];
  return dq;
}

// Named singularity check with plain-English reasons.
export function singularityReasons(q) {
  const reasons = [];
  if (Math.abs(Math.sin(q[2])) < Math.sin(8 * DEG))
    reasons.push('elbow is almost straight (arm fully stretched)');
  if (Math.abs(Math.sin(q[4])) < Math.sin(8 * DEG))
    reasons.push('wrist 2 is near 0°/180° (wrist 1 and wrist 3 lined up)');
  // Shoulder singularity: the wrist point lies in the vertical plane through
  // the base axis that is parallel to the shoulder axis. The wrist point is
  // always offset sideways by d4 (0.131 m), so measure only the in-plane
  // reach component: sqrt(rho² − d4²).
  const { frames } = fk(q);
  const w = frames[4]; // wrist-1 → wrist-2 axis point
  const rho = Math.hypot(w[0][3], w[1][3]);
  const reach = Math.sqrt(Math.max(0, rho * rho - D[3] * D[3]));
  if (reach < 0.03)
    reasons.push('the wrist is directly above the base (shoulder singularity)');
  return reasons;
}

// Simulate jogging `dist` along Cartesian axis (0..5, base frame) from q.
// Returns { ok, q, reason }. ok=false means the controller would not be
// able to follow (singularity or out of reach) within that distance.
export function previewJog(q, axis, dir, tool = [0, 0, 0], dist = null) {
  const linear = axis < 3;
  const total = dist ?? (linear ? 0.02 : 0.15);  // 2 cm or ~8.6°
  const N = 20;
  let qq = q.slice();
  const T0 = fk(qq, tool).T;
  const pGoal = posOf(T0);
  let rGoal = rotOf(T0);
  const stepLen = total / N;
  for (let s = 0; s < N; s++) {
    if (linear) {
      pGoal[axis] += dir * stepLen;
    } else {
      const r = [0, 0, 0]; r[axis - 3] = dir * stepLen;
      const dR = rotFromVec(r);
      const nr = [[0,0,0],[0,0,0],[0,0,0]];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) nr[i][j] += dR[i][k] * rGoal[k][j];
      rGoal = nr;
    }
    // two Newton iterations per step
    for (let it = 0; it < 2; it++) {
      const T = fk(qq, tool).T;
      const p = posOf(T);
      const e = [pGoal[0] - p[0], pGoal[1] - p[1], pGoal[2] - p[2], ...rotErr(rGoal, rotOf(T))];
      const dq = dls(jacobian(qq, tool), e, 0.002);
      const maxDq = Math.max(...dq.map(Math.abs));
      // Joint step per mm (or per 0.0075 rad) blowing up = singular
      if (maxDq > 0.2) return { ok: false, q: qq, reason: 'joint speeds would spike (singularity ahead)' };
      qq = qq.map((v, i) => v + dq[i]);
    }
  }
  const T = fk(qq, tool).T;
  const p = posOf(T);
  const posErr = Math.hypot(pGoal[0] - p[0], pGoal[1] - p[1], pGoal[2] - p[2]);
  const rotE = Math.hypot(...rotErr(rGoal, rotOf(T)));
  if (posErr > 0.002 || rotE > 0.01) return { ok: false, q: qq, reason: 'that direction is outside the reachable workspace from here' };
  const sing = singularityReasons(qq);
  if (sing.length) return { ok: false, q: qq, reason: sing.join('; ') };
  return { ok: true, q: qq };
}

// One sim-mode jog increment: returns the new joint vector (or null if blocked).
export function cartesianStep(q, axis, dir, amount, tool = [0, 0, 0]) {
  const res = previewJog(q, axis, dir, tool, amount);
  return res.ok ? res.q : null;
}

// Convert a rotation matrix to a UR rotation vector [rx, ry, rz].
export function rotvecFromT(T) {
  return rotErr(rotOf(T), [[1,0,0],[0,1,0],[0,0,1]]);
}

export function tcpPose(q, tool = [0, 0, 0]) {
  const { T } = fk(q, tool);
  return [...posOf(T), ...rotvecFromT(T)];
}

export function jogReadyTarget(q) {
  return JOG_READY_DEG.map((d, i) => d === null ? q[i] : d * DEG);
}

// Joint speeds needed to hold a constant Cartesian jog speed along the next
// `dist` of travel. speedl() keeps the TCP speed constant, so as the arm
// nears full stretch / a singularity the joints have to spin faster and
// faster — that is the "it speeds up while I hold the button" effect.
// Returns { ok, maxW (rad/s), joint, reason }.
export function jogJointSpeeds(q, axis, dir, tool = [0, 0, 0], speed = 0.05, dist = null, N = 8) {
  const total = dist ?? (axis < 3 ? 0.02 : 0.15);
  const step = total / N;
  let qq = q.slice(), maxW = 0, joint = -1;
  for (let i = 0; i < N; i++) {
    const r = previewJog(qq, axis, dir, tool, step);
    for (let j = 0; j < 6; j++) {
      const w = Math.abs(r.q[j] - qq[j]) / step * speed;
      if (w > maxW) { maxW = w; joint = j; }
    }
    if (!r.ok) return { ok: false, maxW, joint, reason: r.reason };
    qq = r.q;
  }
  return { ok: true, maxW, joint };
}
