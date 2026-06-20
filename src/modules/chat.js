/**
 * AI Chat — Integrated AI assistant for dialogue authoring.
 * Can read and write the project state through structured JSON actions.
 */
import { $, esc } from '../utils/helpers.js';
import * as State from './state.js';
import * as AI from './ai.js';
import { buildChatSystemPrompt } from './prompts.js';

// ─── MODULE STATE ─────────────────────────────────────
let chatHistory = []; // [{role, content, actionSummary}]
let isOpen = false;
let isLoading = false;
let _onRender = null;
let _autoLayout = null;

// ─── PROJECT CONTEXT BUILDER ──────────────────────────
/** Serializes the current project state for injection into the system prompt. */
function buildProjectContext() {
  const state = State.getState();
  const dlg = State.getActiveDialogue();

  const npcsText = state.npcs.length > 0
    ? state.npcs.map(n => `  [ID:${n.id}] "${n.name}" color:${n.color || 'default'}`).join('\n')
    : '  (none)';

  const questsText = state.quests.length > 0
    ? state.quests.map(q => `  [ID:${q.id}] "${q.name}"`).join('\n')
    : '  (none)';

  let activeDlgText;
  if (!dlg) {
    activeDlgText = '  (none selected — user must select or create a dialogue first)';
  } else {
    const dlgNpc = dlg.npcId ? State.getNPC(dlg.npcId) : null;
    const nodesText = dlg.nodes.map(n => {
      const npc = n.npcId ? State.getNPC(n.npcId) : null;
      const conns = (n.connections || [])
        .map(c => State.normalizeConnection(c).targetId)
        .join(', ');
      const flags = [
        n.id === dlg.startNodeId ? '[START]' : '',
        n.condition ? `[IF:${n.condition.slice(0, 30)}]` : '',
        n.action ? `[DO:${n.action.slice(0, 30)}]` : '',
      ].filter(Boolean).join(' ');
      return `    [ID:${n.id}] NPC:"${npc?.name || '-'}" ES:"${(n.text?.es || '').slice(0, 70)}" EN:"${(n.text?.en || '').slice(0, 70)}" → [${conns || 'no outgoing'}] ${flags}`;
    }).join('\n');

    activeDlgText = `  Title:"${dlg.title}" [ID:${dlg.id}]
  Main NPC: ${dlgNpc?.name || 'none'}
  Nodes (${dlg.nodes.length}):
${nodesText || '    (empty)'}`;
  }

  const otherDlgs = state.dialogues
    .filter(d => d.id !== dlg?.id)
    .map(d => `  [ID:${d.id}] "${d.title}" (${d.nodes.length} nodes)`)
    .join('\n') || '  (none)';

  return `NPCs (${state.npcs.length}):
${npcsText}

Quests (${state.quests.length}):
${questsText}

Active Dialogue:
${activeDlgText}

Other Dialogues:
${otherDlgs}`;
}

// ─── ACTION EXECUTOR ─────────────────────────────────
/**
 * Executes the structured actions returned by the AI.
 * Maintains a tempIdMap so the AI can reference newly created nodes
 * by their temp_id within the same response.
 * @returns {string[]} Human-readable summary lines.
 */
function executeActions(actions) {
  if (!actions || actions.length === 0) return [];

  const tempIdMap = {}; // temp_id string → real node ID
  const summary = [];
  let addedCount = 0;

  // Resolve a user-supplied ID: could be a temp_id or a real node ID
  const resolveId = (id) => (id ? (tempIdMap[id] || id) : null);

  // Calculate base Y for auto-positioned new nodes (below existing ones)
  const dlg = State.getActiveDialogue();
  let baseY = 120;
  if (dlg && dlg.nodes.length > 0) {
    baseY = Math.max(...dlg.nodes.map(n => (n.y || 0) + (n.height || 160))) + 80;
  }

  // Start a batch for state changes so we get one undo checkpoint and one re-render.
  // Always batch because even a single add_node can trigger multiple internal mutations
  // (addNode + addNPC + updateNodeNPC) that would otherwise create separate undo entries.
  const mutatingActions = actions.filter(a => a.type !== 'auto_layout');
  const useBatch = mutatingActions.length > 0;
  if (useBatch) State.startBatch();

  let needsAutoLayout = false;

  for (const action of actions) {
    try {
      switch (action.type) {

        case 'add_node': {
          const activeDlg = State.getActiveDialogue();
          if (!activeDlg) { summary.push('⚠ No active dialogue'); break; }

          // Auto-position in a 3-column grid if the AI didn't specify coordinates
          const COLS = 3;
          const col = addedCount % COLS;
          const row = Math.floor(addedCount / COLS);
          const x = action.x !== undefined ? action.x : 80 + col * 300;
          const y = action.y !== undefined ? action.y : baseY + row * 210;

          const node = State.addNode(x, y);
          if (node) {
            if (action.temp_id) tempIdMap[action.temp_id] = node.id;

            // Set text
            if (action.text_es !== undefined || action.text_en !== undefined) {
              State.updateNodeText(node.id, {
                es: action.text_es || '',
                en: action.text_en || '',
              });
            }

            // Assign or create NPC
            if (action.npc && action.npc.trim()) {
              const npcName = action.npc.trim();
              const npcs = State.getState().npcs;
              let npc = npcs.find(n => n.name.toLowerCase() === npcName.toLowerCase());
              if (!npc) npc = State.addNPC(npcName);
              if (npc) State.updateNodeNPC(node.id, npc.id);
            }

            addedCount++;
            const preview = action.text_es ? `"${action.text_es.slice(0, 40)}"` : '(no text)';
            summary.push(`✓ Node created: ${preview}`);
          }
          break;
        }

        case 'update_node': {
          const nodeId = resolveId(action.node_id);
          const activeDlg = State.getActiveDialogue();
          if (!activeDlg || !nodeId) { summary.push('⚠ Invalid node ID'); break; }

          const node = activeDlg.nodes.find(n => n.id === nodeId);
          if (!node) { summary.push(`⚠ Node not found: ${action.node_id}`); break; }

          if (action.text_es !== undefined || action.text_en !== undefined) {
            State.updateNodeText(nodeId, {
              es: action.text_es !== undefined ? action.text_es : (node.text?.es || ''),
              en: action.text_en !== undefined ? action.text_en : (node.text?.en || ''),
            });
          }

          if (action.npc && action.npc.trim()) {
            const npcName = action.npc.trim();
            const npcs = State.getState().npcs;
            let npc = npcs.find(n => n.name.toLowerCase() === npcName.toLowerCase());
            if (!npc) npc = State.addNPC(npcName);
            if (npc) State.updateNodeNPC(nodeId, npc.id);
          }

          summary.push(`✓ Node updated: ...${nodeId.slice(-6)}`);
          break;
        }

        case 'connect_nodes': {
          const sourceId = resolveId(action.source_id);
          const targetId = resolveId(action.target_id);
          if (!sourceId || !targetId) { summary.push('⚠ Invalid connection IDs'); break; }
          State.addConnection(sourceId, targetId);
          summary.push(`✓ Connected: ...${sourceId.slice(-5)} → ...${targetId.slice(-5)}`);
          break;
        }

        case 'delete_node': {
          const nodeId = resolveId(action.node_id);
          if (!nodeId) { summary.push('⚠ Invalid node ID'); break; }
          State.deleteNode(nodeId);
          summary.push(`✓ Node deleted`);
          break;
        }

        case 'set_start_node': {
          const nodeId = resolveId(action.node_id);
          if (!nodeId) { summary.push('⚠ Invalid node ID'); break; }
          State.setStartNode(nodeId);
          summary.push(`✓ Start node set`);
          break;
        }

        case 'create_npc': {
          const name = action.name?.trim();
          if (!name) { summary.push('⚠ Empty NPC name'); break; }
          const existing = State.getState().npcs.find(n => n.name.toLowerCase() === name.toLowerCase());
          if (existing) {
            summary.push(`ℹ NPC already exists: "${name}"`);
          } else {
            const npc = State.addNPC(name);
            if (npc && action.color) State.updateNPCColor(npc.id, action.color);
            summary.push(`✓ NPC created: "${name}"`);
          }
          break;
        }

        case 'auto_layout': {
          needsAutoLayout = true;
          summary.push(`✓ Auto-layout applied`);
          break;
        }

        default:
          summary.push(`⚠ Unknown action: ${action.type}`);
      }
    } catch (err) {
      summary.push(`⚠ Error in ${action.type}: ${err.message}`);
    }
  }

  if (useBatch) State.endBatch();

  // Run auto-layout after state settles
  if ((needsAutoLayout || addedCount >= 3) && _autoLayout) {
    setTimeout(() => _autoLayout(), 80);
  }

  return summary;
}

// ─── PARSE AI RESPONSE ───────────────────────────────
function parseAIResponse(raw) {
  let jsonStr = raw;

  // Strip markdown code fences
  const codeMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) {
    jsonStr = codeMatch[1].trim();
  } else {
    // Try to grab the outermost JSON object
    const objMatch = raw.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      message: typeof parsed.message === 'string' ? parsed.message : raw,
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
    };
  } catch {
    // Graceful degradation — show the raw text as a plain message
    return { message: raw, actions: [] };
  }
}

// ─── UI ──────────────────────────────────────────────
function renderMessages() {
  const messagesEl = $('#chat-messages');
  if (!messagesEl) return;

  messagesEl.innerHTML = chatHistory.map((msg) => {
    const isUser = msg.role === 'user';
    const contentHtml = esc(msg.content).replace(/\n/g, '<br>');
    const summaryHtml = msg.actionSummary && msg.actionSummary.length > 0
      ? `<div class="chat-action-summary">${msg.actionSummary.map(s => `<div class="chat-action-item">${esc(s)}</div>`).join('')}</div>`
      : '';
    return `
      <div class="chat-msg ${isUser ? 'chat-msg-user' : 'chat-msg-assistant'}">
        ${!isUser ? '<div class="chat-msg-avatar">✦</div>' : ''}
        <div class="chat-msg-body">
          <div class="chat-bubble">${contentHtml}</div>
          ${summaryHtml}
        </div>
      </div>`;
  }).join('');

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateContextLabel() {
  const label = $('#chat-context-label');
  if (!label) return;
  const dlg = State.getActiveDialogue();
  label.textContent = dlg
    ? `${dlg.title} · ${dlg.nodes.length} nodos`
    : 'Sin diálogo activo';
}

function showTypingIndicator() {
  const messagesEl = $('#chat-messages');
  if (!messagesEl) return;
  const el = document.createElement('div');
  el.id = 'chat-typing';
  el.className = 'chat-msg chat-msg-assistant';
  el.innerHTML = `
    <div class="chat-msg-avatar">✦</div>
    <div class="chat-msg-body">
      <div class="chat-bubble chat-typing-bubble">
        <span class="chat-dot"></span>
        <span class="chat-dot"></span>
        <span class="chat-dot"></span>
      </div>
    </div>`;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideTypingIndicator() {
  const el = document.getElementById('chat-typing');
  if (el) el.remove();
}

// ─── SEND MESSAGE ────────────────────────────────────
async function sendMessage() {
  if (isLoading) return;
  const inputEl = $('#chat-input');
  if (!inputEl) return;
  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = '';
  inputEl.style.height = 'auto';

  chatHistory.push({ role: 'user', content: text });
  renderMessages();

  isLoading = true;
  showTypingIndicator();

  try {
    const aiConfig = AI.getConfig();
    if (!aiConfig.apiKey) {
      throw new Error('API Key no configurada. Abre "IA Config" en la barra de herramientas para configurarla.');
    }

    const systemPrompt = buildChatSystemPrompt(buildProjectContext());

    // ─── Inject context from IA Config settings ───────
    // contextPrompt: global instruction set by the user (e.g. "Always write in medieval Spanish")
    // contextFiles: uploaded PDFs / MDs with world lore, game bible, etc.
    let worldContextBlock = '';
    if (aiConfig.contextPrompt && aiConfig.contextPrompt.trim()) {
      worldContextBlock += `\n\n## Global Context (from IA Config)\n${aiConfig.contextPrompt.trim()}`;
    }
    if (aiConfig.contextFiles && aiConfig.contextFiles.length > 0) {
      const filesText = aiConfig.contextFiles
        .map(f => `--- ${f.name} ---\n${f.text}`)
        .join('\n\n');
      worldContextBlock += `\n\n## World Context Documents\n${filesText.slice(0, 8000)}`;
    }
    const fullSystemPrompt = worldContextBlock
      ? systemPrompt + worldContextBlock
      : systemPrompt;

    // Last 20 messages to keep context window manageable
    const historyForAPI = chatHistory.slice(-20).map(m => ({
      role: m.role,
      content: m.content,
    }));

    const raw = await AI.callAI(
      [{ role: 'system', content: fullSystemPrompt }, ...historyForAPI],
      { model: aiConfig.modelChat, maxTokens: 2048 }
    );

    const { message, actions } = parseAIResponse(raw);

    let actionSummary = [];
    if (actions.length > 0) {
      actionSummary = executeActions(actions);
      if (_onRender) _onRender();
    }

    chatHistory.push({ role: 'assistant', content: message, actionSummary });

  } catch (err) {
    chatHistory.push({
      role: 'assistant',
      content: `⚠ ${err.message}`,
      actionSummary: [],
    });
  } finally {
    isLoading = false;
    hideTypingIndicator();
    renderMessages();
    updateContextLabel();
  }
}

// ─── PANEL TOGGLE ─────────────────────────────────────
function openPanel() {
  isOpen = true;
  $('#ai-chat-panel')?.classList.add('open');
  $('#btn-chat-toggle')?.classList.add('active');
  updateContextLabel();
  setTimeout(() => $('#chat-input')?.focus(), 200);
}

function closePanel() {
  isOpen = false;
  $('#ai-chat-panel')?.classList.remove('open');
  $('#btn-chat-toggle')?.classList.remove('active');
}

/** Called from main.js when the app state changes, to keep the context label fresh. */
export function onStateChange() {
  if (isOpen) updateContextLabel();
}

// ─── SETUP ───────────────────────────────────────────
export function setup(renderAll, autoLayout) {
  _onRender = renderAll;
  _autoLayout = autoLayout;

  // Toolbar toggle button
  $('#btn-chat-toggle')?.addEventListener('click', () => {
    isOpen ? closePanel() : openPanel();
  });

  // Panel close/minimize button
  $('#chat-minimize')?.addEventListener('click', closePanel);

  // Send button
  $('#chat-send')?.addEventListener('click', sendMessage);

  // Textarea: Enter = send, Shift+Enter = newline, auto-resize
  const inputEl = $('#chat-input');
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });
  }

  // Quick action chips
  document.querySelectorAll('.chat-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (isLoading) return;
      const msg = btn.dataset.msg;
      if (!msg) return;
      const input = $('#chat-input');
      if (input) {
        input.value = msg;
        sendMessage();
      }
    });
  });

  // Welcome message
  chatHistory.push({
    role: 'assistant',
    content: 'Hola. Soy tu asistente de diálogos. Puedo crear nodos, conectarlos, escribir diálogos completos, modificar texto, crear NPCs y responder preguntas sobre el proyecto. ¿Con qué empezamos?',
    actionSummary: [],
  });
  renderMessages();
}
