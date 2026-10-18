// ═══════════════════════════════════════════════════════════
// AI-ASSISTANT — Gemini-powered chat, rendered as a full tab panel
//
// Initialised by main.js via initAiAssistant(). Looks for a
// #tab-ai element (from index-2.html) and renders its entire
// UI there. All three modes — Ask, Generate, Modify — plus a
// context panel with quick-action chips and a live program
// summary are included. No floating button/panel; it's a
// first-class tab now.
// ═══════════════════════════════════════════════════════════
import { RELAY } from './network.js';
import { positions, steps, globalSettings, isSimulationMode, simJoints, simTcp } from './state.js';
import { applyPatchOps, describeStep } from './program-patcher.js';

let _history = [];   // [{role:'user'|'model', text}]
let _mode    = 'ask';

// ── Minimal, safe markdown renderer ──────────────────────────
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mdToHtml(raw) {
  const text = escapeHtml(raw);

  const blocks = [];
  let withPlaceholders = text.replace(/```([\s\S]*?)```/g, (_, code) => {
    const idx = blocks.push(`<pre class="ai-codeblock"><code>${code.trim()}</code></pre>`) - 1;
    return `\x00BLOCK${idx}\x00`;
  });

  const lines = withPlaceholders.split('\n');
  let html = '';
  let listType = null;

  const closeList = () => {
    if (listType) { html += `</${listType}>`; listType = null; }
  };

  const inlineFormat = (line) =>
    line
      .replace(/`([^`]+?)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>');

  for (let line of lines) {
    const bullet   = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);

    if (bullet) {
      if (listType !== 'ul') { closeList(); html += '<ul class="ai-list">'; listType = 'ul'; }
      html += `<li>${inlineFormat(bullet[1])}</li>`;
    } else if (numbered) {
      if (listType !== 'ol') { closeList(); html += '<ol class="ai-list">'; listType = 'ol'; }
      html += `<li>${inlineFormat(numbered[1])}</li>`;
    } else {
      closeList();
      if (line.trim() === '') {
        html += '<br>';
      } else if (/^\x00BLOCK\d+\x00$/.test(line.trim())) {
        html += line.trim();
      } else {
        html += `<div>${inlineFormat(line)}</div>`;
      }
    }
  }
  closeList();

  html = html.replace(/\x00BLOCK(\d+)\x00/g, (_, i) => blocks[+i]);
  return html;
}

// ── Context snapshot sent with every request ─────────────────
function buildContext() {
  return {
    simulationMode: isSimulationMode,
    positions:  positions.map(p => ({ name: p.name, j: p.j, c: p.c })),
    stepCount:  steps.length,
    steps:      steps.map(s => ({ ...s })),
    settings:   globalSettings,
    currentJoints: isSimulationMode ? simJoints : undefined,
    currentTcp:    isSimulationMode ? simTcp    : undefined,
  };
}

// ── Styles ────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('ai-assist-styles')) return;
  const style = document.createElement('style');
  style.id = 'ai-assist-styles';
  style.textContent = `
    /* ── Tab root layout ── */
    #ai-tab-root {
      display: flex;
      width: 100%;
      height: 100%;
      gap: 16px;
    }

    /* ── Chat column (left, flex) ── */
    .ai-chat-col {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      background: var(--sf);
      border: 1px solid var(--bd);
      border-radius: var(--r);
      overflow: hidden;
    }
    #ai-panel-hdr {
      padding: 10px 14px;
      background: var(--sf2);
      border-bottom: 1px solid var(--bd);
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .ai-title {
      font: 600 13px var(--sans);
      color: var(--tx);
      flex: 1;
    }
    #ai-mode-toggle {
      display: flex;
      border: 1px solid var(--bd2);
      border-radius: 6px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .ai-mode-btn {
      padding: 5px 13px;
      font: 600 11px var(--mono);
      border: none;
      background: none;
      color: var(--tx2);
      cursor: pointer;
      transition: .15s;
      letter-spacing: .03em;
    }
    .ai-mode-btn.on { background: var(--ac); color: #fff; }
    .ai-mode-btn:not(.on):hover { background: var(--sf); color: var(--tx); }
    #ai-clear-btn {
      background: none;
      border: 1px solid var(--bd2);
      color: var(--tx3);
      border-radius: var(--r);
      padding: 4px 10px;
      cursor: pointer;
      font: 11px var(--mono);
      transition: .15s;
      flex-shrink: 0;
    }
    #ai-clear-btn:hover { color: var(--rd); border-color: var(--rdlo); }

    /* ── Messages ── */
    #ai-msgs {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    #ai-msgs::-webkit-scrollbar { width: 4px; }
    #ai-msgs::-webkit-scrollbar-thumb { background: var(--bd2); border-radius: 2px; }

    .ai-msg {
      max-width: 86%;
      padding: 10px 13px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.6;
      word-wrap: break-word;
    }
    .ai-msg.user {
      align-self: flex-end;
      background: var(--ac);
      color: #fff;
      border-bottom-right-radius: 3px;
    }
    .ai-msg.model {
      align-self: flex-start;
      background: var(--sf2);
      color: var(--tx);
      border: 1px solid var(--bd);
      border-bottom-left-radius: 3px;
    }
    .ai-msg.err {
      align-self: flex-start;
      background: var(--rdlo);
      color: var(--rd);
      border: 1px solid #ef444440;
    }
    .ai-msg.hint {
      align-self: center;
      color: var(--tx3);
      font-size: 12px;
      text-align: center;
      background: none;
      max-width: 90%;
    }
    .ai-msg code {
      background: rgba(255,255,255,.08);
      border: 1px solid var(--bd2);
      border-radius: 3px;
      padding: 1px 4px;
      font: 11px var(--mono);
    }
    .ai-msg.user code { background: rgba(255,255,255,.22); border-color: rgba(255,255,255,.3); }
    .ai-msg strong  { font-weight: 700; color: inherit; }
    .ai-msg em      { font-style: italic; }
    .ai-msg .ai-list { margin: 4px 0 4px 20px; padding: 0; }
    .ai-msg .ai-list li { margin: 3px 0; }
    .ai-msg .ai-codeblock {
      background: #07070a;
      border: 1px solid var(--bd2);
      border-radius: 6px;
      padding: 10px 12px;
      margin: 8px 0;
      overflow-x: auto;
    }
    .ai-msg .ai-codeblock code {
      background: none; border: none; padding: 0;
      font: 11px/1.5 var(--mono); color: #c8c8d8; white-space: pre;
    }

    /* ── Preview cards (Generate/Modify) ── */
    .ai-preview { max-width: 94% !important; display: flex; flex-direction: column; gap: 8px; }
    .ai-preview-title   { font-weight: 700; color: var(--ac); font-size: 14px; }
    .ai-preview-summary { color: var(--tx2); font-size: 12px; }
    .ai-preview-errhdr  { color: var(--rd);  font-weight: 600; margin-top: 6px; font-size: 12px; }
    .ai-preview-warnhdr { color: var(--tx3); font-weight: 600; margin-top: 6px; font-size: 12px; }
    .ai-err-list  { color: var(--rd); font-size: 12px; }
    .ai-warn-list { color: var(--tx3); font-size: 12px; }
    .ai-preview-btns { display: flex; gap: 8px; margin-top: 8px; }
    .ai-preview-apply {
      flex: 1; background: var(--gn); border: none; color: #000;
      font-weight: 700; border-radius: var(--r); padding: 9px 0;
      cursor: pointer; font-size: 12px; transition: .15s;
    }
    .ai-preview-apply:hover:not(:disabled) { filter: brightness(1.1); }
    .ai-preview-apply:disabled { background: var(--bd2); color: var(--tx3); cursor: default; }
    .ai-preview-discard {
      background: none; border: 1px solid var(--bd2); color: var(--tx2);
      border-radius: var(--r); padding: 9px 14px; cursor: pointer; font-size: 12px; transition: .15s;
    }
    .ai-preview-discard:hover:not(:disabled) { border-color: var(--rd); color: var(--rd); }
    .ai-preview-discard:disabled { opacity: .4; cursor: default; }
    .ai-diff-hdr       { font-weight: 600; font-size: 12px; margin-top: 6px; }
    .ai-diff-add       { color: var(--gn); }
    .ai-diff-rem       { color: var(--rd); }
    .ai-diff-add-list  { color: var(--gn); font-size: 12px; }
    .ai-diff-rem-list  { color: var(--rd); font-size: 12px; text-decoration: line-through; text-decoration-color: #ef444488; }

    /* ── Input row ── */
    #ai-input-row {
      display: flex;
      gap: 8px;
      padding: 12px;
      border-top: 1px solid var(--bd);
      flex-shrink: 0;
      background: var(--sf2);
      align-items: flex-end;
    }
    #ai-input {
      flex: 1;
      background: var(--bg);
      border: 1px solid var(--bd);
      border-radius: var(--r);
      color: var(--tx);
      padding: 10px 12px;
      font: 13px var(--sans);
      resize: none;
      line-height: 1.5;
      min-height: 44px;
      max-height: 120px;
    }
    #ai-input:focus { outline: none; border-color: var(--ac); }
    #ai-send {
      background: var(--ac);
      border: none;
      color: #fff;
      border-radius: var(--r);
      padding: 10px 18px;
      cursor: pointer;
      font: 600 13px var(--sans);
      transition: .15s;
      align-self: flex-end;
      white-space: nowrap;
    }
    #ai-send:hover:not(:disabled) { filter: brightness(1.15); }
    #ai-send:disabled { opacity: .4; cursor: default; }

    /* ── Typing indicator ── */
    .ai-typing {
      display: inline-flex;
      gap: 4px;
      align-self: flex-start;
      padding: 12px 14px;
      background: var(--sf2);
      border: 1px solid var(--bd);
      border-radius: 12px;
      border-bottom-left-radius: 3px;
    }
    .ai-typing span {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--tx3); animation: ai-bounce 1s infinite;
    }
    .ai-typing span:nth-child(2) { animation-delay: .15s; }
    .ai-typing span:nth-child(3) { animation-delay: .3s; }
    @keyframes ai-bounce {
      0%,60%,100% { transform: translateY(0); opacity: .4; }
      30%          { transform: translateY(-5px); opacity: 1; }
    }

    /* ── Context (right) column ── */
    .ai-context-col {
      width: 280px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
      overflow-y: auto;
    }
    .ai-context-col::-webkit-scrollbar { width: 4px; }
    .ai-context-col::-webkit-scrollbar-thumb { background: var(--bd2); border-radius: 2px; }
    .ai-ctx-card {
      background: var(--sf);
      border: 1px solid var(--bd);
      border-radius: var(--r);
      overflow: hidden;
      flex-shrink: 0;
    }
    .ai-ctx-hdr {
      padding: 8px 12px;
      background: var(--sf2);
      border-bottom: 1px solid var(--bd);
      font: 600 10px var(--mono);
      color: var(--tx3);
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    .ai-ctx-body { padding: 10px 12px; }

    /* ── Quick chips ── */
    .ai-chip {
      display: inline-block;
      padding: 5px 10px;
      background: var(--sf2);
      border: 1px solid var(--bd);
      border-radius: 20px;
      font-size: 11px;
      color: var(--tx2);
      cursor: pointer;
      transition: .15s;
      margin: 3px 2px;
      line-height: 1.3;
    }
    .ai-chip:hover { background: var(--ac); color: #fff; border-color: var(--ac); transform: translateY(-1px); }
    .ai-chip.chip-gen { border-color: #34d39966; color: var(--gn); }
    .ai-chip.chip-gen:hover { background: var(--gn); color: #000; border-color: var(--gn); }

    /* ── Program summary rows ── */
    .ai-prog-step-row {
      display: flex;
      gap: 6px;
      align-items: center;
      padding: 4px 0;
      font-size: 11px;
      color: var(--tx2);
      border-bottom: 1px solid var(--bd);
    }
    .ai-prog-step-row:last-child { border-bottom: none; }
    .ai-prog-step-num  { color: var(--tx3); width: 18px; flex-shrink: 0; text-align: right; font: 10px var(--mono); }
    .ai-prog-step-type { font: 700 9px var(--mono); color: var(--ac); width: 38px; flex-shrink: 0; }
    .ai-prog-step-desc { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;
  document.head.appendChild(style);
}

// ── DOM injection ─────────────────────────────────────────────
function injectTabDom(container) {
  container.style.cssText = 'width:100%;height:100%;display:flex;padding:16px;gap:16px;box-sizing:border-box;';
  container.innerHTML = `
    <div id="ai-tab-root">
      <!-- ── Chat column ── -->
      <div class="ai-chat-col">
        <div id="ai-panel-hdr">
          <span class="ai-title">✨ AI Program Assistant</span>
          <div id="ai-mode-toggle">
            <button class="ai-mode-btn on" id="ai-mode-ask"  type="button">Ask</button>
            <button class="ai-mode-btn"    id="ai-mode-gen"  type="button">Generate</button>
            <button class="ai-mode-btn"    id="ai-mode-mod"  type="button">Modify</button>
          </div>
          <button id="ai-clear-btn" type="button" title="Clear conversation history">↺ Clear</button>
        </div>

        <div id="ai-msgs">
          <div class="ai-msg hint" id="ai-hint">
            I can see your current positions and program steps.<br>
            <strong>Ask</strong> me anything about your robot program.<br>
            Switch to <strong>Generate</strong> to build new programs, or <strong>Modify</strong> to edit the current one.
          </div>
        </div>

        <div id="ai-input-row">
          <textarea id="ai-input" rows="2" placeholder="Ask a question…"></textarea>
          <button id="ai-send" type="button">↑ Send</button>
        </div>
      </div>

      <!-- ── Context column ── -->
      <div class="ai-context-col">
        <div class="ai-ctx-card">
          <div class="ai-ctx-hdr">⚡ Quick Actions</div>
          <div class="ai-ctx-body" id="ai-quick-chips"></div>
        </div>

        <div class="ai-ctx-card">
          <div class="ai-ctx-hdr">📋 Current Program</div>
          <div class="ai-ctx-body" id="ai-prog-summary"></div>
        </div>

        <div class="ai-ctx-card">
          <div class="ai-ctx-hdr">💡 How to Use</div>
          <div class="ai-ctx-body" style="font-size:11px;color:var(--tx3);line-height:1.7;">
            <strong style="color:var(--tx2);">Ask</strong> — questions about your program, how steps work, or what's wrong.<br><br>
            <strong style="color:var(--gn);">Generate</strong> — describe a full program and I'll build it. Preview before applying.<br><br>
            <strong style="color:var(--tx2);">Modify</strong> — describe a targeted edit to the current program. Review the diff before applying.<br><br>
            <span style="color:var(--ac);">Shift+Enter</span> for newlines in the input.
          </div>
        </div>
      </div>
    </div>
  `;

  // ── Event wiring ──
  document.getElementById('ai-mode-ask').addEventListener('click', () => setMode('ask'));
  document.getElementById('ai-mode-gen').addEventListener('click', () => setMode('generate'));
  document.getElementById('ai-mode-mod').addEventListener('click', () => setMode('modify'));
  document.getElementById('ai-clear-btn').addEventListener('click', clearConversation);

  const input   = document.getElementById('ai-input');
  const sendBtn = document.getElementById('ai-send');

  sendBtn.addEventListener('click', () => sendFromInput());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFromInput(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  updateContextPanel();
}

// ── Mode switching ────────────────────────────────────────────
function setMode(mode) {
  _mode = mode;
  document.getElementById('ai-mode-ask')?.classList.toggle('on', mode === 'ask');
  document.getElementById('ai-mode-gen')?.classList.toggle('on', mode === 'generate');
  document.getElementById('ai-mode-mod')?.classList.toggle('on', mode === 'modify');

  const input = document.getElementById('ai-input');
  const hint  = document.getElementById('ai-hint');

  if (mode === 'ask') {
    if (input) input.placeholder = 'Ask a question…';
    if (hint) hint.innerHTML = 'I can see your current positions and program steps.<br><strong>Ask</strong> me anything about your robot program, a specific step, or how things work.';
  } else if (mode === 'generate') {
    if (input) input.placeholder = 'Describe the program you want to build…';
    if (hint) hint.innerHTML = 'Describe a full program (e.g. <em>"pick from HOME, sort into two bins based on gripper width"</em>). I\'ll generate it, validate it, and show a <strong>preview before applying anything</strong>.';
  } else {
    if (input) input.placeholder = 'Describe the change to make…';
    if (hint) hint.innerHTML = 'Describe a targeted edit (e.g. <em>"add a 2-second sleep after the close gripper step"</em>). I\'ll show exactly what changes before anything is applied.';
  }

  if (input) input.focus();
}

// ── Conversation management ───────────────────────────────────
function clearConversation() {
  _history = [];
  const msgs = document.getElementById('ai-msgs');
  if (msgs) {
    msgs.innerHTML = `<div class="ai-msg hint" id="ai-hint">Conversation cleared. What can I help you with?</div>`;
  }
}

// ── Context panel ─────────────────────────────────────────────
function updateContextPanel() {
  updateQuickChips();
  updateProgSummary();
}

const STEP_TAG = {
  movej:'MOVEJ', movel:'MOVEL', movec:'MOVEC', guarded_move:'UNTIL',
  open_gripper:'OPEN', close_gripper:'CLOSE', activate_gripper:'ACT', read_gripper:'READ?',
  loop_start:'LOOP', if_start:'IF', else_if:'ELIF', else:'ELSE',
  wait_cond:'WAIT', thread_start:'THRD', end:'END',
  assign:'VAR', timer:'TIME', sleep:'WAIT', textmsg:'LOG', popup:'POP',
  halt:'HALT', set_digital_out:'DOUT', set_payload:'LOAD', set_tcp:'TCP',
  set_gravity:'GRAV', zero_ftsensor:'FT0', set_baselight:'LED',
  comment:'//', folder:'DIR',
};

function getStepShortDesc(s) {
  const posName = id => positions.find(p => p.id === id)?.name ?? '?';
  switch (s.type) {
    case 'movej': case 'movel': return `→ ${posName(s.pid)}`;
    case 'movec':   return `via ${posName(s.via)} → ${posName(s.to)}`;
    case 'sleep':   return `${s.sec ?? 1}s`;
    case 'textmsg': case 'popup': return `"${(s.msg ?? '').slice(0, 20)}"`;
    case 'loop_start': return s.loopType === 'times' ? `${s.loopCount ?? '?'}×` : 'forever';
    case 'if_start': case 'else_if': case 'wait_cond': return (s.condition ?? '').slice(0, 22);
    case 'assign':  return `${s.varName ?? '?'} = ${s.varValue ?? '?'}`;
    case 'comment': return (s.commentTxt ?? '').slice(0, 22);
    case 'folder':  return s.folderName ?? '';
    default:        return '';
  }
}

function updateQuickChips() {
  const el = document.getElementById('ai-quick-chips');
  if (!el) return;

  const hasSteps     = steps.length > 0;
  const hasPositions = positions.length > 0;

  // Build a context-aware chip list
  const chips = [];

  if (hasSteps) {
    chips.push({ label: '🔍 Explain my program', mode: 'ask',
      text: 'Explain what each step in my current program does, in plain language.' });
    chips.push({ label: '⚠️ Find potential errors', mode: 'ask',
      text: 'Review my current program and identify any potential issues, logic errors, or steps that could cause problems.' });
    chips.push({ label: '✨ Suggest improvements', mode: 'ask',
      text: 'Review my current program and suggest improvements for reliability, safety, or efficiency.' });
  }

  if (hasPositions) {
    const posNames = positions.slice(0, 4).map(p => p.name).join(', ');
    chips.push({ label: '🤖 Generate pick & place', mode: 'generate', gen: true,
      text: `Generate a pick-and-place program using my saved positions (${posNames}). Include gripper open/close and a loop.` });
  } else {
    chips.push({ label: '🤖 Generate sample program', mode: 'generate', gen: true,
      text: 'Generate a simple pick-and-place robot program with placeholder positions I can teach later.' });
  }

  chips.push({ label: '🔁 Generate infinite loop', mode: 'generate', gen: true,
    text: 'Generate a program with a forever loop that picks from one position and places at another.' });

  if (hasSteps) {
    chips.push({ label: '📝 Add error recovery', mode: 'modify',
      text: 'Add a retry loop or error-handling structure around the main sequence in my current program.' });
  }

  chips.push({ label: '📚 How do loops work?', mode: 'ask',
    text: 'Explain how to use loops (loop_start / end) in the UR3e program builder, with a simple example.' });
  chips.push({ label: '🦾 Gripper setup guide', mode: 'ask',
    text: 'Explain how to activate the Robotiq 2F-85 gripper in a program and use open/close/read steps.' });
  chips.push({ label: '🔄 What is guarded move?', mode: 'ask',
    text: 'Explain the "Move Until Contact" (guarded_move) step and give a good use-case for it.' });

  el.innerHTML = chips.map((chip, i) =>
    `<span class="ai-chip${chip.gen ? ' chip-gen' : ''}" data-chip="${i}">${chip.label}</span>`
  ).join('');

  el.querySelectorAll('.ai-chip').forEach(span => {
    const idx = parseInt(span.dataset.chip);
    span.addEventListener('click', () => {
      const chip = chips[idx];
      setMode(chip.mode);
      const input = document.getElementById('ai-input');
      if (input) {
        input.value = chip.text;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        input.focus();
      }
    });
  });
}

function updateProgSummary() {
  const el = document.getElementById('ai-prog-summary');
  if (!el) return;

  if (steps.length === 0) {
    el.innerHTML = `<div style="color:var(--tx3);font-size:11px;text-align:center;padding:8px 0;">
      No steps yet.<br>Use <strong>Generate</strong> to create a program,<br>or add steps from the Program tab.
    </div>`;
    return;
  }

  const MAX_SHOW = 10;
  const shown    = steps.slice(0, MAX_SHOW);

  let html = `<div style="font-size:10px;color:var(--tx3);margin-bottom:8px;display:flex;justify-content:space-between;">
    <span>${steps.length} step${steps.length !== 1 ? 's' : ''}</span>
    <span>${positions.length} position${positions.length !== 1 ? 's' : ''}</span>
  </div>`;

  html += shown.map((s, i) =>
    `<div class="ai-prog-step-row">
      <span class="ai-prog-step-num">${i + 1}</span>
      <span class="ai-prog-step-type">${STEP_TAG[s.type] ?? s.type}</span>
      <span class="ai-prog-step-desc">${escapeHtml(getStepShortDesc(s))}</span>
    </div>`
  ).join('');

  if (steps.length > MAX_SHOW) {
    html += `<div style="color:var(--tx3);font-size:10px;text-align:center;margin-top:6px;padding-top:6px;border-top:1px solid var(--bd);">
      …and ${steps.length - MAX_SHOW} more step${steps.length - MAX_SHOW !== 1 ? 's' : ''}
    </div>`;
  }

  el.innerHTML = html;
}

// ── Message rendering ─────────────────────────────────────────
function appendMsg(role, text) {
  const wrap = document.getElementById('ai-msgs');
  const div  = document.createElement('div');
  div.className = `ai-msg ${role}`;
  if (role === 'model' || role === 'err') {
    div.innerHTML = mdToHtml(text);
  } else {
    div.textContent = text;
  }
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  return div;
}

function showTyping(label = '') {
  const wrap = document.getElementById('ai-msgs');
  const div  = document.createElement('div');
  div.className = 'ai-typing';
  div.id = 'ai-typing-indicator';
  div.innerHTML = '<span></span><span></span><span></span>';
  if (label) {
    const lbl = document.createElement('span');
    lbl.style.cssText = 'font:11px var(--mono);color:var(--tx3);margin-left:6px;align-self:center;';
    lbl.textContent = label;
    div.appendChild(lbl);
  }
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function hideTyping() {
  document.getElementById('ai-typing-indicator')?.remove();
}

// ── Send dispatch ─────────────────────────────────────────────
async function sendFromInput() {
  const input   = document.getElementById('ai-input');
  const sendBtn = document.getElementById('ai-send');
  const text    = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  input.disabled  = true;
  sendBtn.disabled = true;

  try {
    if (_mode === 'generate') {
      await generateProgram(text);
    } else if (_mode === 'modify') {
      await modifyProgram(text);
    } else {
      await sendQuestion(text);
    }
  } finally {
    input.disabled  = false;
    sendBtn.disabled = false;
    input.focus();
    // Refresh the right panel after each interaction so step count stays current
    updateProgSummary();
    updateQuickChips();
  }
}

// ── Mode: Ask ─────────────────────────────────────────────────
async function sendQuestion(question) {
  appendMsg('user', question);
  _history.push({ role: 'user', text: question });
  showTyping('Thinking…');

  try {
    const res = await fetch(RELAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:   'ai_ask',
        question,
        context:  buildContext(),
        history:  _history.slice(0, -1)
      })
    });
    const data = await res.json();
    hideTyping();

    if (data.ok) {
      appendMsg('model', data.answer);
      _history.push({ role: 'model', text: data.answer });
    } else {
      appendMsg('err', `⚠ ${data.error || 'The assistant could not answer that.'}`);
    }
  } catch (e) {
    hideTyping();
    appendMsg('err', `⚠ Could not reach the relay server (${e.message}). Is relay.py running?`);
  }
}

// ── Mode: Generate ────────────────────────────────────────────
async function generateProgram(prompt) {
  appendMsg('user', prompt);
  showTyping('Generating program…');

  try {
    const res = await fetch(RELAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'ai_generate_program',
        prompt,
        context: {
          positions: positions.map(p => ({ id: p.id, name: p.name, j: p.j, c: p.c })),
          settings: globalSettings
        }
      })
    });
    const data = await res.json();
    hideTyping();

    if (!data.ok) {
      let msg = data.error || 'Could not generate a program.';
      if (data.raw) msg += `\n\nModel's raw output (for debugging):\n\`\`\`\n${data.raw}\n\`\`\``;
      appendMsg('err', `⚠ ${msg}`);
      return;
    }

    const { validateProgram } = await import('./program-validator.js');
    const validation = validateProgram(data.program, positions);
    appendProgramPreview(data.program, validation);
  } catch (e) {
    hideTyping();
    appendMsg('err', `⚠ Could not reach the relay server (${e.message}). Is relay.py running?`);
  }
}

function appendProgramPreview(program, validation) {
  const wrap = document.getElementById('ai-msgs');
  const { errors, warnings, summary } = validation;

  const div = document.createElement('div');
  div.className = 'ai-msg model ai-preview';

  let html = `<div class="ai-preview-title">📋 Generated Program</div>`;
  html += `<div class="ai-preview-summary">${summary.newPositions} new position(s), ${summary.newSteps} new step(s) — will be appended to your current program.</div>`;

  if (errors.length) {
    html += `<div class="ai-preview-errhdr">⚠ ${errors.length} problem(s) — not safe to apply:</div>`;
    html += `<ul class="ai-list ai-err-list">${errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
  }
  if (warnings.length) {
    html += `<div class="ai-preview-warnhdr">Notes:</div>`;
    html += `<ul class="ai-list ai-warn-list">${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
  }
  div.innerHTML = html;

  const btnRow     = document.createElement('div');
  btnRow.className = 'ai-preview-btns';

  const applyBtn   = document.createElement('button');
  applyBtn.className  = 'ai-preview-apply';
  applyBtn.textContent = errors.length ? 'Fix required before applying' : '✓ Apply to Program';
  applyBtn.disabled    = errors.length > 0;

  const discardBtn   = document.createElement('button');
  discardBtn.className  = 'ai-preview-discard';
  discardBtn.textContent = 'Discard';

  applyBtn.addEventListener('click', async () => {
    applyBtn.disabled  = true;
    discardBtn.disabled = true;
    applyBtn.textContent = 'Applying…';
    try {
      await applyProgram(program);
      applyBtn.textContent = '✓ Applied!';
      // Follow-up suggestion
      setTimeout(() => {
        appendMsg('model',
          `Program applied! Added ${summary.newSteps} step(s) and ${summary.newPositions} position(s).\n\n` +
          `Switch to the **Program** tab to review or reorder steps. You can also ask me to **Modify** anything, ` +
          `or switch to **Generate** to build another routine.`
        );
        updateProgSummary();
        updateQuickChips();
      }, 400);
    } catch (e) {
      applyBtn.textContent = 'Apply failed — see below';
      appendMsg('err', `⚠ Failed to apply: ${e.message}`);
      discardBtn.disabled = false;
    }
  });

  discardBtn.addEventListener('click', () => div.remove());

  btnRow.appendChild(applyBtn);
  btnRow.appendChild(discardBtn);
  div.appendChild(btnRow);
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

// ── Apply a generated program to live state ───────────────────
async function applyProgram(program) {
  const stateMod = await import('./state.js');
  const setupMod = await import('./tab-setup.js');
  const progMod  = await import('./tab-program.js');

  const idMap = {};

  const newPositions = (program.positions || []).map(p => {
    const newId    = stateMod.uid();
    idMap[p.id]    = newId;
    return { id: newId, name: p.name, j: p.j, c: p.c || [0, 0, 0, 0, 0, 0] };
  });

  const newSteps = (program.steps || []).map(s => {
    const newId   = stateMod.uid();
    idMap[s.id]   = newId;
    const copy    = { ...s, id: newId };
    ['pid', 'via', 'to'].forEach(field => {
      if (copy[field] && idMap[copy[field]]) copy[field] = idMap[copy[field]];
    });
    return copy;
  });

  stateMod.setPositions([...stateMod.positions, ...newPositions]);
  stateMod.setSteps([...stateMod.steps, ...newSteps]);
  if (program.settings) stateMod.setGlobalSettings(program.settings);

  setupMod.renderPositions();
  progMod.renderSteps();
  progMod.refreshCode();
}

// ── Mode: Modify ──────────────────────────────────────────────
async function modifyProgram(prompt) {
  appendMsg('user', prompt);
  showTyping('Analysing change…');

  try {
    const res = await fetch(RELAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'ai_modify_program',
        prompt,
        context: {
          positions: positions.map(p => ({ id: p.id, name: p.name, j: p.j, c: p.c })),
          steps:     steps.map(s => ({ ...s })),
          settings:  globalSettings
        }
      })
    });
    const data = await res.json();
    hideTyping();

    if (!data.ok) {
      let msg = data.error || 'Could not generate a modification.';
      if (data.raw) msg += `\n\nModel's raw output (for debugging):\n\`\`\`\n${data.raw}\n\`\`\``;
      appendMsg('err', `⚠ ${msg}`);
      return;
    }

    const patch = data.patch || {};
    const { validateProgram } = await import('./program-validator.js');

    let previewCounter = 0;
    const previewUid   = () => '_preview' + (previewCounter++);
    const patchResult  = applyPatchOps(steps, patch.ops, previewUid);

    if (patchResult.errors.length) {
      appendMsg('err', `⚠ Could not apply the suggested changes:\n${patchResult.errors.map(e => `- ${e}`).join('\n')}`);
      return;
    }

    const allPositions = [...positions, ...(patch.newPositions || [])];
    const validation   = validateProgram(
      { positions: patch.newPositions || [], steps: patchResult.steps, settings: {} },
      positions
    );

    appendModificationPreview(patch, patchResult, validation, allPositions);
  } catch (e) {
    hideTyping();
    appendMsg('err', `⚠ Could not reach the relay server (${e.message}). Is relay.py running?`);
  }
}

function appendModificationPreview(patch, patchResult, validation, allPositions) {
  const wrap     = document.getElementById('ai-msgs');
  const { errors, warnings } = validation;
  const { added, removed }   = patchResult;
  const posById  = Object.fromEntries(allPositions.map(p => [p.id, p]));

  const div = document.createElement('div');
  div.className = 'ai-msg model ai-preview';

  let html = `<div class="ai-preview-title">🩹 Proposed Change</div>`;
  html += `<div class="ai-preview-summary">${added.length} step(s) added, ${removed.length} step(s) removed/changed.</div>`;

  if (added.length) {
    html += `<div class="ai-diff-hdr ai-diff-add">➕ Added</div>`;
    html += `<ul class="ai-list ai-diff-add-list">${added.map(s => `<li>${escapeHtml(describeStep(s, posById))}</li>`).join('')}</ul>`;
  }
  if (removed.length) {
    html += `<div class="ai-diff-hdr ai-diff-rem">➖ Removed / Changed</div>`;
    html += `<ul class="ai-list ai-diff-rem-list">${removed.map(s => `<li>${escapeHtml(describeStep(s, posById))}</li>`).join('')}</ul>`;
  }
  if (errors.length) {
    html += `<div class="ai-preview-errhdr">⚠ ${errors.length} problem(s) — not safe to apply:</div>`;
    html += `<ul class="ai-list ai-err-list">${errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
  }
  if (warnings.length) {
    html += `<div class="ai-preview-warnhdr">Notes:</div>`;
    html += `<ul class="ai-list ai-warn-list">${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
  }
  div.innerHTML = html;

  const btnRow   = document.createElement('div');
  btnRow.className = 'ai-preview-btns';

  const applyBtn  = document.createElement('button');
  applyBtn.className  = 'ai-preview-apply';
  applyBtn.textContent = errors.length ? 'Fix required before applying' : '✓ Apply Change';
  applyBtn.disabled    = errors.length > 0;

  const discardBtn  = document.createElement('button');
  discardBtn.className  = 'ai-preview-discard';
  discardBtn.textContent = 'Discard';

  applyBtn.addEventListener('click', async () => {
    applyBtn.disabled  = true;
    discardBtn.disabled = true;
    applyBtn.textContent = 'Applying…';
    try {
      await applyModification(patch);
      applyBtn.textContent = '✓ Applied!';
      setTimeout(() => {
        appendMsg('model', 'Change applied! Review the updated sequence in the **Program** tab. Need anything else changed?');
        updateProgSummary();
        updateQuickChips();
      }, 400);
    } catch (e) {
      applyBtn.textContent = 'Apply failed — see below';
      appendMsg('err', `⚠ Failed to apply: ${e.message}`);
      discardBtn.disabled = false;
    }
  });

  discardBtn.addEventListener('click', () => div.remove());

  btnRow.appendChild(applyBtn);
  btnRow.appendChild(discardBtn);
  div.appendChild(btnRow);
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

// ── Commit modification to live state ─────────────────────────
async function applyModification(patch) {
  const stateMod = await import('./state.js');
  const setupMod = await import('./tab-setup.js');
  const progMod  = await import('./tab-program.js');

  const idMap        = {};
  const newPositions = (patch.newPositions || []).map(p => {
    const newId  = stateMod.uid();
    idMap[p.id]  = newId;
    return { id: newId, name: p.name, j: p.j, c: p.c || [0, 0, 0, 0, 0, 0] };
  });

  const remappedOps = (patch.ops || []).map(op => {
    const remapRefs = s => {
      const copy = { ...s };
      ['pid', 'via', 'to'].forEach(f => { if (copy[f] && idMap[copy[f]]) copy[f] = idMap[copy[f]]; });
      return copy;
    };
    if (op.op === 'replace' && op.step) return { ...op, step: remapRefs(op.step) };
    if ((op.op === 'insert_before' || op.op === 'insert_after') && op.steps) {
      return { ...op, steps: op.steps.map(remapRefs) };
    }
    return op;
  });

  const result = applyPatchOps(stateMod.steps, remappedOps, stateMod.uid);
  if (result.errors.length) throw new Error(result.errors.join('; '));

  if (newPositions.length) stateMod.setPositions([...stateMod.positions, ...newPositions]);
  stateMod.setSteps(result.steps);

  setupMod.renderPositions();
  progMod.renderSteps();
  progMod.refreshCode();
}

// ── Public init ───────────────────────────────────────────────
export function initAiAssistant() {
  const container = document.getElementById('tab-ai');
  if (!container) return; // graceful no-op if old layout

  injectStyles();
  injectTabDom(container);

  // Refresh context panel whenever the AI tab becomes visible
  const aiTabBtn = document.querySelector('.tab[data-target="tab-ai"]');
  if (aiTabBtn) {
    aiTabBtn.addEventListener('click', () => {
      // Small delay so the tab pane is visible before we measure
      setTimeout(updateContextPanel, 50);
    });
  }
}