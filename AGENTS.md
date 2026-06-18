# Dialogue Forge — AI Agent Guide

## Project Overview

**Dialogue Forge** is a standalone desktop application (Electron + Vite) for creating branched dialogue trees for turn-based games. It's inspired by Obsidian's node-based interface but focused exclusively on dialogue authoring.

## Tech Stack

| Technology | Purpose |
|---|---|
| **Electron** | Desktop app wrapper (standalone .exe) |
| **Vite** | Dev server with HMR, build tool |
| **Vanilla JS (ES Modules)** | All app logic — no React/Vue/frameworks |
| **Vanilla CSS** | Styling — dark theme, no Tailwind |
| **localStorage** | Data persistence |
| **JSON** | Export/import format |
| **OpenRouter API** | AI translation & dialogue generation |

## Architecture

```
electron/
  main.js          → Electron main process (window creation)
  preload.js       → Secure bridge between main and renderer

src/
  main.js          → App entry point, wires all modules together
  style.css        → Complete CSS theme (dark mode, glassmorphism)
  modules/
    state.js       → Global state, CRUD operations, persistence
    canvas.js      → Canvas: pan, zoom, SVG connections
    nodes.js       → Node rendering, drag & drop, inline editing, connection drawing
    inspector.js   → Right panel: property editing, AI actions per node/dialogue
    sidebar.js     → Left panel: NPC/Quest/Dialogue lists
    ui.js          → Modals, toasts, context menus, AI settings/generate modals
    lang.js        → Language toggle (ES/EN)
    ai.js          → OpenRouter API: translation (ES→EN), dialogue generation, PDF/MD parsing
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
      connections: [nodeId, ...]  // Direct connections to child nodes
    }]
  }]
}
```

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

#### Snap-to-Grid
Toggled via the ⬥ button in canvas controls. When active, node positions snap to a 24px grid during drag. State persisted in `localStorage`.

#### Connection Right-Click
SVG connection paths render with invisible fat hit-areas (12px stroke) for easier clicking. Right-click shows a context menu to delete the connection.

### AI Integration (OpenRouter)

The `ai.js` module integrates with the OpenRouter API for two main features:

#### Configuration (stored in localStorage)
```js
{
  apiKey: string,           // OpenRouter API key
  model: string,            // Free-text model ID (e.g. 'anthropic/claude-sonnet-4')
  temperature: number,      // Default 0.7
  isThinking: boolean,      // Strip <thinking> blocks from response
  contextFiles: [{name, text}],  // Multiple PDF/MD/TXT files for context
  contextPrompt: string     // Global context prompt
}
```

#### Translation (ES → EN only)
- `translateNode(nodeId)` — Translates a single node's Spanish text to English
- `translateAllNodes()` — Batch-translates all nodes that have ES text but no EN text
- All prompts sent to the AI are in **English**
- Accessible from: toolbar button, inspector (per-node or per-dialogue)

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
- **No git operations**: Never commit automatically.
- **IDs**: Generated with `uid()` (timestamp + random base36).
- **CSS**: All custom properties in `:root`. No utility classes.
- **Event cleanup**: Global listeners use `window._handlerName` pattern for cleanup on re-render.
- **Node editing**: Inline textarea on canvas + inspector panel. Canvas skips re-render when textarea is focused.

## Future Plans

- **Electron Builder**: Package as distributable `.exe`.
- **Auto-layout**: Automatic node arrangement (Sugiyama algorithm).
- **Search**: Find nodes by text content.
- **Dialogue Simulator**: Interactive chat modal to test dialogue trees.
