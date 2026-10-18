// ── CONSTANTS ──
import { positions, steps, setSteps, uid, selectedStepId, globalSettings, setSelectedStepId, getRelayIp } from './state.js';

// ── CONSTANTS ──
const OPENERS = ['loop_start','loop_n','loop_forever','loop_while','if_start','if_din','thread_start','folder'];

const TAG_INFO = {
  movej:'MOVEJ', movel:'MOVEL', movec:'MOVEC', guarded_move:'UNTIL',
  open_gripper:'GRIP', close_gripper:'GRIP', activate_gripper:'GRIP', read_gripper:'GRIP?',
  sleep:'WAIT', textmsg:'LOG', popup:'POP', set_digital_out:'DOUT',
  set_payload:'LOAD', set_tcp:'TCP',
  loop_start:'LOOP', if_start:'IF', else_if:'ELSEIF', else:'ELSE',
  wait_cond:'WAIT', halt:'HALT', thread_start:'THRD', end:'END',
  assign:'VAR', timer:'TIME', comment:'//', folder:'FLDR',
};

const TAG_COLOR = {
  movej:'tag-move', movel:'tag-move', movec:'tag-move', guarded_move:'tag-move',
  open_gripper:'tag-grip', close_gripper:'tag-grip', activate_gripper:'tag-grip', read_gripper:'tag-util',
  sleep:'tag-util', textmsg:'tag-util', popup:'tag-util', set_digital_out:'tag-util',
  set_payload:'tag-util', set_tcp:'tag-util',
  loop_start:'tag-logic', if_start:'tag-logic', else_if:'tag-logic', else:'tag-logic',
  wait_cond:'tag-logic', halt:'tag-logic', thread_start:'tag-logic', end:'tag-logic',
  assign:'tag-util', timer:'tag-util', comment:'tag-util', folder:'tag-util',
};

// ── DEFAULT STEP FACTORY ──
export function defaultStep(type) {
  const s = {id:uid(), type};
  if (type==='movej') s.pid = positions[0]?.id ?? null;
  if (type==='movel') s.pid = positions[0]?.id ?? null;
  if (type==='movec') { s.via = positions[0]?.id ?? null; s.to = s.via; }
  if (type==='guarded_move') { s.speed = 0.02; s.retract = 0.0; }
  if (type==='sleep') s.sec = 1;
  if (type==='textmsg') s.msg = '';
  if (type==='popup') { s.msg = 'Hello'; s.pType = 'msg'; }
  if (type==='set_digital_out') { s.port=0; s.val=true; }
  if (type==='set_payload') s.weight = 0.5;
  if (type==='set_tcp') s.pose = '0,0,0,0,0,0';
  if (type==='loop_start') { s.loopType = 'forever'; s.loopCount = 5; }
  if (type==='if_start') s.condition = 'get_digital_in(1) == True';
  if (type==='else_if') s.condition = 'get_digital_in(1) == False';
  if (type==='wait_cond') s.condition = 'get_digital_in(1) == True';
  if (type==='read_gripper') s.varName = 'part_size';
  if (type==='assign') { s.varName = 'my_var'; s.varValue = '0'; }
  if (type==='timer') { s.timerAct = 'start'; s.timerVar = 'timer_1'; }
  if (type==='thread_start') s.threadName = 'thread_1';
  if (type==='folder') s.folderName = 'My Folder';
  if (type==='comment') s.commentTxt = 'Note here';
  return s;
}

// ── STEP MUTATIONS ──
export function addStep(type) {
  const newS = defaultStep(type);
  steps.push(newS);
  setSelectedStepId(newS.id);
  renderSteps();
  renderNodeConfig();
  refreshCode();
}

export function deleteStep(sid) {
  setSteps(steps.filter(s=>s.id!==sid));
  if (selectedStepId === sid) {
    setSelectedStepId(null);
  }
  renderSteps();
  renderNodeConfig();
  refreshCode();
}

export function selectStep(sid) {
  setSelectedStepId(sid);
  renderSteps();
  renderNodeConfig();
}

export function moveStep(sid, dir) {
  const i = steps.findIndex(s=>s.id===sid), j=i+dir;
  if (j<0||j>=steps.length) return;
  [steps[i],steps[j]]=[steps[j],steps[i]];
  renderSteps(); refreshCode();
}

export function changeType(sid, type) {
  const i = steps.findIndex(s=>s.id===sid); if (i<0) return;
  const oldStep = steps[i];
  const newStep = {...defaultStep(type), id:sid};

  const moveTypes = ['movej', 'movel', 'movec'];
  if (moveTypes.includes(oldStep.type) && moveTypes.includes(type)) {
    if (type === 'movej' || type === 'movel') {
      if (oldStep.type === 'movej' || oldStep.type === 'movel') {
        newStep.pid = oldStep.pid;
      } else if (oldStep.type === 'movec') {
        newStep.pid = oldStep.to || oldStep.via;
      }
    } else if (type === 'movec') {
      if (oldStep.type === 'movej' || oldStep.type === 'movel') {
        newStep.via = oldStep.pid;
        newStep.to = oldStep.pid;
      }
    }
  }

  steps[i] = newStep;
  renderSteps();
  renderNodeConfig();
  refreshCode();
}

export function upd(sid, key, val) {
  const s = steps.find(x=>x.id===sid);
  if (s) {
    s[key]=val;
    refreshCode();
    renderSteps();
    renderNodeConfig();
  }
}

// ── RENDER ──
let _sortable = null;

export function renderSteps() {
  const list = document.getElementById('program-sequence');
  if (!list) return;

  if (steps.length === 0) {
    list.innerHTML = `<div style="color:var(--tx3);text-align:center;margin-top:40px;font-size:13px;">Add elements from the right panel →</div>`;
    if (_sortable) { _sortable.destroy(); _sortable = null; }
    return;
  }

  // ── Compute depth array ──
  // Also track max depth for guide coloring
  const depths = [];
  let depth = 0;
  for (const s of steps) {
    if (s.type === 'end') {
      depth = Math.max(0, depth - 1);
      depths.push(depth);
    } else if (s.type === 'else' || s.type === 'else_if') {
      depths.push(Math.max(0, depth - 1));
    } else {
      depths.push(depth);
      if (OPENERS.includes(s.type)) depth++;
    }
  }

  // Indent guide colors cycle through accent shades
  const GUIDE_COLORS = ['var(--ac)', '#a78bfa', '#34d399', '#fb923c', '#f472b6', '#60a5fa'];

  list.innerHTML = steps.map((s, si) => {
    const tag      = TAG_INFO[s.type] || '?';
    const tagCls   = TAG_COLOR[s.type] || 'tag-util';
    const isSelected = (s.id === selectedStepId);
    const d = depths[si];

    // Build indent guide bars
    let guideHtml = '';
    for (let g = 0; g < d; g++) {
      guideHtml += `<div style="
        width:2px; flex-shrink:0; align-self:stretch;
        background:${GUIDE_COLORS[g % GUIDE_COLORS.length]};
        opacity:0.45; border-radius:1px; margin-right:${g === d-1 ? 6 : 4}px;
      "></div>`;
    }

    const indentPx = d * 14; // extra left padding per level

    return `<div class="step ${isSelected ? 'on' : ''}" id="st-${s.id}" draggable="true"
        data-sortable-id="${s.id}"
        onclick="window._prog.selectStep('${s.id}')"
        style="cursor:pointer; padding-left:${8 + indentPx}px; ${isSelected ? 'border:1px solid var(--ac); box-shadow:0 0 4px var(--aclo,rgba(99,102,241,.35));' : ''}"
        ondragstart="window._prog.dragStart(event,${si})"
        ondragover="window._prog.dragOver(event)"
        ondragleave="window._prog.dragLeave(event)"
        ondrop="window._prog.dragDrop(event,${si})"
        ondragend="window._prog.dragEnd(event)">
      ${guideHtml}
      <span class="step-n">${si+1}</span>
      <span class="step-tag ${tagCls}">${tag}</span>
      <span style="font-size:11px;color:var(--tx3);min-width:60px;font-weight:bold;">${s.type}</span>
      <span style="font-size:11px;color:var(--tx2);margin-left:8px;flex:1;">${getStepDescription(s)}</span>
      <div class="step-controls">
        <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation(); window._prog.moveStep('${s.id}',-1)" ${si===0?'disabled':''}>↑</button>
        <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation(); window._prog.moveStep('${s.id}',1)" ${si===steps.length-1?'disabled':''}>↓</button>
        <button class="btn btn-sm" style="color:var(--rd);border-color:var(--rdlo);" onclick="event.stopPropagation(); window._prog.deleteStep('${s.id}')">✕</button>
      </div>
    </div>`;
  }).join('');

  // ── Initialise / refresh SortableJS ──
  if (_sortable) _sortable.destroy();
  if (typeof Sortable !== 'undefined') {
    _sortable = Sortable.create(list, {
      animation: 150,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      dragClass: 'sortable-drag',
      handle: '.step-n',            // drag handle = the step number badge
      onEnd(evt) {
        if (evt.oldIndex === evt.newIndex) return;
        const moved = steps.splice(evt.oldIndex, 1)[0];
        steps.splice(evt.newIndex, 0, moved);
        refreshCode();
        // Re-render to recompute depths + re-init Sortable
        renderSteps();
      }
    });
  }
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function getStepDescription(s) {
  switch(s.type) {
    case 'movej': {
      const p = positions.find(x => x.id === s.pid);
      return `to <strong>${p ? p.name : 'none'}</strong> (Joint)`;
    }
    case 'movel': {
      const p = positions.find(x => x.id === s.pid);
      return `to <strong>${p ? p.name : 'none'}</strong> (Linear)`;
    }
    case 'movec': {
      const v = positions.find(x => x.id === s.via);
      const t = positions.find(x => x.id === s.to);
      return `via <strong>${v ? v.name : 'none'}</strong> to <strong>${t ? t.name : 'none'}</strong>`;
    }
    case 'guarded_move':
      return `at <strong>${s.speed ?? 0.02}</strong> m/s (Retract: ${s.retract ?? 0} mm)`;
    case 'sleep':
      return `wait <strong>${s.sec ?? 1}</strong> sec`;
    case 'textmsg':
      return `log <strong>"${s.msg ?? ''}"</strong>`;
    case 'popup':
      return `pendant: <strong>"${s.msg ?? ''}"</strong> (${s.pType ?? 'msg'})`;
    case 'set_digital_out':
      return `set output <strong>${s.port ?? 0}</strong> to <strong>${s.val !== false ? 'HIGH' : 'LOW'}</strong>`;
    case 'set_payload':
      return `mass <strong>${s.weight ?? 0.5}</strong> kg`;
    case 'set_tcp':
      return `pose <strong>p[${s.pose ?? '0,0,0,0,0,0'}]</strong>`;
    case 'loop_start':
      return s.loopType === 'times' ? `<strong>${s.loopCount ?? 5}</strong> times` : `<strong>forever</strong>`;
    case 'if_start':
      return `if <strong>(${s.condition ?? ''})</strong>`;
    case 'else_if':
      return `else if <strong>(${s.condition ?? ''})</strong>`;
    case 'wait_cond':
      return `until <strong>(${s.condition ?? ''})</strong>`;
    case 'read_gripper':
      return `save pos to <strong>${s.varName ?? 'part_size'}</strong>`;
    case 'assign':
      return `<strong>${s.varName ?? 'my_var'}</strong> = <strong>${s.varValue ?? '0'}</strong>`;
    case 'timer':
      return `timer <strong>${s.timerVar ?? 'timer_1'}</strong> (<strong>${s.timerAct ?? 'start'}</strong>)`;
    case 'thread_start':
      return `run <strong>${s.threadName ?? 'thread_1'}</strong> in parallel`;
    case 'folder':
      return `📂 <strong>${s.folderName ?? 'My Folder'}</strong>`;
    case 'comment':
      return `# <em>${s.commentTxt ?? ''}</em>`;
    case 'else':
      return `else block`;
    case 'halt':
      return `stop execution`;
    case 'end':
      return `end of block`;
    default:
      return '';
  }
}

export async function renderNodeConfig() {
  const panel = document.getElementById('node-config-panel');
  if (!panel) return;

  const sState = await import('./state.js');
  const sid = sState.selectedStepId;
  const s = steps.find(x => x.id === sid);

  if (!s) {
    panel.innerHTML = `
      <div style="color: var(--tx3); text-align: center; margin-top: 20px; font-size: 12px;">
        Select a program element in the center sequence to edit its properties here.
      </div>
    `;
    // Hide preview when no step is selected
    await import('./viewer3d.js').then(v => v.hidePreview());
    return;
  }

  // Show preview for position-based steps
  if (s.type === 'movej' || s.type === 'movel') {
    const pos = positions.find(p => p.id === s.pid);
    if (pos && pos.j) {
      await import('./viewer3d.js').then(v => v.showPreview(pos.j));
    }
  } else if (s.type === 'movec') {
    const toPos = positions.find(p => p.id === s.to);
    if (toPos && toPos.j) {
      await import('./viewer3d.js').then(v => v.showPreview(toPos.j));
    }
  } else {
    await import('./viewer3d.js').then(v => v.hidePreview());
  }

  let html = `
    <div style="display:flex; flex-direction:column; gap:12px;">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--bd); padding-bottom:6px;">
        <span style="font-size:12px; font-weight:bold; color:var(--ac); text-transform:uppercase;">${s.type} Settings</span>
        <span style="font-size:10px; color:var(--tx3); font-family:var(--mono);">ID: ${s.id}</span>
      </div>
  `;

  const inputStyle = `width:100%; background:var(--sf); border:1px solid var(--bd); border-radius:4px; color:var(--tx); padding:6px; font-size:12px; font-family:inherit; box-sizing:border-box;`;
  const labelStyle = `font-size:10px; color:var(--tx3); text-transform:uppercase; font-weight:bold; display:block; margin-bottom:4px;`;

  switch(s.type) {
    case 'movej':
    case 'movel':
    case 'movec': {
      html += `
        <div>
          <label style="${labelStyle}">Move Type</label>
          <select style="${inputStyle}" onchange="window._prog.changeType('${s.id}', this.value)">
            <option value="movej" ${s.type === 'movej' ? 'selected' : ''}>Move J (Joint)</option>
            <option value="movel" ${s.type === 'movel' ? 'selected' : ''}>Move L (Linear)</option>
            <option value="movec" ${s.type === 'movec' ? 'selected' : ''}>Move C (Circular)</option>
          </select>
        </div>
      `;

      if (s.type === 'movej' || s.type === 'movel') {
        const posOpts = positions.map(p => `<option value="${p.id}" ${s.pid === p.id ? 'selected' : ''}>${p.name}</option>`).join('');
        html += `
          <div>
            <label style="${labelStyle}">Target Position</label>
            <select style="${inputStyle}" onchange="window._prog.upd('${s.id}', 'pid', this.value)">
              <option value="" ${!s.pid ? 'selected' : ''}>-- Select Position --</option>
              ${posOpts}
            </select>
          </div>
        `;
      } else if (s.type === 'movec') {
        const viaOpts = positions.map(p => `<option value="${p.id}" ${s.via === p.id ? 'selected' : ''}>${p.name}</option>`).join('');
        const toOpts = positions.map(p => `<option value="${p.id}" ${s.to === p.id ? 'selected' : ''}>${p.name}</option>`).join('');
        html += `
          <div>
            <label style="${labelStyle}">Via Position (Arc Middle)</label>
            <select style="${inputStyle}" onchange="window._prog.upd('${s.id}', 'via', this.value)">
              <option value="" ${!s.via ? 'selected' : ''}>-- Select Position --</option>
              ${viaOpts}
            </select>
          </div>
          <div>
            <label style="${labelStyle}">To Position (Arc End)</label>
            <select style="${inputStyle}" onchange="window._prog.upd('${s.id}', 'to', this.value)">
              <option value="" ${!s.to ? 'selected' : ''}>-- Select Position --</option>
              ${toOpts}
            </select>
          </div>
        `;
      }
      break;
    }
    case 'activate_gripper':
    case 'open_gripper':
    case 'close_gripper': {
      html += `
        <div>
          <label style="${labelStyle}">Gripper Command</label>
          <select style="${inputStyle}" onchange="window._prog.changeType('${s.id}', this.value)">
            <option value="activate_gripper" ${s.type === 'activate_gripper' ? 'selected' : ''}>Activate</option>
            <option value="open_gripper" ${s.type === 'open_gripper' ? 'selected' : ''}>Open</option>
            <option value="close_gripper" ${s.type === 'close_gripper' ? 'selected' : ''}>Close</option>
          </select>
        </div>
      `;
      break;
    }
    case 'read_gripper': {
      html += `
        <div>
          <label style="${labelStyle}">Save Position Variable Name</label>
          <input type="text" style="${inputStyle}" value="${s.varName ?? 'part_size'}" placeholder="e.g. part_size"
            oninput="window._prog.upd('${s.id}', 'varName', this.value)"/>
        </div>
      `;
      break;
    }
    case 'guarded_move': {
      html += `
        <div>
          <label style="${labelStyle}">Contact Speed (m/s)</label>
          <input type="number" step="0.005" style="${inputStyle}" value="${s.speed ?? 0.02}" 
            onchange="window._prog.upd('${s.id}', 'speed', parseFloat(this.value) || 0)"/>
        </div>
        <div>
          <label style="${labelStyle}">Retract Distance (mm)</label>
          <input type="number" step="0.1" style="${inputStyle}" value="${s.retract ?? 0}" 
            onchange="window._prog.upd('${s.id}', 'retract', parseFloat(this.value) || 0)"/>
        </div>
      `;
      break;
    }
    case 'sleep': {
      html += `
        <div>
          <label style="${labelStyle}">Wait Duration (seconds)</label>
          <input type="number" step="0.1" min="0" style="${inputStyle}" value="${s.sec ?? 1}" 
            onchange="window._prog.upd('${s.id}', 'sec', parseFloat(this.value) || 0)"/>
        </div>
      `;
      break;
    }
    case 'textmsg': {
      html += `
        <div>
          <label style="${labelStyle}">Log Message</label>
          <input type="text" style="${inputStyle}" value="${s.msg ?? ''}" placeholder="Enter log text..." 
            oninput="window._prog.upd('${s.id}', 'msg', this.value)"/>
        </div>
      `;
      break;
    }
    case 'popup': {
      html += `
        <div>
          <label style="${labelStyle}">Popup Message</label>
          <input type="text" style="${inputStyle}" value="${s.msg ?? ''}" placeholder="Enter alert message..." 
            oninput="window._prog.upd('${s.id}', 'msg', this.value)"/>
        </div>
        <div>
          <label style="${labelStyle}">Popup Type</label>
          <select style="${inputStyle}" onchange="window._prog.upd('${s.id}', 'pType', this.value)">
            <option value="msg" ${s.pType === 'msg' ? 'selected' : ''}>Message (Information)</option>
            <option value="warn" ${s.pType === 'warn' ? 'selected' : ''}>Warning</option>
            <option value="err" ${s.pType === 'err' ? 'selected' : ''}>Error</option>
          </select>
        </div>
      `;
      break;
    }
    case 'set_digital_out': {
      html += `
        <div>
          <label style="${labelStyle}">Digital Output Port (0 - 15)</label>
          <input type="number" min="0" max="15" style="${inputStyle}" value="${s.port ?? 0}" 
            onchange="window._prog.upd('${s.id}', 'port', parseInt(this.value) || 0)"/>
        </div>
        <div>
          <label style="${labelStyle}">Signal Level</label>
          <select style="${inputStyle}" onchange="window._prog.upd('${s.id}', 'val', this.value === 'true')">
            <option value="true" ${s.val !== false ? 'selected' : ''}>HIGH (24V)</option>
            <option value="false" ${s.val === false ? 'selected' : ''}>LOW (0V)</option>
          </select>
        </div>
      `;
      break;
    }
    case 'set_payload': {
      html += `
        <div>
          <label style="${labelStyle}">Mass (kg)</label>
          <input type="number" step="0.05" min="0" style="${inputStyle}" value="${s.weight ?? 0.5}" 
            onchange="window._prog.upd('${s.id}', 'weight', parseFloat(this.value) || 0)"/>
        </div>
      `;
      break;
    }
    case 'set_tcp': {
      html += `
        <div>
          <label style="${labelStyle}">TCP Pose (x,y,z,rx,ry,rz in meters/radians)</label>
          <input type="text" style="${inputStyle}" value="${s.pose ?? '0,0,0,0,0,0'}" placeholder="0.0, 0.0, 0.165, 0.0, 0.0, 0.0" 
            oninput="window._prog.upd('${s.id}', 'pose', this.value)"/>
        </div>
      `;
      break;
    }
    case 'loop_start': {
      html += `
        <div>
          <label style="${labelStyle}">Loop Type</label>
          <select style="${inputStyle}" onchange="window._prog.upd('${s.id}', 'loopType', this.value)">
            <option value="forever" ${s.loopType === 'forever' ? 'selected' : ''}>Loop Forever</option>
            <option value="times" ${s.loopType === 'times' ? 'selected' : ''}>Loop N Times</option>
          </select>
        </div>
        ${s.loopType === 'times' ? `
          <div>
            <label style="${labelStyle}">Iteration Count</label>
            <input type="number" min="1" style="${inputStyle}" value="${s.loopCount ?? 5}" 
              onchange="window._prog.upd('${s.id}', 'loopCount', parseInt(this.value) || 1)"/>
          </div>
        ` : ''}
      `;
      break;
    }
    case 'if_start':
    case 'else_if':
    case 'wait_cond': {
      html += `
        <div>
          <label style="${labelStyle}">Condition Expression (URScript)</label>
          <input type="text" style="${inputStyle}" value="${esc(s.condition ?? '')}" placeholder="e.g. get_digital_in(1) == True" 
            oninput="window._prog.upd('${s.id}', 'condition', this.value)"/>
        </div>
      `;
      break;
    }
    case 'read_gripper': {
      html += `
        <div>
          <label style="${labelStyle}">Save Position Variable Name</label>
          <input type="text" style="${inputStyle}" value="${s.varName ?? 'part_size'}" placeholder="e.g. part_size" 
            oninput="window._prog.upd('${s.id}', 'varName', this.value)"/>
        </div>
      `;
      break;
    }
    case 'assign': {
      html += `
        <div>
          <label style="${labelStyle}">Variable Name</label>
          <input type="text" style="${inputStyle}" value="${s.varName ?? 'my_var'}" placeholder="e.g. my_var" 
            oninput="window._prog.upd('${s.id}', 'varName', this.value)"/>
        </div>
        <div>
          <label style="${labelStyle}">Value / Expression</label>
          <input type="text" style="${inputStyle}" value="${s.varValue ?? '0'}" placeholder="e.g. 10 or my_var + 1" 
            oninput="window._prog.upd('${s.id}', 'varValue', this.value)"/>
        </div>
      `;
      break;
    }
    case 'timer': {
      html += `
        <div>
          <label style="${labelStyle}">Timer Operation</label>
          <select style="${inputStyle}" onchange="window._prog.upd('${s.id}', 'timerAct', this.value)">
            <option value="start" ${s.timerAct === 'start' ? 'selected' : ''}>Start / Reset Timer</option>
            <option value="read" ${s.timerAct === 'read' ? 'selected' : ''}>Read Elapsed to Variable</option>
          </select>
        </div>
        <div>
          <label style="${labelStyle}">Timer Variable Name</label>
          <input type="text" style="${inputStyle}" value="${s.timerVar ?? 'timer_1'}" placeholder="e.g. timer_1" 
            oninput="window._prog.upd('${s.id}', 'timerVar', this.value)"/>
        </div>
      `;
      break;
    }
    case 'thread_start': {
      html += `
        <div>
          <label style="${labelStyle}">Thread Routine Name</label>
          <input type="text" style="${inputStyle}" value="${s.threadName ?? 'thread_1'}" placeholder="e.g. thread_1" 
            oninput="window._prog.upd('${s.id}', 'threadName', this.value)"/>
        </div>
      `;
      break;
    }
    case 'folder': {
      html += `
        <div>
          <label style="${labelStyle}">Folder Name</label>
          <input type="text" style="${inputStyle}" value="${s.folderName ?? 'My Folder'}" placeholder="e.g. Pick Routine" 
            oninput="window._prog.upd('${s.id}', 'folderName', this.value)"/>
        </div>
      `;
      break;
    }
    case 'comment': {
      html += `
        <div>
          <label style="${labelStyle}">Comment Text</label>
          <input type="text" style="${inputStyle}" value="${esc(s.commentTxt ?? '')}" placeholder="Enter notes..." 
            oninput="window._prog.upd('${s.id}', 'commentTxt', this.value)"/>
        </div>
      `;
      break;
    }
    default: {
      html += `
        <div style="color:var(--tx3); font-size:11px; text-align:center; padding:20px 0;">
          No configuration parameters required for this element.
        </div>
      `;
      break;
    }
  }

  html += `</div>`;
  panel.innerHTML = html;
}

// ── DRAG AND DROP ──
let draggedIdx = null;
export const dragStart = (e, idx) => { draggedIdx = idx; e.currentTarget.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; };
export const dragOver  = (e) => { e.preventDefault(); e.target.closest('.step')?.classList.add('drag-over'); };
export const dragLeave = (e) => { e.target.closest('.step')?.classList.remove('drag-over'); };
export const dragEnd   = (e) => { e.currentTarget.classList.remove('dragging'); draggedIdx=null; document.querySelectorAll('.step').forEach(c=>c.classList.remove('drag-over')); };
export const dragDrop  = (e, dropIdx) => {
  e.preventDefault(); e.target.closest('.step')?.classList.remove('drag-over');
  if (draggedIdx===null||draggedIdx===dropIdx) return;
  const moved = steps.splice(draggedIdx, 1)[0];
  steps.splice(dropIdx, 0, moved);
  renderSteps(); refreshCode();
};

// ── CODE GENERATION ──
export function buildCode() {
  const T = '    ';
  const js = globalSettings.js;
  const ja = globalSettings.ja;
  const ls = globalSettings.ls;
  const la = globalSettings.la;
  const br = globalSettings.br;

  const L = [];
  L.push('def master_program():');
  L.push(`${T}# Motion parameters`);
  L.push(`${T}global JOINT_SPEED  = ${js}`);
  L.push(`${T}global JOINT_ACCEL  = ${ja}`);
  L.push(`${T}global LINEAR_SPEED = ${ls}`);
  L.push(`${T}global LINEAR_ACCEL = ${la}`);
  L.push(`${T}global BLEND_RADIUS = ${br}`);
  L.push('');
  L.push(`${T}# Positions`);
  positions.forEach(pos => {
    L.push(`${T}global ${pos.name}_J = [${pos.j.map(v=>v.toFixed(4)).join(', ')}]`);
    const cart = pos.c && pos.c.some(v=>v!==0) ? pos.c : pos.j;
    L.push(`${T}global ${pos.name}_C = p[${cart.map(v=>v.toFixed(4)).join(', ')}]`);
  });
  L.push('');
  L.push(`${T}# Setup`);
  const isTCPSet = globalSettings.tcpX || globalSettings.tcpY || globalSettings.tcpZ || globalSettings.tcpRx || globalSettings.tcpRy || globalSettings.tcpRz;
  if (isTCPSet) {
    L.push(`${T}set_tcp(p[${globalSettings.tcpX},${globalSettings.tcpY},${globalSettings.tcpZ},${globalSettings.tcpRx},${globalSettings.tcpRy},${globalSettings.tcpRz}])`);
  }
  L.push(`${T}set_payload(${globalSettings.plW}, [${globalSettings.plX}, ${globalSettings.plY}, ${globalSettings.plZ}])`);
  L.push('');
  L.push(`${T}global _master_clock = 0.0`);
  L.push(`${T}thread _clock_thread():`);
  L.push(`${T}${T}while True:`);
  L.push(`${T}${T}${T}_master_clock = _master_clock + get_steptime()`);
  L.push(`${T}${T}${T}sync()`);
  L.push(`${T}${T}end`);
  L.push(`${T}end`);
  L.push(`${T}run _clock_thread()`);
  L.push('');
  L.push(`${T}# Gripper init`);
  L.push(`${T}socket_close("rq_srv")`);
  L.push(`${T}socket_open("127.0.0.1", 63352, "rq_srv")`);
  L.push(`${T}socket_send_string("SET ACT 1", "rq_srv")`);
  L.push(`${T}socket_send_byte(10, "rq_srv")`);
  L.push(`${T}sync()`);
  L.push(`${T}socket_send_string("SET GTO 1", "rq_srv")`);
  L.push(`${T}socket_send_byte(10, "rq_srv")`);
  L.push(`${T}sync()`);
  L.push(`${T}sleep(3.0)`);
  L.push('');
  L.push(`${T}# Main sequence`);

  let ind = 1;
  let stack = [];
  const getTab = () => T.repeat(ind);

  steps.forEach((s, si) => {
    if (s.type === 'end') {
      ind = Math.max(1, ind - 1);
      let tab = getTab();
      let parent = stack.pop() || { type: 'unknown' };
      if (parent.type === 'folder')         L.push(`${tab}# └ End ${parent.folderName}`);
      else if (parent.type === 'loop_start' && parent.loopType === 'times') {
        L.push(`${tab}loop_var_${parent._si} = loop_var_${parent._si} + 1`);
        L.push(`${tab}end`);
      }
      else if (parent.type === 'thread_start') { L.push(`${tab}end`); L.push(`${tab}run ${parent.threadName}()`); }
      else L.push(`${tab}end`);
      return;
    }
    if (s.type === 'else') { ind = Math.max(1, ind - 1); L.push(`${getTab()}else:`); ind++; return; }
    if (s.type === 'else_if') { ind = Math.max(1,ind-1); L.push(`${getTab()}elif (${s.condition}):`); ind++; return; }

    const tab = getTab();
    switch(s.type) {
      case 'movej': { const p=positions.find(x=>x.id===s.pid); L.push(`${tab}movej(${p?p.name+'_J':'UNKNOWN'}, a=JOINT_ACCEL, v=JOINT_SPEED, r=BLEND_RADIUS)`); break; }
      case 'movel': { const p=positions.find(x=>x.id===s.pid); L.push(`${tab}movel(${p?p.name+'_C':'UNKNOWN'}, a=LINEAR_ACCEL, v=LINEAR_SPEED, r=BLEND_RADIUS)`); break; }
      case 'movec': { const v=positions.find(x=>x.id===s.via),t=positions.find(x=>x.id===s.to); L.push(`${tab}movec(${v?v.name+'_C':'UNKNOWN'}, ${t?t.name+'_C':'UNKNOWN'}, a=LINEAR_ACCEL, v=LINEAR_SPEED)`); break; }
      case 'sleep':           L.push(`${tab}sleep(${s.sec??1.0})`); break;
      case 'textmsg':
        const safeMsg = s.msg ?? 'Log';
        L.push(`${tab}textmsg("${safeMsg}")`);
        L.push(`${tab}socket_open("${getRelayIp()}", 50001, "log_sock")`);
        
        // Smart check: If the message matches an existing variable, don't wrap it in quotes!
        if (safeMsg === 'part_size' || safeMsg === '_master_clock') {
          L.push(`${tab}socket_send_string(to_str(${safeMsg}), "log_sock")`);
        } else {
          L.push(`${tab}socket_send_string("${safeMsg}", "log_sock")`);
        }
        
        L.push(`${tab}socket_close("log_sock")`);
        break;
      case 'set_digital_out': L.push(`${tab}set_digital_out(${s.port??0}, ${s.val!==false?'True':'False'})`); break;
      case 'set_payload':     L.push(`${tab}set_payload(${s.weight??0})`); break;
      case 'set_tcp':         L.push(`${tab}set_tcp(p[${s.pose??'0,0,0,0,0,0'}])`); break;
      case 'assign':          L.push(`${tab}${s.varName} = ${s.varValue}`); break;
      case 'comment':         L.push(`${tab}# ${s.commentTxt??''}`); break;
      case 'halt':            L.push(`${tab}halt`); break;
      case 'wait_cond':
        L.push(`${tab}while not (${s.condition}):`);
        L.push(`${tab}${T}sync()`);
        L.push(`${tab}end`);
        break;
      case 'loop_start':
        if (s.loopType==='times') { s._si=si; L.push(`${tab}loop_var_${si} = 0`); L.push(`${tab}while (loop_var_${si} < ${s.loopCount}):`); }
        else L.push(`${tab}while True:`);
        stack.push(s); ind++; break;
      case 'if_start':    L.push(`${tab}if (${s.condition}):`); stack.push(s); ind++; break;
      case 'thread_start':L.push(`${tab}thread ${s.threadName}():`); stack.push(s); ind++; break;
      case 'folder':      L.push(`${tab}# 📂 ${s.folderName}`); stack.push(s); ind++; break;
      case 'open_gripper':
        L.push(`${tab}socket_open("127.0.0.1", 63352, "rq_srv")`);
        L.push(`${tab}socket_send_string("SET POS 0", "rq_srv")`);
        L.push(`${tab}socket_send_byte(10, "rq_srv")`);
        L.push(`${tab}sync()`);
        L.push(`${tab}socket_close("rq_srv")`);
        break;
      case 'close_gripper':
        L.push(`${tab}socket_open("127.0.0.1", 63352, "rq_srv")`);
        L.push(`${tab}socket_send_string("SET POS 255", "rq_srv")`);
        L.push(`${tab}socket_send_byte(10, "rq_srv")`);
        L.push(`${tab}sync()`);
        L.push(`${tab}socket_close("rq_srv")`);
        break;
      case 'popup':
        L.push(`${tab}socket_open("${getRelayIp()}", 50000, "ui_socket")`);
        L.push(`${tab}socket_send_string("${s.msg}", "ui_socket")`);
        L.push(`${tab}local ui_response = ""`);
        L.push(`${tab}while (ui_response != "continue"):`);
        L.push(`${tab}${T}ui_response = socket_read_string("ui_socket", timeout=0)`);
        L.push(`${tab}${T}sleep(0.1)`);
        L.push(`${tab}end`);
        L.push(`${tab}socket_close("ui_socket")`);
        break;
      case 'guarded_move':
          L.push(`${tab}# --- Move Until Contact (With Precise Backtrack) ---`);
          
          L.push(`${tab}while (True):`);
          // Calling tool_contact() without arguments bypasses the firmware bug
          // and returns the 'step_back' history index when contact happens.
          L.push(`${tab}${T}step_back = tool_contact()`);
          
          L.push(`${tab}${T}if (step_back <= 0):`);
          // No contact: keep seeking
          L.push(`${tab}${T}${T}speedl([0, 0, -${s.speed || 0.02}, 0, 0, 0], 0.5, t=get_steptime())`);
          
          L.push(`${tab}${T}else:`);
          // Contact detected!
          // 1. Fetch exact joint positions from the millisecond contact was made
          L.push(`${tab}${T}${T}q = get_actual_joint_positions_history(step_back)`);
          // 2. Halt the downward momentum
          L.push(`${tab}${T}${T}stopl(3.0)`);
          
          // 3. Convert historical joint list to an exact Cartesian Pose
          L.push(`${tab}${T}${T}contact_pose = get_forward_kin(q)`);
          
          if (s.retract && s.retract > 0) {
            // Apply user retraction on top of the exact contact point
            const retract_m = (s.retract / 1000).toFixed(4);
            L.push(`${tab}${T}${T}# Apply user retraction of ${s.retract}mm from contact point`);
            L.push(`${tab}${T}${T}target_pose = pose_add(contact_pose, p[0.0, 0.0, ${retract_m}, 0.0, 0.0, 0.0])`);
            L.push(`${tab}${T}${T}movel(target_pose, a=0.5, v=0.05)`);
          } else {
            // If user retraction is 0, just backtrack the overshoot to relieve pressure
            L.push(`${tab}${T}${T}# Backtrack exact overshoot distance to relieve pressure`);
            L.push(`${tab}${T}${T}movel(contact_pose, a=0.5, v=0.05)`);
          }
          
          L.push(`${tab}${T}${T}break`);
          L.push(`${tab}${T}end`); // end if
          
          L.push(`${tab}end`); // end while
          break; 
      case 'activate_gripper':
        L.push(`${tab}socket_open("127.0.0.1", 63352, "rq_srv")`);
        L.push(`${tab}socket_send_string("SET ACT 1", "rq_srv")`);
        L.push(`${tab}socket_send_byte(10, "rq_srv")`);
        L.push(`${tab}sync()`);
        L.push(`${tab}socket_send_string("SET GTO 1", "rq_srv")`);
        L.push(`${tab}socket_send_byte(10, "rq_srv")`);
        L.push(`${tab}sync()`);
        L.push(`${tab}socket_close("rq_srv")`);
        L.push(`${tab}textmsg("GRIPPER:ACTIVATED")`);
        break;
      case 'read_gripper':
        L.push(`${tab}_opened = socket_open("127.0.0.1", 63352, "rq_srv")`);
        L.push(`${tab}if (_opened):`);
        L.push(`${tab}${T}socket_send_string("GET POS", "rq_srv")`);
        L.push(`${tab}${T}socket_send_byte(10, "rq_srv")`);
        L.push(`${tab}${T}_raw = socket_read_string("rq_srv", timeout=0.3)`);
        L.push(`${tab}${T}socket_close("rq_srv")`);
        L.push(`${tab}${T}if (str_len(_raw) > 0):`);
        L.push(`${tab}${T}${T}if (str_at(_raw, 0) == "P"):`);
        L.push(`${tab}${T}${T}${T}_raw = str_sub(_raw, 4)`);
        L.push(`${tab}${T}${T}end`);
        L.push(`${tab}${T}${T}_clean = ""`);
        L.push(`${tab}${T}${T}_i = 0`);
        L.push(`${tab}${T}${T}while (_i < str_len(_raw)):`);
        L.push(`${tab}${T}${T}${T}_char = str_sub(_raw, _i, 1)`);
        L.push(`${tab}${T}${T}${T}if (_char == "0" or _char == "1" or _char == "2" or _char == "3" or _char == "4" or _char == "5" or _char == "6" or _char == "7" or _char == "8" or _char == "9"):`);
        L.push(`${tab}${T}${T}${T}${T}_clean = _clean + _char`);
        L.push(`${tab}${T}${T}${T}else:`);
        L.push(`${tab}${T}${T}${T}${T}break`);
        L.push(`${tab}${T}${T}${T}end`);
        L.push(`${tab}${T}${T}${T}_i = _i + 1`);
        L.push(`${tab}${T}${T}end`);
        L.push(`${tab}${T}${T}if (str_len(_clean) > 0):`);
        L.push(`${tab}${T}${T}${T}${s.varName ?? 'part_size'} = to_num(_clean)`);
        L.push(`${tab}${T}${T}else:`);
        L.push(`${tab}${T}${T}${T}${s.varName ?? 'part_size'} = 0`);
        L.push(`${tab}${T}${T}end`);
        L.push(`${tab}${T}else:`);
        L.push(`${tab}${T}${T}${s.varName ?? 'part_size'} = 0`);
        L.push(`${tab}${T}end`);
        L.push(`${tab}else:`);
        L.push(`${tab}${T}${s.varName ?? 'part_size'} = 0`);
        L.push(`${tab}end`);
        L.push(`${tab}textmsg("DEBUG: Final Result = ", ${s.varName ?? 'part_size'})`);
        break;
      case 'timer':
        if (s.timerAct === 'start') {
          L.push(`${tab}global ${s.timerVar ?? 'timer_1'}_start = _master_clock`);
        } else {
          L.push(`${tab}global ${s.timerVar ?? 'timer_1'} = _master_clock - ${s.timerVar ?? 'timer_1'}_start`);
          L.push(`${tab}textmsg("Timer ${s.timerVar ?? 'timer_1'}: ", ${s.timerVar ?? 'timer_1'})`);
        }
        break;
      default: break;
    }
  });

  L.push(`${T}socket_close("rq_srv")`);
  L.push(`${T}textmsg("=== Program Complete ===")`);
  L.push('end');
  L.push('master_program()');
  return L.join('\n') + '\n';
}

// ── SYNTAX HIGHLIGHT ──
const KW  = /\b(def|end|if|elif|else|while|global|local|return|True|False|not|and|or|break|sync)\b/g;
const FNS = /\b(movej|movel|movec|sleep|textmsg|popup|set_tcp|set_payload|set_digital_out|get_digital_in|socket_open|socket_close|socket_send_string|socket_send_byte|stopl|speedl|freedrive_mode|halt|master_program)\b/g;
const NUM = /(?<!["'\w])(-?\d+\.?\d*)\b/g;

function highlight(code) {
  return code.split('\n').map(line => {
    const e = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    if (/^\s*#/.test(e)) return `<span class="c-cm">${e}</span>`;
    let c=e, cm='';
    const ci = e.indexOf('#');
    if (ci>0) { c=e.slice(0,ci); cm=e.slice(ci); }
    const sm={}; let si=0;
    c = c.replace(/"([^"]*)"/g, (_,inner) => { const k=`\x00${si++}\x00`; sm[k]=`<span class="c-str">"${inner}"</span>`; return k; });
    c = c.replace(NUM, m=>`<span class="c-num">${m}</span>`)
         .replace(KW,  m=>`<span class="c-kw">${m}</span>`)
         .replace(FNS, m=>`<span class="c-fn">${m}</span>`);
    Object.entries(sm).forEach(([k,v])=>{ c=c.replace(k,v); });
    if (cm) c += `<span class="c-cm">${cm.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>`;
    return c;
  }).join('\n');
}

export function refreshCode() {
  const out = document.getElementById('code-out');
  if (!out) return;
  const plain = buildCode();
  out.innerHTML = highlight(plain);
}

// ── SEND TO ROBOT ──
export async function sendToRobot() {
  const { RELAY, setDot } = await import('./network.js');
  const ip = document.getElementById('robot-ip').value.trim();
  if (!ip) { alert('Enter the robot IP address.'); return; }
  const btn = document.getElementById('btn-send-program');
  if (btn) { btn.textContent = 'Sending…'; btn.disabled=true; }
  setDot('sending');
  try {
    const res = await fetch(RELAY, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ip, code: buildCode()})
    });
    const data = await res.json();
    if (data.ok) {
      setDot('ok');
      if (btn) { btn.textContent='✓ Sent!'; btn.style.background='var(--gn)'; }
      setTimeout(()=>{ if(btn){btn.textContent='Send to Robot';btn.style.background='';btn.disabled=false;} }, 2500);
    } else throw new Error(data.error || 'Robot rejected the script');
  } catch(e) {
    setDot('err');
    if (btn) { btn.textContent='✕ Failed'; btn.style.background='var(--rd)'; }
    alert(`Failed to send:\n${e.message}`);
    setTimeout(()=>{ if(btn){btn.textContent='Send to Robot';btn.style.background='';btn.disabled=false;} }, 2500);
  }
}

// ── EXPOSE ──
export function exposeProgram() {
  window._prog = {
    addStep, deleteStep, moveStep, changeType, upd, sendToRobot,
    dragStart, dragOver, dragLeave, dragEnd, dragDrop, selectStep, renderNodeConfig
  };
}