// ═══════════════════════════════════════════════════════════
// PROGRAM-VALIDATOR — semantic validation for AI-generated program JSON
//
// This is the "human/simulator validates before it runs" gate for
// Stage 2. Gemini's JSON-mode output is guaranteed to be *syntactically*
// valid JSON, but nothing guarantees it matches our actual step schema,
// references real positions, or has balanced block nesting. This module
// checks all of that before anything is allowed to merge into state.js.
//
// No dependencies. Mirrors the real schema used by tab-program.js
// (defaultStep / TAG_INFO), which is the source of truth for the app —
// not just the AI's prompt spec, which could drift.
// ═══════════════════════════════════════════════════════════

// Matches the real OPENERS constant in tab-program.js exactly (including
// legacy types that don't appear in the current palette but may still
// exist in older saved projects and must not be flagged as "unknown").
const BLOCK_OPENERS = ['loop_start', 'loop_n', 'loop_forever', 'loop_while', 'if_start', 'if_din', 'thread_start', 'folder'];

// type -> { required: [ [key, validator, label] ] }
const isNum  = v => typeof v === 'number' && Number.isFinite(v);
const isStr  = v => typeof v === 'string';
const isBool = v => typeof v === 'boolean';
const isAny  = () => true;

// Two tiers, matched against the REAL URScript compiler (buildCode() in
// tab-program.js), not just a spec doc:
//   HARD  — fields with NO fallback in codegen. Missing/invalid here
//           produces genuinely broken URScript (e.g. "if (undefined):")
//           or silently drops meaningful logic. These block Apply.
//   SOFT  — fields the compiler defaults via `??` (e.g. `s.sec ?? 1.0`,
//           `s.weight ?? 0`). Missing here is safe and matches the app's
//           own tolerant behavior — only flagged as a warning, and only
//           when the value is PRESENT but the wrong type.
const HARD_SCHEMA = {
  movej:            { pid: isStr },
  movel:            { pid: isStr },
  movec:            { via: isStr, to: isStr },
  if_start:         { condition: isStr },
  else_if:          { condition: isStr },
  wait_cond:        { condition: isStr },
  thread_start:     { threadName: isStr },
  assign:           { varName: isStr, varValue: isStr },
  // loop_start's loopCount requirement is conditional (only when
  // loopType === 'times') and is handled as a special case below.
};

const SOFT_SCHEMA = {
  guarded_move:     { speed: isNum, retract: isNum },
  loop_start:       { loopType: v => v === 'forever' || v === 'times', loopCount: isNum },
  read_gripper:     { varName: isStr },
  sleep:            { sec: isNum },
  textmsg:          { msg: isStr },
  popup:            { msg: isStr, pType: isStr },
  set_digital_out:  { port: isNum, val: isBool },
  set_payload:      { weight: isNum },
  set_tcp:          { pose: isStr },
  comment:          { commentTxt: isStr },
  folder:           { folderName: isStr },
  timer:            { timerAct: v => v === 'start' || v === 'read', timerVar: isStr },
  else_if:          {},
};

// All recognized step types (for the "unknown type" check) — union of
// hard/soft schemas plus types with no fields at all.
const STEP_SCHEMA = {
  ...HARD_SCHEMA, ...SOFT_SCHEMA,
  activate_gripper: {}, open_gripper: {}, close_gripper: {}, else: {}, end: {}, halt: {},
  loop_n: {}, loop_forever: {}, loop_while: {}, if_din: {},
  // Utility steps present in the palette but with no required code-gen fields:
  set_gravity: {}, zero_ftsensor: {}, set_baselight: {},
};

const REF_FIELDS = {
  movej: ['pid'], movel: ['pid'], movec: ['via', 'to'],
};

function isJointArray(v) {
  return Array.isArray(v) && v.length === 6 && v.every(isNum);
}

/**
 * Validate an AI-generated program object.
 * @param {object} program - parsed JSON: { positions, steps, settings }
 * @param {Array}  existingPositions - the user's current positions (from state.js),
 *                 so pid/via/to referencing an already-saved position is allowed.
 * @returns {{ ok: boolean, errors: string[], warnings: string[], summary: object }}
 */
export function validateProgram(program, existingPositions = []) {
  const errors = [];
  const warnings = [];

  if (!program || typeof program !== 'object' || Array.isArray(program)) {
    return { ok: false, errors: ['Top-level response is not a JSON object.'], warnings: [], summary: null };
  }

  const { positions, steps, settings } = program;

  // ── Top-level shape ──
  if (!Array.isArray(positions)) errors.push('"positions" must be an array (missing or wrong type).');
  if (!Array.isArray(steps))     errors.push('"steps" must be an array (missing or wrong type).');
  if (settings !== undefined && (typeof settings !== 'object' || Array.isArray(settings))) {
    errors.push('"settings" must be an object if present.');
  }
  Object.keys(program).forEach(k => {
    if (!['positions', 'steps', 'settings'].includes(k)) {
      warnings.push(`Unexpected top-level key "${k}" — ignored.`);
    }
  });

  if (errors.length) return { ok: false, errors, warnings, summary: null };

  // ── Positions ──
  const posIds = new Set();
  const seenPosIds = new Set();
  (positions || []).forEach((p, i) => {
    const tag = `positions[${i}]`;
    if (!p || typeof p !== 'object') { errors.push(`${tag} is not an object.`); return; }
    if (!isStr(p.id) || !p.id) { errors.push(`${tag}.id must be a non-empty string.`); }
    else {
      if (seenPosIds.has(p.id)) errors.push(`${tag}.id "${p.id}" is duplicated within the generated positions.`);
      seenPosIds.add(p.id);
      posIds.add(p.id);
    }
    if (!isStr(p.name) || !p.name) errors.push(`${tag}.name must be a non-empty string.`);
    if (!isJointArray(p.j)) errors.push(`${tag}.j must be an array of 6 numbers (radians).`);
    // 'c' (Cartesian pose) is optional — buildCode() falls back to 'j' when c is absent or all-zeros.
    if (p.c !== undefined && !isJointArray(p.c)) warnings.push(`${tag}.c is present but not a valid 6-number array — the app will use joint angles instead.`);
  });

  // Combined pool of valid position ids: existing (from state.js) + newly generated
  const existingIds = new Set((existingPositions || []).map(p => p.id));
  const allKnownPosIds = new Set([...existingIds, ...posIds]);

  // ── Steps ──
  const seenStepIds = new Set();
  const blockStack = []; // stack of { type, index }

  (steps || []).forEach((s, i) => {
    const tag = `steps[${i}]`;
    if (!s || typeof s !== 'object') { errors.push(`${tag} is not an object.`); return; }

    if (!isStr(s.id) || !s.id) {
      errors.push(`${tag}.id must be a non-empty string.`);
    } else {
      if (seenStepIds.has(s.id)) errors.push(`${tag}.id "${s.id}" is duplicated within the generated steps.`);
      seenStepIds.add(s.id);
    }

    const schema = STEP_SCHEMA[s.type];
    if (!schema) {
      errors.push(`${tag} has unknown type "${s.type}".`);
      return;
    }

    // HARD fields: must be present and correctly typed, or Apply is blocked.
    const hard = HARD_SCHEMA[s.type];
    if (hard) {
      Object.entries(hard).forEach(([key, check]) => {
        if (!(key in s)) {
          errors.push(`${tag} (${s.type}) is missing required field "${key}" — the generated program would not run correctly without it.`);
        } else if (!check(s[key])) {
          errors.push(`${tag} (${s.type}) field "${key}" has an invalid value: ${JSON.stringify(s[key])}.`);
        }
      });
    }

    // SOFT fields: the app itself defaults these safely if missing (see
    // buildCode() in tab-program.js), so absence is fine — only flag if
    // present with an unusable type.
    const soft = SOFT_SCHEMA[s.type];
    if (soft) {
      Object.entries(soft).forEach(([key, check]) => {
        if (key in s && !check(s[key])) {
          warnings.push(`${tag} (${s.type}) field "${key}" has an unexpected value (${JSON.stringify(s[key])}) — the app will fall back to a default, but you may want to check it.`);
        }
      });
    }

    // loop_start.loopCount is the one truly conditional hard requirement:
    // only needed when loopType is explicitly "times" (no fallback exists
    // in that branch of the compiler).
    if (s.type === 'loop_start' && s.loopType === 'times' && !isNum(s.loopCount)) {
      errors.push(`${tag} (loop_start) has loopType "times" but loopCount is missing or not a number — this would generate broken URScript.`);
    }

    // Position references
    (REF_FIELDS[s.type] || []).forEach(field => {
      const ref = s[field];
      if (isStr(ref) && ref && !allKnownPosIds.has(ref)) {
        errors.push(`${tag} (${s.type}) references unknown position id "${ref}" in "${field}".`);
      }
    });

    // Block nesting — mirrors tab-program.js's actual depth algorithm
    // (a clamped running counter, NOT a strict typed stack). That means:
    //   - an "end" with nothing open is tolerated (depth just stays at 0),
    //     it does NOT invalidate the program — only a NOTE, not an error.
    //   - only a block that's still open when the steps run out is a real
    //     problem (that's the one case the app itself can't compile/run).
    if (BLOCK_OPENERS.includes(s.type)) {
      blockStack.push({ type: s.type, index: i });
    } else if (s.type === 'end') {
      if (blockStack.length === 0) {
        warnings.push(`${tag} is an "end" with nothing currently open — it has no effect (matches the app's own tolerant behavior, but may indicate a misplaced block).`);
      } else {
        blockStack.pop();
      }
    } else if (s.type === 'else_if' || s.type === 'else') {
      const top = blockStack[blockStack.length - 1];
      if (!top || (top.type !== 'if_start' && top.type !== 'if_din')) {
        warnings.push(`${tag} (${s.type}) does not appear to be inside an open "if_start" block.`);
      }
    }
  });

  // Only genuinely-unclosed blocks are hard errors — an extra/stray "end"
  // is not, since the app's own compiler tolerates it (see above).
  if (blockStack.length > 0) {
    blockStack.forEach(b => {
      errors.push(`steps[${b.index}] ("${b.type}") is never closed with a matching "end".`);
    });
  }

  const summary = {
    newPositions: (positions || []).length,
    newSteps: (steps || []).length,
    settingsProvided: !!settings,
  };

  return { ok: errors.length === 0, errors, warnings, summary };
}