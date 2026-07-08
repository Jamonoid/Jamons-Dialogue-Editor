# Dialogue Forge — AI Agent Guide

## Project Overview

**Dialogue Forge** is a standalone desktop application (Electron + Vite) for creating branched dialogue trees for games.

## Tech Stack

| Technology | Purpose |
|---|---|
| **Electron** | Desktop app wrapper (standalone .exe) |
| **Vite** | Dev server with HMR, build tool |
| **Vanilla JS (ES Modules)** | All app logic — no React/Vue/frameworks |
| **Vanilla CSS** | Styling — dark theme, no Tailwind |
| **localStorage** | Data persistence |
| **JSON** | Export/import format |
| **OpenRouter API** | AI translation & dialogue generation (HTTP, per-token) |
| **Claude Code CLI** | Alternative AI provider using the local Claude subscription (no API key) |
| **MCP (Model Context Protocol)** | Embedded server so external Claude Code / CLI can drive the app |

## Architecture

```
electron/
  main.js          → Electron main process (window creation, IPC, Claude Code spawn, MCP server startup)
  preload.js       → Secure bridge between main and renderer
  mcp-server.js    → Embedded MCP server (Streamable HTTP on 127.0.0.1:4747) exposing project tools

src/
  main.js          → App entry point, wires all modules together
  style.css        → Complete CSS theme (dark mode, glassmorphism)
  modules/
    state.js       → Global state, CRUD operations, persistence
    canvas.js      → Canvas: pan, zoom, SVG connections
    nodes.js       → Node rendering, drag & drop, inline editing, connection drawing
    inspector.js   → Right panel: property editing, AI actions per node/dialogue
    sidebar.js     → Left panel: NPC/Quest/Dialogue lists, collapsible sections
    ui.js          → Modals, toasts, context menus, confirmDelete, AI settings/generate modals
    lang.js        → Language toggle (ES/EN)
    ai.js          → Multi-provider AI: OpenRouter (HTTP) + Claude Code (local CLI via IPC); per-task dispatcher, translation, generation, PDF/MD parsing
    chat.js        → Integrated AI chat assistant: floating panel, action executor, project context builder
    mcp-bridge.js  → Renderer-side executor for MCP tools (window.__mcpExecute); runs edits against live State
    prompts.js     → Centralized AI prompt templates (translation, generation, extension, chat)
  utils/
    helpers.js     → uid(), $(), $$(), esc()
```

## Key Concepts

### Bilingual Text Fields
Every text field in dialogue nodes is a `{ es: string, en: string }` object. The active editing language is controlled by a toggle in the toolbar. The `lang.js` module provides helpers:
- `t(textObj)` — get text for current language
- `setText(textObj, value)` — set text for current language
- `newText(value)` — create new bilingual text with value in current language

### Inline Node Editing
Nodes contain a `<textarea>` that allows direct inline text editing on the canvas. The textarea auto-resizes as the user types, and syncs with the inspector panel. When a node textarea is focused, canvas re-renders are skipped to preserve focus.

### State Management
`state.js` is the single source of truth. All CRUD operations go through it. It emits changes via an `onChange` callback that triggers re-renders. The state shape:

```js
{
  npcs: [{ id, name, color }],
  quests: [{ id, name }],
  dialogues: [{
    id, title, npcId, questId, startNodeId,
    nodes: [{
      id,
      text: { es, en },
      x, y, width, height,
      npcId,
      connections: [{ targetId: string, label: string }, ...]  // Normalized connection objects
    }]
  }]
}
```

> **IMPORTANT**: Connections are always objects `{ targetId, label }`, never plain strings. Use `normalizeConnection(c)` from `state.js` when reading connections to handle any legacy string format. Never use `.includes(nodeId)` on connections arrays — use `.some(c => normalizeConnection(c).targetId === nodeId)`.

#### Selection Model
Selection uses a `Set<string>` internally (`selectedNodeIds`). The API provides:
- `getSelectedNodeId()` — backward-compat, returns first ID or null
- `setSelectedNodeId(id)` — clear + select one
- `getSelectedNodeIds()` — full Set
- `isNodeSelected(id)`, `toggleNodeSelection(id)`, `addToSelection(id)`, `clearSelection()`

Multi-select interactions:
- **Shift+click** on a node toggles it in the selection
- **Shift+drag** on empty canvas draws a selection rectangle
- Dragging a selected node moves ALL selected nodes
- **Delete** key removes all selected nodes
- Inspector shows "N nodos seleccionados" with bulk delete

#### File Persistence (Electron IPC)
When running in Electron, the app supports file-based persistence:
- `saveToFile()` — saves to disk via `dialog:save` IPC (falls back to `localStorage`)
- `loadFromFile()` — opens file via `dialog:open` IPC
- `currentFilePath` tracks the open file; shown in window title and status bar
- `localStorage` is always used as backup

### Canvas Interactions

#### Camera Persistence (Q10)
Camera position (pan offset + zoom) is saved per dialogue in a memory cache. When switching between dialogues, the camera restores to where you were last looking. This is in-memory only (resets on app restart).

#### Connection Hover Highlighting (Q3)
Hovering over a connection path highlights both the source and target nodes with `.conn-highlighted` class and thickens the connection line.

#### Connection Drag Feedback (Q13)
When dragging from an output connector to create a connection, all valid input connectors glow with `.connect-target-highlight` class.

#### Snap-to-Grid
Toggled via the ⬥ button in canvas controls. When active, node positions snap to a 24px grid during drag. State persisted in `localStorage`.

#### Connection Right-Click
SVG connection paths render with invisible fat hit-areas (12px stroke) for easier clicking. Right-click shows a context menu to delete the connection.

### AI Integration (multi-provider)

The `ai.js` module supports two AI providers, selectable **per task** (generate / translate / chat):

- **OpenRouter** — HTTP API, needs an API key, pay-per-token. `callOpenRouter()`.
- **Claude Code** — runs the user's locally installed `claude` CLI via Electron IPC (`window.electronAPI.claudeCall`), using the Claude Pro/Max subscription (no API key). `callClaudeCode()`. Desktop-only.

`callProvider(messages, { task })` is the dispatcher: it reads `config.provider{Generate,Translate,Chat}` (`'openrouter' | 'claude'`) and routes accordingly. All internal call sites go through it. All prompt templates are centralized in `prompts.js`.

#### Claude Code provider (Electron main)
- `electron/main.js` spawns `claude -p --output-format json --model <model>`; the system prompt + prompt are sent via **stdin** (avoids Windows arg-length/escaping limits). The model arg is regex-validated (`/^[a-zA-Z0-9._-]+$/`).
- IPC handlers: `ai:claude-call` (generation), `ai:claude-check` (CLI availability). Both return `{ ok, text | error }` with friendly Spanish messages for not-logged-in / rate-limit / overload.
- Requires the `claude` CLI on the system PATH and a logged-in session (`claude` → `/login`).
- Model field accepts aliases: `sonnet`, `opus`, `haiku` (defaults to `sonnet`).

### External control via MCP

An **embedded MCP server** (`electron/mcp-server.js`, Streamable HTTP on `http://127.0.0.1:4747/mcp`) lets an *external* Claude Code session — e.g. from your GDD/story repo — read and edit the project without using the in-app chat. It boots in `app.whenReady()` and forwards each tool call to the renderer via `win.webContents.executeJavaScript('window.__mcpExecute(...)')`, so edits run on the live canvas with normal undo/redo and persistence.

Register once (user scope, available from any repo) while Dialogue Forge is open:
```bash
claude mcp add --transport http --scope user dialogue-forge http://127.0.0.1:4747/mcp
```

Tools (`src/modules/mcp-bridge.js`, all operate on the **active** dialogue unless noted):
- **Read**: `get_project_summary`, `get_dialogue`
- **Edit**: `create_dialogue`, `set_active_dialogue`, `add_node`, `update_node`, `connect_nodes`, `delete_node`, `set_start_node`, `create_npc`, `auto_layout`

The MCP server only responds while the app window is open; tool calls return `{ ok: false, error }` if the window is closed or the bridge hasn't loaded.

The `ai.js` module integrates with the OpenRouter API. All prompt templates are centralized in `prompts.js` for easy editing.

#### Prompts (`prompts.js`)
- `TRANSLATE_SINGLE_SYSTEM` — System prompt for single node translation
- `TRANSLATE_BATCH_SYSTEM` — System prompt for batch translation
- `buildGenerateSystemPrompt(...)` — Builds the system prompt for new dialogue generation
- `buildExtendSystemPrompt(...)` — Builds the system prompt for extending existing dialogues

Translation prompts explicitly instruct the AI to preserve profanity, slang, and vulgar language without censoring.

#### Configuration (stored in localStorage)
```js
{
  apiKey: string,              // OpenRouter API key (only used by the OpenRouter provider)
  modelGenerate: string,       // Model for dialogue generation & extension (e.g. 'anthropic/claude-sonnet-4' or 'sonnet')
  modelTranslate: string,      // Model for ES→EN translation (e.g. 'google/gemini-2.5-flash')
  modelChat: string,           // Model for the integrated chat assistant
  providerGenerate: string,    // 'openrouter' | 'claude' — provider for generation/extension
  providerTranslate: string,   // 'openrouter' | 'claude' — provider for translation
  providerChat: string,        // 'openrouter' | 'claude' — provider for chat
  temperature: number,         // Default 0.7 (OpenRouter only)
  isThinking: boolean,         // Strip <thinking> blocks from response
  contextFiles: [{name, text}],  // Multiple PDF/MD/TXT files for context
  contextPrompt: string        // Global context prompt
}
```
Legacy configs with a single `model` field are auto-migrated to all three on first load. Missing `provider*` fields default to `'openrouter'`. The settings modal (`ui.js`) shows a provider dropdown next to each per-task model input; the model field placeholder/hint switches between OpenRouter model IDs and Claude aliases based on the selected provider.

#### Translation (ES → EN only)
- `translateNode(nodeId)` — Translates a single node's Spanish text to English
- `translateAllNodes()` — Batch-translates all nodes that have ES text but no EN text
- All prompts sent to the AI are in **English**
- Accessible from: toolbar button, inspector (per-node or per-dialogue)

## Future Plans

- **Search**: Find nodes by text content.
- **Dialogue Simulator**: Interactive chat modal to test dialogue trees.
- **Minimap**: Visual overview of large dialogue trees.
- ~~**Sidebar Drag & Drop**~~: ✅ Implemented — Reorder NPCs, Quests, Dialogues by dragging items in the sidebar. Uses `State.reorderList(collection, fromIndex, toIndex)`.
- **Copy/Paste Nodes**: Ctrl+C/V for duplicating nodes.
- **Project Statistics**: Dashboard showing total NPCs, nodes, translation coverage.

### Audio Slicer (`src/modules/audio-slicer.js`)
Self-contained tool for splitting dialogue recordings into individual audio clips.
- **Toolbar button**: "Audio Slicer" in toolbar opens a full-screen overlay
- **Audio loading**: Drag & drop or file picker. Supports `.wav`, `.mp3`, `.ogg`
- **Waveform**: Rendered on `<canvas>` via `AudioContext.decodeAudioData()`. Two stacked canvases: waveform (static) + overlay (markers/cursor, re-rendered on interaction)
- **Markers**: Click waveform to add cut markers. Drag to reposition. Right-click to delete
- **Zoom/Scroll**: Ctrl+Wheel = zoom, Wheel = horizontal scroll
- **Playback**: `AudioBufferSourceNode` for segment previews. Animated cursor via `requestAnimationFrame`
- **Segments list**: Editable names, play buttons, time ranges
- **Export**: `wav-encoder.js` for pure JS WAV encoding (44-byte header + Int16 PCM). JSZip (lazy-imported) for .zip bundle export
- **State**: Fully self-contained (no interaction with dialogue State module)

#### Dialogue Generation
- `generateDialogue(prompt, npcName)` — Generates a branching dialogue tree from a prompt
- `insertGeneratedDialogue(data)` — Inserts the generated nodes and connections into the canvas
- Uses context files and global prompt for additional context
- Output is JSON with `{ nodes: [{id, text_es, text_en, connections}], startNodeId }`

#### File Parsing
- `extractFileText(file)` — Dispatches to PDF or text parser based on extension
- Supports `.pdf` (via PDF.js CDN), `.md`, and `.txt` files
- Multiple files can be added as context in the AI settings modal

### Module Communication
Modules communicate via:
1. **Callbacks** — set up in `main.js` (e.g., `State.onChange(renderAll)`)
2. **Custom events** — `langchange` event on `document` for language switches
3. **Direct imports** — modules import `state.js` for data access

## Development

```bash
npm run dev      # Start Vite + Electron in parallel
npm run build    # Build for production (dist/)
```

## Conventions

- **Language**: Code is in English. UI text is in Spanish.
- **AI Prompts**: All system prompts sent to the LLM are in English.
- **No frameworks**: Pure vanilla JS with ES modules.
- **XSS Prevention**: All user-provided strings (NPC names, dialogue titles, quest names) MUST be escaped with `esc()` from `helpers.js` before inserting into HTML templates.
- **Delete Confirmation**: Destructive actions (delete NPC, Quest, Dialogue) use `confirmDelete(message, onConfirm)` from `ui.js` to show a confirmation modal.
- **IDs**: Generated with `uid()` (timestamp + counter + random base36). Counter prevents collisions during batch creation.
- **CSS**: All custom properties in `:root`. No utility classes.
- **Event cleanup**: Global listeners use `window._handlerName` pattern for cleanup on re-render.
- **Node editing**: Inline textarea on canvas + inspector panel. Canvas skips re-render when textarea is focused.
- **Undo/Redo**: Ctrl+Z and Ctrl+Y are only intercepted when the user is NOT in a text input field. Inside inputs/textareas, the browser's native undo/redo works normally.
- **NPC Colors**: Users can customize NPC colors via `<input type="color">` in the inspector. Use `State.updateNPCColor(id, color)`. Colors are stored in `npc.color`.
- **Sidebar Sections**: Collapsible via click on section header. State saved in localStorage (`df_collapsed_sections`).
- **Session Persistence**: Active dialogue ID is saved in localStorage (`df_activeDialogueId`) and restored on app load.
- **Unsaved Changes**: Electron main process shows a native dialog when closing with unsaved changes. Renderer exposes `window.__dialogueForgeDirty()` and `window.__dialogueForgeSave()`.
- **Connection Reordering**: Outgoing connections can be reordered via ▲/▼ buttons in inspector. Use `State.reorderConnection(sourceId, targetId, 'up'|'down')`.
- **Connection Navigation**: Clicking a connection card in the inspector navigates to and selects the target node.
- **API Errors**: `callOpenRouter()` returns descriptive Spanish error messages for common HTTP status codes (401, 402, 404, 429, 503).
- **Undo Flood Prevention**: When editing properties that emit continuous events (like color pickers on `input`), the app registers a `focus` or `mousedown` event listener to trigger `State.pushUndoCheckpoint()` once before editing begins, avoiding saturating the undo/redo stacks.
- **Connection Navigation Click Guards**: Clicking a connection card in the inspector navigates to the target node, but any clicks targeting child action buttons like deletion (`.conn-delete`) or reordering (`.conn-reorder`) are explicitly ignored by checking event targets to prevent unwanted navigation.
- **Color Resiliency Guards**: When rendering nodes or inspector cards for NPCs, check for null/undefined color values (`npc.color`) before applying inline style overrides (e.g. `undefined20` hex overrides) to prevent breaking css rules on legacy data.

## Bugs & Inconsistencies Analysis (June 2026)

A systematic analysis of the codebase was conducted and the following bugs were **confirmed and fixed**:
- **Undo/Redo Fragmentation** (FIXED): Multi-delete and multi-duplicate now use `startBatch()/endBatch()` for atomic undo. Node resize now registers an undo checkpoint.
- **Performance** (FIXED): Batch translation (`translateAllNodes`) now uses `startBatch()/endBatch()` instead of triggering N individual re-renders.
- **UI Desynchronization** (FIXED): Sidebar modals now call `State.notifyChange()` after editing NPC/Quest/Dialogue names to trigger an immediate re-render.
- **Chat Actions** (FIXED): The chat executor now always batches actions (`mutatingActions.length > 0` instead of `> 1`).

Remaining item (not a bug): Canvas re-renders fully when editing node text in the Inspector panel. This is a performance concern for large dialogues (15+ nodes) that would require canvas rendering refactoring.

False positives discarded: NPC color picker undo (already handled via `focus` event), inspector crash on NPC deletion (already has a null guard).

See [Analisis de bugs posibles.md](file:///c:/Users/Benja/Desktop/NWBI/NWBI_Repo/Dialogues/Analisis%20de%20bugs%20posibles.md) for the full verified report.
