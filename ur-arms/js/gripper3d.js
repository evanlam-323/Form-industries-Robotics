// ═══════════════════════════════════════════════════════════
// GRIPPER 3D — Robotiq 2F-85 gripper visualization
//
// Joint data from: robotiq_arg2f_85_model.urdf (ros-industrial)
// Meshes are authored in mm → URDF uses scale="0.001 0.001 0.001"
// All joint xyz values are already in metres in the URDF.
//
// Drive joint: finger_joint  q ∈ [0, 0.8] rad
//   0.0 = fully open
//   0.8 = fully closed
//
// Mimic joints (all driven by q):
//   left_outer_knuckle:  +q  (via finger_joint itself)
//   left_inner_knuckle:  +q
//   left_inner_finger:   -q  (counter-rotates)
//   right_outer_knuckle: +q
//   right_inner_knuckle: +q
//   right_inner_finger:  -q
// ═══════════════════════════════════════════════════════════

const PI = Math.PI;
const GRIPPER_URL = 'https://nwenzel28.github.io/ur-arms/meshes/gripper/robotiq_arg2f_85_';

// ── Scene references (set by initGripper) ──────────────────
let _THREE = null;
let _scene  = null;
let _gripperRoot = null;   // Group parented to the arm's wrist3 frame
let _meshesReady = false;
let _currentQ    = 0;      // Current drive angle

// ── Link groups — set during load ──────────────────────────
// Each is a THREE.Group positioned at its joint origin.
// Children are the mesh objects with their visual origin applied.
let g = {
  base:              null,
  left_outer_knuckle:  null,
  left_outer_finger:   null,
  left_inner_knuckle:  null,
  left_inner_finger:   null,
  left_pad:            null,
  right_outer_knuckle: null,
  right_outer_finger:  null,
  right_inner_knuckle: null,
  right_inner_finger:  null,
  right_pad:           null,
};

// ── URDF joint origins (metres, RPY) ──────────────────────
// Format: [x, y, z, rx, ry, rz]
// Parent → Child
const JOINT_ORIGINS = {
  // base_link → left_outer_knuckle  (finger_joint, drive)
  left_outer_knuckle:  [0, -0.0306011, 0.054904, 0, 0, PI],
  // left_outer_knuckle → left_outer_finger  (fixed)
  left_outer_finger:   [0,  0.0315,   -0.0041,   0, 0, 0],
  // base_link → left_inner_knuckle  (mimic +1)
  left_inner_knuckle:  [0, -0.0127,    0.06142,  0, 0, PI],
  // left_outer_finger → left_inner_finger  (mimic -1)
  left_inner_finger:   [0,  0.0061,    0.0471,   0, 0, 0],
  // left_inner_finger → left_pad  (fixed)
  left_pad:            [0, 0,   0,  0, 0, 0],

  // base_link → right_outer_knuckle  (mimic +1, NO rpy flip)
  right_outer_knuckle: [0,  0.0306011, 0.054904, 0, 0, 0],
  // right_outer_knuckle → right_outer_finger  (fixed)
  right_outer_finger:  [0,  0.0315,   -0.0041,   0, 0, 0],
  // base_link → right_inner_knuckle  (mimic +1)
  right_inner_knuckle: [0,  0.0127,    0.06142,  0, 0, 0],
  // right_outer_finger → right_inner_finger  (mimic -1)
  right_inner_finger:  [0,  0.0061,    0.0471,   0, 0, 0],
  // right_inner_finger → right_pad  (fixed)
  right_pad:           [0, 0,   0,  0, 0, 0],
};

// ── Mesh visual origins from URDF (all zero for this URDF) ─
// All <visual><origin> entries in robotiq_arg2f_85_model.urdf are 0,0,0 / 0,0,0
// so no additional offset is needed inside each link group.

// ── Mesh filenames ──────────────────────────────────────────
// pad.dae is used for both inner_finger_pad links
const MESH_FILES = {
  base:              'base_link.dae',
  left_outer_knuckle:  'outer_knuckle.dae',
  left_outer_finger:   'outer_finger.dae',
  left_inner_knuckle:  'inner_knuckle.dae',
  left_inner_finger:   'inner_finger.dae',
  left_pad:            'pad.dae',
  right_outer_knuckle: 'outer_knuckle.dae',
  right_outer_finger:  'outer_finger.dae',
  right_inner_knuckle: 'inner_knuckle.dae',
  right_inner_finger:  'inner_finger.dae',
  right_pad:           'pad.dae',
};

// ── Material colours matching the real gripper ─────────────
const MAT_DARK  = () => new _THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.6, metalness: 0.4 });
const MAT_LIGHT = () => new _THREE.MeshStandardMaterial({ color: 0xc8ccd8, roughness: 0.5, metalness: 0.3 });
const MAT_PAD   = () => new _THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.9, metalness: 0.05 });

const LINK_MATERIAL = {
  base:              MAT_DARK,
  left_outer_knuckle:  MAT_LIGHT,
  left_outer_finger:   MAT_DARK,
  left_inner_knuckle:  MAT_DARK,
  left_inner_finger:   MAT_DARK,
  left_pad:            MAT_PAD,
  right_outer_knuckle: MAT_LIGHT,
  right_outer_finger:  MAT_DARK,
  right_inner_knuckle: MAT_DARK,
  right_inner_finger:  MAT_DARK,
  right_pad:           MAT_PAD,
};

// ── Helper: build a Matrix4 from [x,y,z,rx,ry,rz] ─────────
function originMat(o) {
  const q = new _THREE.Quaternion()
    .setFromEuler(new _THREE.Euler(o[3], o[4], o[5], 'ZYX'));
  const m = new _THREE.Matrix4();
  m.compose(new _THREE.Vector3(o[0], o[1], o[2]), q, new _THREE.Vector3(1,1,1));
  return m;
}

// ── Public: initialise gripper ─────────────────────────────
// Call once after arm meshes have loaded.
// THREE and scene come from viewer3d.
export async function initGripper(THREE, scene) {
  _THREE = THREE;
  _scene = scene;

  // Root group — viewer3d will call setGripperRoot() each frame
  // to parent this to the wrist3 transform
  _gripperRoot = new THREE.Group();
  scene.add(_gripperRoot);

  // Build link group hierarchy
  Object.keys(g).forEach(name => {
    g[name] = new THREE.Group();
  });

  // Parent hierarchy matches URDF:
  _gripperRoot.add(g.base);
  g.base.add(g.left_outer_knuckle);
  g.left_outer_knuckle.add(g.left_outer_finger);
  g.left_outer_finger.add(g.left_inner_finger);
  g.left_inner_finger.add(g.left_pad);
  g.base.add(g.left_inner_knuckle);

  g.base.add(g.right_outer_knuckle);
  g.right_outer_knuckle.add(g.right_outer_finger);
  g.right_outer_finger.add(g.right_inner_finger);
  g.right_inner_finger.add(g.right_pad);
  g.base.add(g.right_inner_knuckle);

  // Apply fixed joint origins to all non-drive groups
  // (Drive joints are set each frame in updateGripperAngle)
  applyFixedOrigin('left_outer_finger',   g.left_outer_finger);
  applyFixedOrigin('left_pad',            g.left_pad);
  applyFixedOrigin('right_outer_finger',  g.right_outer_finger);
  applyFixedOrigin('right_pad',           g.right_pad);

  await loadGripperMeshes();
  _meshesReady = true;
  updateGripperAngle(0); // start open
}

function applyFixedOrigin(name, group) {
  const o = JOINT_ORIGINS[name];
  if (!o) return;
  const q = new _THREE.Quaternion()
    .setFromEuler(new _THREE.Euler(o[3], o[4], o[5], 'ZYX'));
  group.position.set(o[0], o[1], o[2]);
  group.quaternion.copy(q);
}

// ── Load all meshes via ColladaLoader ──────────────────────
function loadGripperMeshes() {
  const loader = new _THREE.ColladaLoader();

  const tasks = Object.keys(MESH_FILES).map(linkName => new Promise(resolve => {
    const url = GRIPPER_URL + MESH_FILES[linkName];
    loader.load(url, collada => {
      const obj = collada.scene;
      const mat = LINK_MATERIAL[linkName]();
      obj.traverse(child => {
        if (child.isMesh) {
          child.material = mat;
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      
      // Meshes are in mm → scale to metres
      obj.scale.set(0.001, 0.001, 0.001);
      
      // 🎯 FIX 2: Remove the conditional 90-degree rotations.
      // All meshes from this URDF share the same local coordinate system. 
      // Setting them all to 0 allows the JOINT_ORIGINS to do their job.
      obj.rotation.set(0, 0, 0);
      
      g[linkName].add(obj);
      resolve();
    }, undefined, err => {
      console.warn(`[Gripper] Failed to load ${MESH_FILES[linkName]}:`, err);
      resolve();
    });
  }));

  return Promise.all(tasks);
}

// ── Public: set gripper world transform ───────────────────
// Called every frame from viewer3d with the wrist3 world matrix.
export function setGripperTransform(wrist3Matrix) {
  if (!_gripperRoot) return;
  
  // 🎯 FIX 1: UR3e Tool Flange Offset
  // wrist3 origin is deep inside the cylinder. Move the gripper out 92mm to the mounting plate.
  // Note: Standard UR kinematics point the tool flange along the Z-axis. 
  // (If your specific arm mesh uses Y-out, change this to 0, 0.092, 0)
  const flangeOffset = new _THREE.Matrix4().makeTranslation(0, 0, 0); 
  const toolMatrix = wrist3Matrix.clone().multiply(flangeOffset);

  const p = new _THREE.Vector3();
  const q = new _THREE.Quaternion();
  const s = new _THREE.Vector3();
  
  // Decompose the new offset matrix instead of the raw wrist matrix
  toolMatrix.decompose(p, q, s);
  
  _gripperRoot.position.copy(p);
  _gripperRoot.quaternion.copy(q);
}

// ── Public: animate to open or closed ─────────────────────
// targetQ: 0 = open, 0.8 = closed
export function animateGripper(targetQ, durationMs = 400) {
  if (!_meshesReady) return;
  const startQ   = _currentQ;
  const startT   = performance.now();
  const delta    = targetQ - startQ;

  function step(now) {
    const t    = Math.min((now - startT) / durationMs, 1);
    const ease = t * t * (3 - 2 * t); // smooth-step
    updateGripperAngle(startQ + delta * ease);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── Core: apply drive angle q to all joints ───────────────
function updateGripperAngle(q) {
  if (!_THREE || !_meshesReady) return;
  _currentQ = q;

  // Left side — outer_knuckle: +q around X, origin has rpy=[0,0,π]
  setJointAngle(g.left_outer_knuckle, JOINT_ORIGINS.left_outer_knuckle,  q);
  setJointAngle(g.left_inner_knuckle, JOINT_ORIGINS.left_inner_knuckle,  q);
  setJointAngle(g.left_inner_finger,  JOINT_ORIGINS.left_inner_finger,  -q);

  // Right side — outer_knuckle: +q around X, origin has rpy=[0,0,0]
  setJointAngle(g.right_outer_knuckle, JOINT_ORIGINS.right_outer_knuckle,  q);
  setJointAngle(g.right_inner_knuckle, JOINT_ORIGINS.right_inner_knuckle,  q);
  setJointAngle(g.right_inner_finger,  JOINT_ORIGINS.right_inner_finger,  -q);
}

// Apply joint origin offset then rotate around local X by angle
function setJointAngle(group, origin, angle) {
  const o = origin;
  // Base orientation from joint origin rpy
  const baseQ = new _THREE.Quaternion()
    .setFromEuler(new _THREE.Euler(o[3], o[4], o[5], 'ZYX'));
  // Joint rotation around local X
  const jointQ = new _THREE.Quaternion()
    .setFromAxisAngle(new _THREE.Vector3(1, 0, 0), angle);
  group.position.set(o[0], o[1], o[2]);
  // Apply: first the origin orientation, then the joint rotation
  group.quaternion.copy(baseQ).multiply(jointQ);
}

// ── Public: get current angle ──────────────────────────────
export function getGripperAngle() { return _currentQ; }