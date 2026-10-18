// ═══════════════════════════════════════════════════════════
// PROGRAM-PATCHER — apply targeted patch ops to an existing step list
//
// Stage 3 (targeted edits): instead of regenerating a whole program,
// the AI emits a small ordered list of operations against the user's
// EXISTING step ids (insert_before / insert_after / delete / replace).
// This module applies those ops purely (no DOM, no state.js import),
// so it can be validated before anything touches the live program.
// ═══════════════════════════════════════════════════════════

const VALID_OPS = ['insert_before', 'insert_after', 'delete', 'replace'];

/**
 * @param {Array}    existingSteps - the user's current steps (from state.js)
 * @param {Array}    ops - patch operations from the AI
 * @param {Function} uidFn - id generator (state.js's uid()), used for any newly inserted steps
 * @returns {{ steps: Array, added: Array, removed: Array, errors: string[] }}
 *   `steps` is the full resulting step list (existingSteps untouched — a new array is returned).
 *   `added`/`removed` are for building a human-readable diff in the preview UI.
 *   If `errors` is non-empty, the patch could not be fully applied — caller should not proceed.
 */
export function applyPatchOps(existingSteps, ops, uidFn) {
  const errors = [];
  let result = existingSteps.map(s => ({ ...s })); // deep-ish copy, don't mutate caller's array
  const added = [];
  const removed = [];

  if (!Array.isArray(ops)) {
    return { steps: existingSteps, added: [], removed: [], errors: ['"ops" is missing or not an array.'] };
  }

  ops.forEach((op, i) => {
    const tag = `ops[${i}]`;
    if (!op || typeof op !== 'object' || !VALID_OPS.includes(op.op)) {
      errors.push(`${tag} has an invalid or missing "op" (must be one of ${VALID_OPS.join(', ')}).`);
      return;
    }
    if (typeof op.targetId !== 'string' || !op.targetId) {
      errors.push(`${tag} (${op.op}) is missing a valid "targetId".`);
      return;
    }

    const idx = result.findIndex(s => s.id === op.targetId);
    if (idx === -1) {
      errors.push(`${tag} (${op.op}) targets step id "${op.targetId}", which does not exist in the current program.`);
      return;
    }

    if (op.op === 'delete') {
      removed.push(result[idx]);
      result.splice(idx, 1);

    } else if (op.op === 'replace') {
      if (!op.step || typeof op.step !== 'object') {
        errors.push(`${tag} (replace) is missing a valid "step".`);
        return;
      }
      removed.push(result[idx]);
      // Merge onto the existing step rather than fully overwriting it —
      // the AI's replacement may only specify the fields it's changing,
      // and a full overwrite would silently drop everything else
      // (e.g. loopCount on a loop_start it wasn't trying to touch).
      const newStep = { ...result[idx], ...op.step, id: result[idx].id };
      added.push(newStep);
      result[idx] = newStep;

    } else { // insert_before / insert_after
      if (!Array.isArray(op.steps) || op.steps.length === 0) {
        errors.push(`${tag} (${op.op}) is missing a non-empty "steps" array.`);
        return;
      }
      const newSteps = op.steps.map(s => ({ ...s, id: uidFn() }));
      added.push(...newSteps);
      const insertAt = op.op === 'insert_before' ? idx : idx + 1;
      result.splice(insertAt, 0, ...newSteps);
    }
  });

  return { steps: result, added, removed, errors };
}

/**
 * Short, human-readable one-liner for a step — used in diff previews.
 * Mirrors (a simplified version of) the descriptions tab-program.js shows in the sequence list.
 */
export function describeStep(step, positionsById) {
  const posName = id => positionsById?.[id]?.name || id || '?';
  switch (step.type) {
    case 'movej': return `Move J → ${posName(step.pid)}`;
    case 'movel': return `Move L → ${posName(step.pid)}`;
    case 'movec': return `Move C via ${posName(step.via)} → ${posName(step.to)}`;
    case 'guarded_move': return `Guarded move (speed ${step.speed ?? '?'}, retract ${step.retract ?? '?'}mm)`;
    case 'open_gripper': return 'Open gripper';
    case 'close_gripper': return 'Close gripper';
    case 'activate_gripper': return 'Activate gripper';
    case 'read_gripper': return `Read gripper → ${step.varName ?? '?'}`;
    case 'loop_start': return step.loopType === 'times' ? `Loop ${step.loopCount ?? '?'} times` : 'Loop forever';
    case 'if_start': return `If (${step.condition ?? '?'})`;
    case 'else_if': return `Else if (${step.condition ?? '?'})`;
    case 'else': return 'Else';
    case 'wait_cond': return `Wait until (${step.condition ?? '?'})`;
    case 'thread_start': return `Thread "${step.threadName ?? '?'}"`;
    case 'end': return 'End block';
    case 'assign': return `${step.varName ?? '?'} = ${step.varValue ?? '?'}`;
    case 'timer': return `Timer ${step.timerAct ?? '?'} (${step.timerVar ?? '?'})`;
    case 'sleep': return `Wait ${step.sec ?? '?'}s`;
    case 'textmsg': return `Log: "${step.msg ?? ''}"`;
    case 'popup': return `Popup: "${step.msg ?? ''}"`;
    case 'halt': return 'Halt';
    case 'set_digital_out': return `Digital out ${step.port ?? '?'} = ${step.val ? 'HIGH' : 'LOW'}`;
    case 'set_payload': return `Set payload ${step.weight ?? '?'}kg`;
    case 'set_tcp': return `Set TCP (${step.pose ?? '?'})`;
    case 'comment': return `# ${step.commentTxt ?? ''}`;
    case 'folder': return `Folder "${step.folderName ?? '?'}"`;
    default: return step.type || 'unknown step';
  }
}