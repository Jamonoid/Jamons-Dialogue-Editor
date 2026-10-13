import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { startMcpServer } from './mcp-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

// Expose WebGPU to the renderer (used by the local embeddings to run on the
// GPU via transformers.js). On some Electron/driver combos the adapter is
// behind this flag; harmless where WebGPU is already available.
app.commandLine.appendSwitch('enable-unsafe-webgpu');

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: "Jamon's Dialogue Editor",
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#131313',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Show when ready to avoid white flash
  win.once('ready-to-show', () => {
    win.show();
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // C1: Confirm close with unsaved changes
  win.on('close', async (e) => {
    const isDirty = await win.webContents.executeJavaScript(
      'typeof window.__dialogueForgeDirty === "function" ? window.__dialogueForgeDirty() : false'
    ).catch(() => false);
    if (isDirty) {
      e.preventDefault();
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Guardar y salir', 'Salir sin guardar', 'Cancelar'],
        defaultId: 0,
        cancelId: 2,
        title: 'Cambios sin guardar',
        message: 'Tienes cambios sin guardar. ¿Qué deseas hacer?',
      });
      if (response === 0) {
        // Save then close
        await win.webContents.executeJavaScript('window.__dialogueForgeSave && window.__dialogueForgeSave()');
        win.destroy();
      } else if (response === 1) {
        win.destroy();
      }
      // response 2 = cancel, do nothing
    }
  });

  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

  mainWindow = win;
  return win;
}

// ─── IPC HANDLERS ────────────────────────────────────

// Open file dialog → read and return content
ipcMain.handle('dialog:open', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: "Jamon's Dialogue Editor", extensions: ['json'] },
      { name: 'Todos los archivos', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const content = await fs.readFile(filePath, 'utf-8');
  return { filePath, content };
});

// Save file dialog → write content to disk
ipcMain.handle('dialog:save', async (event, { data, filePath }) => {
  const win = BrowserWindow.getFocusedWindow();
  if (!filePath) {
    const result = await dialog.showSaveDialog(win, {
      filters: [
        { name: "Jamon's Dialogue Editor", extensions: ['json'] },
      ],
      defaultPath: 'dialogue_project.json',
    });
    if (result.canceled) return null;
    filePath = result.filePath;
  }
  await fs.writeFile(filePath, data, 'utf-8');
  return filePath;
});

// Update window title
ipcMain.on('set-title', (event, title) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setTitle(title);
});

// Pick folder for audio export
ipcMain.handle('audio:pick-folder', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Seleccionar carpeta de exportación',
    buttonLabel: 'Exportar aquí',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Write binary files to a folder
ipcMain.handle('audio:write-files', async (event, { folderPath, files }) => {
  // files: [{ name: string, data: number[] }]
  const results = [];
  for (const file of files) {
    const filePath = path.join(folderPath, file.name);
    const buffer = Buffer.from(file.data);
    await fs.writeFile(filePath, buffer);
    results.push(filePath);
  }
  return results;
});

// ─── CLAUDE CODE (local CLI, subscription auth) ─────
// Runs the user's installed `claude` CLI in print mode. The CLI uses the
// user's own login (Claude Pro/Max subscription) — no API key needed.

const CONNECT_TIMEOUT_MS = 60_000;   // launch → first output from the API
const IDLE_TIMEOUT_MS = 90_000;      // longest silence once Claude is answering
const DEFAULT_CALL_TIMEOUT_MS = 300_000;
const MAX_CALL_TIMEOUT_MS = 900_000;

// Session variables of a parent Claude Code session (e.g. when the app was
// started from one) would make the CLI behave as a nested child session.
const PARENT_SESSION_ENV = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_EFFORT',
];

const activeClaudeCalls = new Map(); // requestId → cancel()

// On Windows the CLI is spawned through the shell (claude.exe or an npm
// claude.cmd), so arguments are quoted by hand.
function winQuote(arg) {
  if (arg === '') return '""';
  return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function spawnClaude(args, cwd) {
  const env = { ...process.env };
  PARENT_SESSION_ENV.forEach((k) => delete env[k]);
  const opts = { windowsHide: true, env, cwd };
  if (process.platform === 'win32') {
    return spawn(['claude', ...args.map(winQuote)].join(' '), [], { ...opts, shell: true });
  }
  return spawn('claude', args, opts);
}

// With the Windows shell, child.kill() only kills cmd.exe and leaves the CLI running
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

function spawnErrorMessage(err) {
  return err.code === 'ENOENT'
    ? 'Claude Code no está instalado o no está en el PATH. Instálalo desde claude.com/claude-code.'
    : `No se pudo ejecutar Claude Code: ${err.message}`;
}

function friendlyClaudeError(raw) {
  const text = (raw || '').toLowerCase();
  if (text.includes('not logged in') || text.includes('please run /login') ||
      text.includes('login') || text.includes('authentication') || text.includes('401')) {
    return 'Claude Code no tiene sesión iniciada. Abre una terminal, ejecuta "claude" y luego "/login".';
  }
  if (text.includes('rate limit') || text.includes('429') || text.includes('limit reached')) {
    return 'Límite de uso de tu suscripción de Claude alcanzado. Espera un momento e intenta de nuevo.';
  }
  if (text.includes('overloaded') || text.includes('529')) {
    return 'Claude está sobrecargado. Intenta de nuevo en unos minutos.';
  }
  return raw ? `Error de Claude Code: ${raw.slice(0, 300)}` : 'Error desconocido de Claude Code.';
}

// One-shot CLI run with a plain timeout (used for --version)
function runClaudeSimple(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnClaude(args); } catch (err) { resolve({ ok: false, error: spawnErrorMessage(err) }); return; }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ ok: false, error: 'Claude Code no respondió a tiempo.' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: spawnErrorMessage(err) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr }); });
    child.stdin.end();
  });
}

/**
 * Text generation through the CLI, lean: our own system prompt instead of the
 * Claude Code agent prompt, no tools, no MCP servers, no hooks, no project
 * CLAUDE.md (runs in a temp dir). Output is streamed (stream-json) so we can
 * tell "never connected" from "still writing":
 *   - no API output within CONNECT_TIMEOUT_MS → abort (can't reach Claude)
 *   - silent for IDLE_TIMEOUT_MS once answering → abort (stalled)
 *   - hard cap `timeoutMs` for the whole call
 * Every abort kills the CLI process tree. Resolves { ok, text, model } or { ok: false, error }.
 */
async function runClaudeCall({ prompt, systemPrompt, model, timeoutMs, requestId }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-forge-'));
  const systemFile = path.join(tmp, 'system.txt');
  const settingsFile = path.join(tmp, 'settings.json');
  await fs.writeFile(systemFile, systemPrompt || 'You are a helpful assistant.', 'utf8');
  await fs.writeFile(settingsFile, JSON.stringify({ disableAllHooks: true }), 'utf8');

  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', model,
    '--system-prompt-file', systemFile,
    '--settings', settingsFile,
    '--tools', '', '--strict-mcp-config', '--no-session-persistence',
  ];
  const hardMs = Math.min(MAX_CALL_TIMEOUT_MS, Math.max(30_000, Number(timeoutMs) || DEFAULT_CALL_TIMEOUT_MS));

  try {
    return await new Promise((resolve) => {
      let child;
      try { child = spawnClaude(args, tmp); } catch (err) { resolve({ ok: false, error: spawnErrorMessage(err) }); return; }

      let settled = false;
      let connected = false;
      let result = null;
      let initModel = null;
      let buf = '';
      let stderr = '';
      let idleTimer = null;
      let connectTimer = null;
      let hardTimer = null;

      const finish = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(hardTimer);
        clearTimeout(idleTimer);
        if (requestId) activeClaudeCalls.delete(requestId);
        resolve(res);
      };
      const abort = (error) => {
        killTree(child);
        finish({ ok: false, error, timedOut: true });
      };
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abort(`Claude dejó de responder (${IDLE_TIMEOUT_MS / 1000} s sin actividad). Se canceló la llamada.`), IDLE_TIMEOUT_MS);
      };

      connectTimer = setTimeout(() => abort(
        `No se pudo conectar con Claude en ${CONNECT_TIMEOUT_MS / 1000} s. Revisa tu conexión a internet o la sesión de Claude Code (ejecuta "claude" en una terminal).`
      ), CONNECT_TIMEOUT_MS);
      hardTimer = setTimeout(() => abort(
        `Claude tardó más de ${Math.round(hardMs / 1000)} s y se canceló la llamada. Prueba con menos nodos a la vez.`
      ), hardMs);
      if (requestId) activeClaudeCalls.set(requestId, () => abort('Llamada cancelada.'));

      const onEvent = (ev) => {
        if (ev.type === 'system' && ev.subtype === 'init' && ev.model) initModel = ev.model;
        if (!connected && (ev.type === 'stream_event' || ev.type === 'assistant' || ev.type === 'result')) {
          connected = true;
          clearTimeout(connectTimer);
        }
        if (connected) armIdle();
        if (ev.type === 'result') result = ev;
      };

      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try { onEvent(JSON.parse(line)); } catch { /* not a JSON event */ }
        }
      });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => finish({ ok: false, error: spawnErrorMessage(err) }));
      child.on('close', () => {
        if (buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch { /* ignore */ } }
        if (!result) {
          finish({ ok: false, error: friendlyClaudeError(stderr || 'Claude Code terminó sin respuesta.') });
        } else if (result.is_error || result.subtype !== 'success' || typeof result.result !== 'string') {
          finish({ ok: false, error: friendlyClaudeError(result.result || result.subtype || stderr) });
        } else {
          const served = Object.keys(result.modelUsage || {});
          finish({ ok: true, text: result.result, model: served.find((m) => m === model) || served[0] || initModel || model });
        }
      });

      child.stdin.on('error', () => {}); // ignore EPIPE if the process dies early
      child.stdin.write(prompt || '', 'utf8');
      child.stdin.end();
    });
  } finally {
    fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Pinned model IDs (same mapping as normalizeClaudeModel() in src/modules/ai.js):
// the CLI aliases "sonnet"/"opus" follow the newest release and silently move
// to new versions when Claude Code updates ("opus" already resolves to 5.5).
function pickClaudeModel(model) {
  return /opus/i.test(model || '') ? 'claude-opus-5' : 'claude-sonnet-5';
}

// Availability check: is the CLI installed? (no API call, no quota used)
ipcMain.handle('ai:claude-check', async () => {
  const res = await runClaudeSimple(['--version'], 15_000);
  if (res.error) return { ok: false, error: res.error };
  if (!res.ok) return { ok: false, error: friendlyClaudeError(res.stderr || res.stdout) };
  return { ok: true, version: (res.stdout || '').trim() };
});

// Real round trip with a tiny prompt: proves login + model + connectivity
ipcMain.handle('ai:claude-test', async (event, { model } = {}) => {
  const started = Date.now();
  const res = await runClaudeCall({
    prompt: 'Reply with exactly: OK',
    systemPrompt: 'You are a connectivity check. Reply with exactly: OK',
    model: pickClaudeModel(model),
    timeoutMs: 90_000,
  });
  return res.ok ? { ok: true, model: res.model, ms: Date.now() - started } : res;
});

// Text generation call. The system prompt goes through a temp file and the
// conversation through stdin — no Windows command-line limits or escaping.
ipcMain.handle('ai:claude-call', async (event, { prompt, systemPrompt, model, timeoutMs, requestId }) => {
  return runClaudeCall({ prompt, systemPrompt, model: pickClaudeModel(model), timeoutMs, requestId });
});

ipcMain.handle('ai:claude-cancel', (event, { requestId } = {}) => {
  const cancel = activeClaudeCalls.get(requestId);
  if (cancel) cancel();
  return { ok: !!cancel };
});

// ─── MCP SERVER (control the app from Claude Code / CLI) ─────
// Forwards MCP tool calls to the renderer, where src/modules/mcp-bridge.js
// executes them against the live state (canvas updates in real time).
async function execMcpTool(tool, args) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) {
    return { ok: false, error: 'Dialogue Forge window is not open.' };
  }
  try {
    const code = `window.__mcpExecute
      ? window.__mcpExecute(${JSON.stringify(tool)}, ${JSON.stringify(args)})
      : { ok: false, error: 'MCP bridge not loaded in renderer yet.' }`;
    return await win.webContents.executeJavaScript(code, true);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

let mcpHttpServer = null;

// ─── APP LIFECYCLE ───────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  mcpHttpServer = startMcpServer(execMcpTool);
});

app.on('before-quit', () => {
  if (mcpHttpServer) {
    mcpHttpServer.close();
    mcpHttpServer = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
