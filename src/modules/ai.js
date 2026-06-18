/**
 * AI module — OpenRouter API integration for translation and dialogue generation.
 * Supports thinking models and PDF context.
 */
import { toast } from './ui.js';
import * as State from './state.js';
import { setText } from './lang.js';

// Callback for auto-layout (set by canvas.js after initialization to avoid circular imports)
let _autoLayoutFn = null;
export function setAutoLayoutCallback(fn) { _autoLayoutFn = fn; }

// ─── CONFIG ──────────────────────────────────────────
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CONFIG_KEY = 'dialogueForge_ai_config';

let config = {
  apiKey: '',
  model: '',
  temperature: 0.7,
  isThinking: false,
  contextFiles: [],  // [{name, text}]
};

export function getConfig() { return { ...config, contextFiles: [...(config.contextFiles || [])] }; }

export function saveConfig(newConfig) {
  config = { ...config, ...newConfig };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) config = { ...config, ...JSON.parse(raw) };
  } catch { /* ignore */ }
}

// ─── CORE API CALL ───────────────────────────────────
async function callOpenRouter(messages, options = {}) {
  if (!config.apiKey) {
    throw new Error('API Key no configurada. Abre la configuración de IA.');
  }

  const body = {
    model: config.model,
    messages,
    temperature: options.temperature ?? config.temperature,
  };

  if (options.maxTokens) body.max_tokens = options.maxTokens;

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://dialogue-forge.app',
      'X-Title': 'Dialogue Forge',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err?.error?.message || `Error ${response.status}`;
    throw new Error(msg);
  }

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content || '';

  // Handle thinking models — strip <thinking> blocks
  if (config.isThinking) {
    content = stripThinking(content);
  }

  return content.trim();
}

function stripThinking(text) {
  // Remove <thinking>...</thinking> blocks (case insensitive, multiline)
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
}

// ─── TRANSLATION (ES → EN) ─────────────────────────
export async function translateNode(nodeId) {
  const dlg = State.getActiveDialogue();
  if (!dlg) throw new Error('No hay diálogo activo');
  const node = dlg.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error('Nodo no encontrado');

  const sourceText = node.text.es;
  if (!sourceText || !sourceText.trim()) {
    throw new Error('El nodo no tiene texto en ES');
  }

  const messages = [
    {
      role: 'system',
      content: `You are a professional video game dialogue translator. Translate the following game dialogue from Spanish to English.
Preserve the tone, style, character voice, and context of the original dialogue.
Respond ONLY with the translation, no explanations or notes.`
    },
    {
      role: 'user',
      content: sourceText
    }
  ];

  const translated = await callOpenRouter(messages);
  const updatedText = { ...node.text };
  updatedText.en = translated;
  State.updateNodeText(nodeId, updatedText);
  return translated;
}

export async function translateAllNodes() {
  const dlg = State.getActiveDialogue();
  if (!dlg) throw new Error('No hay diálogo activo');

  const nodesToTranslate = dlg.nodes.filter((n) => {
    const source = n.text.es;
    return source && source.trim();
  });

  if (nodesToTranslate.length === 0) {
    throw new Error('No hay nodos con texto en ES para traducir');
  }

  // Batch all texts in one call for efficiency
  const texts = nodesToTranslate.map((n, i) => `[${i + 1}] ${n.text.es}`).join('\n---\n');

  const messages = [
    {
      role: 'system',
      content: `You are a professional video game dialogue translator. Translate game dialogues from Spanish to English.
Preserve the tone, style, and context. You will receive multiple numbered texts separated by "---".
Respond with EACH translation in the same numbered format [N], separated by "---".
ONLY translations, no explanations.`
    },
    {
      role: 'user',
      content: texts
    }
  ];

  const result = await callOpenRouter(messages, { maxTokens: 4096 });

  // Parse results
  const parts = result.split('---').map((p) => p.trim());
  let count = 0;

  for (let i = 0; i < nodesToTranslate.length; i++) {
    const node = nodesToTranslate[i];
    let translated = parts[i] || '';
    // Remove the [N] prefix if present
    translated = translated.replace(/^\[\d+\]\s*/, '').trim();
    if (translated) {
      const updatedText = { ...node.text };
      updatedText.en = translated;
      State.updateNodeText(node.id, updatedText);
      count++;
    }
  }

  return count;
}

// ─── JSON SANITIZER ──────────────────────────────────
function sanitizeJSON(str) {
  // Remove trailing commas before ] or }
  str = str.replace(/,\s*([\]}])/g, '$1');
  // Remove BOM and zero-width characters
  str = str.replace(/[\u200B-\u200D\uFEFF]/g, '');
  return str;
}

// ─── DIALOGUE GENERATION ─────────────────────────────

function buildSystemPrompt(npcName, npcListText, contextBlock, minNodes, maxNodes) {
  return `You are a professional video game dialogue writer. Generate branching dialogues in JSON format.
${npcName ? `The main speaking NPC is named "${npcName}".` : ''}
Available NPCs in the project: [${npcListText}].
${contextBlock}

Respond ONLY with valid JSON in this exact structure:
{
  "nodes": [
    {
      "id": "node_1",
      "npc": "Iris",
      "text_es": "Hola viajero. ¿Qué te trae al cañón?",
      "connections": ["node_player_option_1", "node_player_option_2"]
    },
    {
      "id": "node_player_option_1",
      "npc": "Jugador",
      "text_es": "Busco aventuras.",
      "connections": ["node_npc_response_1"]
    },
    {
      "id": "node_player_option_2",
      "npc": "Jugador",
      "text_es": "Solo estoy de paso.",
      "connections": ["node_npc_response_2"]
    },
    {
      "id": "node_npc_response_1",
      "npc": "Iris",
      "text_es": "Pues has venido al lugar indicado. El cañón está lleno de misterios.",
      "connections": []
    },
    {
      "id": "node_npc_response_2",
      "npc": "Iris",
      "text_es": "Entiendo. Ten cuidado, las rocas aquí pueden ser peligrosas.",
      "connections": []
    }
  ],
  "startNodeId": "node_1"
}

Rules:
- Each node has a unique id (node_1, node_2, etc.)
- npc is the name of the NPC speaking this node.
  * Use "Jugador" (or "Player") for player options/responses.
  * Use one of the available NPCs: [${npcListText}] for NPC dialogues. If a different speaker is needed, write their name and a new NPC will be created.
- text_es is the dialogue text in Spanish (either what the NPC says, or the player's choice text)
- Do NOT include text_en or any English translation.
- connections is a simple array of target node IDs (strings), e.g., ["node_2", "node_3"]. Do NOT include labels or objects.
- Create natural, branching dialogues with multiple player choice options represented as sibling nodes.
- Minimum ${minNodes} nodes, maximum ${maxNodes} nodes.
- Every branch should eventually conclude (nodes with no connections are endings).`;
}

function getContextAndNpcs() {
  let contextBlock = '';
  if (config.contextFiles && config.contextFiles.length > 0) {
    const filesText = config.contextFiles.map((f) => `--- ${f.name} ---\n${f.text}`).join('\n\n');
    contextBlock = `\n\nWorld context documents:\n${filesText.slice(0, 8000)}`;
  }
  const allNpcs = State.getState().npcs || [];
  const npcListText = allNpcs.length > 0 ? allNpcs.map((n) => `"${n.name}"`).join(', ') : 'Ninguno';
  return { contextBlock, npcListText };
}

function parseAIResponse(result) {
  let jsonStr = result;
  const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1];
  const jsonObjMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonObjMatch) jsonStr = jsonObjMatch[0];

  let data;
  try {
    data = JSON.parse(sanitizeJSON(jsonStr));
  } catch {
    throw new Error('La IA no generó un JSON válido. Intenta de nuevo.');
  }
  if (!data.nodes || !Array.isArray(data.nodes) || data.nodes.length === 0) {
    throw new Error('La respuesta no contiene nodos válidos.');
  }
  return data;
}

export async function generateDialogue(prompt, npcName, { minNodes = 5, maxNodes = 15 } = {}) {
  const { contextBlock, npcListText } = getContextAndNpcs();
  const systemPrompt = buildSystemPrompt(npcName, npcListText, contextBlock, minNodes, maxNodes);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt }
  ];

  const dynamicMaxTokens = Math.min(16384, Math.max(4096, maxNodes * 350));
  const result = await callOpenRouter(messages, { temperature: 0.8, maxTokens: dynamicMaxTokens });

  return parseAIResponse(result);
}

// ─── EXTEND EXISTING DIALOGUE ────────────────────────
export async function extendDialogue(prompt, npcName, { minNodes = 5, maxNodes = 15 } = {}) {
  const dlg = State.getActiveDialogue();
  if (!dlg) throw new Error('No hay diálogo activo');

  const { contextBlock, npcListText } = getContextAndNpcs();
  const { normalizeConnection } = await import('./state.js');

  // Find leaf nodes (nodes with empty connections)
  const leafNodes = dlg.nodes.filter((n) => !n.connections || n.connections.length === 0);
  if (leafNodes.length === 0) {
    throw new Error('No hay nodos finales desde los que extender. Todos los nodos tienen conexiones de salida.');
  }

  // Build existing dialogue summary for context
  const existingSummary = dlg.nodes.map((n) => {
    const npc = n.npcId ? State.getNPC(n.npcId) : null;
    const conns = (n.connections || []).map((c) => normalizeConnection(c).targetId);
    return `  - id:"${n.id}" npc:"${npc?.name || '?'}" text:"${(n.text?.es || '').slice(0, 80)}" connections:[${conns.map(c => `"${c}"`).join(',')}]`;
  }).join('\n');

  const leafIds = leafNodes.map((n) => `"${n.id}"`).join(', ');

  const systemPrompt = `You are a professional video game dialogue writer. You must EXTEND an existing dialogue by generating NEW continuation nodes.
${npcName ? `The main speaking NPC is named "${npcName}".` : ''}
Available NPCs in the project: [${npcListText}].
${contextBlock}

The existing dialogue has these nodes:
${existingSummary}

The leaf nodes (endings that need continuation) are: [${leafIds}]

You must generate NEW nodes that continue from one or more of these leaf nodes.

Respond ONLY with valid JSON in this structure:
{
  "nodes": [
    {
      "id": "ext_1",
      "npc": "NPC Name",
      "text_es": "...",
      "connections": ["ext_2"]
    }
  ],
  "linkFrom": {
    "EXISTING_LEAF_NODE_ID": ["ext_1"],
    "ANOTHER_LEAF_ID": ["ext_3"]
  }
}

Rules:
- "nodes" contains ONLY the NEW nodes you are generating (do NOT repeat existing nodes).
- "linkFrom" maps existing leaf node IDs to the new node IDs they should connect to. This connects the existing dialogue to your new content.
- Each new node has a unique id starting with "ext_" (ext_1, ext_2, etc.)
- npc is the name of the NPC speaking. Use "Jugador" for player options/responses.
- connections within new nodes reference other new node IDs only.
- Minimum ${minNodes} new nodes, maximum ${maxNodes} new nodes.
- Do NOT include text_en or any English translation.
- Every new branch should eventually conclude (nodes with empty connections are endings).`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt }
  ];

  const dynamicMaxTokens = Math.min(16384, Math.max(4096, maxNodes * 350));
  const result = await callOpenRouter(messages, { temperature: 0.8, maxTokens: dynamicMaxTokens });
  return parseAIResponse(result);
}

export function insertExtendedDialogue(data) {
  const dlg = State.getActiveDialogue();
  if (!dlg) return 0;

  State.startBatch();

  // Map generated IDs to real IDs
  const idMap = {};
  const startX = 300;
  const startY = 100;
  const spacingY = 180;
  const spacingX = 300;
  const nodesPerRow = 3;

  // Offset new nodes below existing ones
  let maxY = 0;
  dlg.nodes.forEach((n) => { if (n.y > maxY) maxY = n.y; });
  const baseY = maxY + spacingY + 100;

  data.nodes.forEach((genNode, i) => {
    const row = Math.floor(i / nodesPerRow);
    const col = i % nodesPerRow;
    const x = startX + col * spacingX;
    const y = baseY + row * spacingY;

    const realNode = State.addNode(x, y);
    if (realNode) {
      idMap[genNode.id] = realNode.id;
      const textObj = {
        es: genNode.text_es || genNode.text || '',
        en: '',
      };
      State.updateNodeText(realNode.id, textObj);

      if (genNode.npc && genNode.npc.trim()) {
        const npcs = State.getState().npcs || [];
        const npcNameClean = genNode.npc.trim();
        let targetNpc = npcs.find((n) => n.name.toLowerCase() === npcNameClean.toLowerCase());
        if (!targetNpc) {
          targetNpc = State.addNPC(npcNameClean);
        }
        if (targetNpc) {
          State.updateNodeNPC(realNode.id, targetNpc.id);
        }
      }
    }
  });

  // Set connections between new nodes
  data.nodes.forEach((genNode) => {
    const realSourceId = idMap[genNode.id];
    if (!realSourceId || !genNode.connections) return;
    genNode.connections.forEach((conn) => {
      const targetGenId = typeof conn === 'string' ? conn : conn.targetId;
      const realTargetId = idMap[targetGenId];
      if (realTargetId) {
        State.addConnection(realSourceId, realTargetId);
      }
    });
  });

  // Link existing leaf nodes to new nodes
  if (data.linkFrom) {
    Object.entries(data.linkFrom).forEach(([existingId, newIds]) => {
      // existingId is the real ID of the leaf node in the existing dialogue
      const existingNode = dlg.nodes.find((n) => n.id === existingId);
      if (!existingNode) return;
      (newIds || []).forEach((newGenId) => {
        const realNewId = idMap[newGenId];
        if (realNewId) {
          State.addConnection(existingId, realNewId);
        }
      });
    });
  }

  State.endBatch();

  // Auto-layout to organize
  setTimeout(() => { if (_autoLayoutFn) _autoLayoutFn(); }, 50);

  return Object.keys(idMap).length;
}

export function insertGeneratedDialogue(data) {
  const dlg = State.getActiveDialogue();
  if (!dlg) return;

  State.startBatch();

  // Map generated IDs to real IDs
  const idMap = {};
  const startX = 300;
  const startY = 100;
  const spacingY = 180;
  const spacingX = 300;

  // Simple layout: arrange in rows
  const nodesPerRow = 3;

  data.nodes.forEach((genNode, i) => {
    const row = Math.floor(i / nodesPerRow);
    const col = i % nodesPerRow;
    const x = startX + col * spacingX;
    const y = startY + row * spacingY;

    const realNode = State.addNode(x, y);
    if (realNode) {
      idMap[genNode.id] = realNode.id;
      const textObj = {
        es: genNode.text_es || genNode.text || '',
        en: '',
      };
      State.updateNodeText(realNode.id, textObj);

      // Asignar NPC al nodo
      if (genNode.npc && genNode.npc.trim()) {
        const npcs = State.getState().npcs || [];
        const npcNameClean = genNode.npc.trim();
        let targetNpc = npcs.find((n) => n.name.toLowerCase() === npcNameClean.toLowerCase());
        if (!targetNpc) {
          // Si no existe, creamos el NPC nuevo
          targetNpc = State.addNPC(npcNameClean);
        }
        if (targetNpc) {
          State.updateNodeNPC(realNode.id, targetNpc.id);
        }
      }
    }
  });

  // Set connections (handle both string ID and legacy object format)
  data.nodes.forEach((genNode) => {
    const realSourceId = idMap[genNode.id];
    if (!realSourceId || !genNode.connections) return;

    genNode.connections.forEach((conn) => {
      const targetGenId = typeof conn === 'string' ? conn : conn.targetId;
      const realTargetId = idMap[targetGenId];
      if (realTargetId) {
        State.addConnection(realSourceId, realTargetId);
      }
    });
  });

  // Set start node
  if (data.startNodeId && idMap[data.startNodeId]) {
    State.setStartNode(idMap[data.startNodeId]);
  }

  State.endBatch();

  // Auto-layout to organize the generated tree
  setTimeout(() => { if (_autoLayoutFn) _autoLayoutFn(); }, 50);

  return Object.keys(idMap).length;
}

// ─── FILE PARSING (PDF & MD) ─────────────────────────
export async function extractFileText(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'md' || ext === 'txt') {
    return extractTextFile(file);
  }
  if (ext === 'pdf') {
    return extractPdfText(file);
  }
  throw new Error(`Formato no soportado: .${ext}. Usa .pdf, .md o .txt`);
}

function extractTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Error al leer el archivo'));
    reader.readAsText(file);
  });
}

let pdfjsModule = null;

async function loadPdfJs() {
  if (pdfjsModule) return pdfjsModule;
  try {
    const pdfjs = await import('pdfjs-dist');
    // Run on main thread to avoid worker URL resolution issues with Vite bundling.
    // Acceptable for dialogue context files which are typically small.
    pdfjs.GlobalWorkerOptions.workerSrc = '';
    pdfjsModule = pdfjs;
    return pdfjsModule;
  } catch (err) {
    throw new Error('Error al cargar la librería PDF: ' + err.message);
  }
}

async function extractPdfText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const typedArray = new Uint8Array(e.target.result);
        const pdfjs = await loadPdfJs();
        const pdf = await pdfjs.getDocument(typedArray).promise;
        let fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          const pageText = content.items.map((item) => item.str).join(' ');
          fullText += pageText + '\n\n';
        }
        resolve(fullText.trim());
      } catch (err) {
        reject(new Error('Error al leer el PDF: ' + err.message));
      }
    };
    reader.onerror = () => reject(new Error('Error al cargar el archivo'));
    reader.readAsArrayBuffer(file);
  });
}

// Init
loadConfig();
