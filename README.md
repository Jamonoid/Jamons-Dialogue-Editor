# Dialogue Forge

A visual dialogue tree editor built for game development. Create branching conversations, manage NPCs and quests, translate between languages, and generate dialogue with AI — all from a single desktop application.

Built with Electron, Vite, and vanilla JavaScript. No frameworks.

---

## Features

### Visual Dialogue Editor
- Node-based canvas for creating and connecting dialogue lines
- Drag-and-drop node positioning with auto-layout for branching trees
- Inline text editing on the canvas or in the inspector panel
- Conditional branching with `IF` conditions and `DO` actions on connections
- Multi-select, duplicate, and batch-delete nodes
- Full undo/redo history (Ctrl+Z / Ctrl+Y)

### Project Management
- Manage NPCs, Quests, and Dialogues from a collapsible sidebar
- Drag-and-drop reordering of NPCs, Quests, and Dialogues
- Custom NPC colors for visual identification on the canvas
- Assign dialogues to NPCs and Quests
- Save/load projects as `.json` files with auto-save to localStorage
- Export/import for backup and version control

### Bilingual Support (ES / EN)
- Every dialogue node supports both Spanish and English text
- Language toggle in the toolbar switches the editing view
- AI-powered batch translation (ES to EN) for the active dialogue
- Per-node translation from the inspector panel

### AI Integration (via OpenRouter)
- **Dialogue Generation**: Describe a conversation and the AI creates a full branching dialogue tree with nodes and connections
- **Dialogue Extension**: Extend existing dialogues from leaf nodes
- **Translation**: Translate individual nodes or entire dialogues
- **Chat Assistant**: An integrated chat panel that can read the active dialogue, create nodes, update text, and modify connections through structured actions
- **Separate models per task**: Configure different LLMs for generation (e.g., Claude Sonnet), translation (e.g., Gemini Flash), and chat independently
- **Context files**: Upload PDF, Markdown, or text files with world lore that get injected into AI prompts

### Audio Slicer
A built-in tool for splitting voice acting recordings into individual dialogue clips:
- Upload audio files (.wav, .mp3, .ogg) via drag-and-drop or file picker
- Waveform visualization rendered on canvas
- Click to place cut markers, drag to adjust, right-click to delete
- Shift+Click to set the playback start position (playhead)
- Preview individual segments before exporting
- Editable segment names
- Export all segments as a .zip of .wav files, or download individually
- Zoom and horizontal scroll for navigating long recordings

---

## Requirements

- Node.js (v18 or later recommended)

## Installation

```bash
npm install
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server + Electron in parallel |
| `npm run build` | Build the frontend for production (`dist/`) |
| `npm run dist` | Build frontend + package as Windows installer (NSIS) |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+S | Save project to file |
| Ctrl+O | Open project file |
| Ctrl+Z | Undo |
| Ctrl+Y | Redo |
| Ctrl+D | Duplicate selected nodes |
| Ctrl+A | Select all nodes |
| Delete | Delete selected nodes |
| Escape | Deselect / close overlay |
| Space | Play/pause (in Audio Slicer) |

## Project Structure

```
Dialogues/
  electron/          Electron main process
    main.js          Window management, IPC, file dialogs
    preload.js       Secure bridge between renderer and main
  src/
    main.js          App entry point, module wiring
    style.css        All styles (CSS custom properties, no frameworks)
    utils/
      helpers.js     DOM helpers, escaping, UID generation
    modules/
      state.js       Central state management, undo/redo, persistence
      canvas.js      Canvas rendering, pan/zoom, node layout
      nodes.js       Node DOM rendering, inline editing, resize
      inspector.js   Right panel for editing node/NPC/quest properties
      sidebar.js     Left panel with NPC/quest/dialogue lists
      ai.js          OpenRouter API integration, translation, generation
      chat.js        AI chat assistant with structured actions
      prompts.js     System prompts for AI generation and extension
      lang.js        Language toggle (ES/EN)
      ui.js          Modals, toasts, context menus, settings UI
      audio-slicer.js  Audio splitting tool
      wav-encoder.js   Pure JS WAV file encoder
  index.html         App shell
  vite.config.js     Vite configuration
  package.json       Dependencies and build scripts
```

## Data Format

Projects are stored as JSON with the following structure:

```json
{
  "npcs": [{ "id": "...", "name": "Guard", "color": "#6c5ce7" }],
  "quests": [{ "id": "...", "name": "The Lost Sword" }],
  "dialogues": [{
    "id": "...",
    "title": "Guard Warning",
    "npcId": "...",
    "questId": "...",
    "nodes": [{
      "id": "...",
      "text": { "es": "Hola viajero.", "en": "Hello traveler." },
      "npcId": "...",
      "x": 100, "y": 200,
      "connections": [{ "targetId": "...", "condition": "", "action": "" }]
    }],
    "startNodeId": "..."
  }]
}
```