import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
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
    backgroundColor: '#0d0f14',
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

const CLAUDE_TIMEOUT_MS = 240_000;
// Model comes from user config; validate so it's safe as a CLI argument
// (on Windows we spawn through the shell to resolve claude.cmd/.exe).
const MODEL_RE = /^[a-zA-Z0-9._-]+$/;

function runClaude(args, stdinText, timeoutMs = CLAUDE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      shell: process.platform === 'win32',
      windowsHide: true,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      done({ ok: false, error: 'Claude Code no respondió a tiempo (timeout).' });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      const msg = err.code === 'ENOENT'
        ? 'Claude Code no está instalado o no está en el PATH. Instálalo desde claude.com/claude-code.'
        : `No se pudo ejecutar Claude Code: ${err.message}`;
      done({ ok: false, error: msg });
    });

    child.on('close', (code) => {
      done({ ok: code === 0, stdout, stderr, code });
    });

    if (stdinText != null) {
      child.stdin.on('error', () => {}); // ignore EPIPE if the process dies early
      child.stdin.write(stdinText, 'utf8');
    }
    child.stdin.end();
  });
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

// Availability check: is the CLI installed?
ipcMain.handle('ai:claude-check', async () => {
  const res = await runClaude(['--version'], null, 15_000);
  if (res.error) return { ok: false, error: res.error };
  if (!res.ok) return { ok: false, error: friendlyClaudeError(res.stderr || res.stdout) };
  return { ok: true, version: (res.stdout || '').trim() };
});

// Text generation call. All free-form content (system prompt + conversation)
// travels via stdin to avoid Windows command-line length limits and escaping.
ipcMain.handle('ai:claude-call', async (event, { prompt, systemPrompt, model }) => {
  const modelArg = model && MODEL_RE.test(model) ? model : 'sonnet';

  let fullPrompt = prompt || '';
  if (systemPrompt) {
    fullPrompt = `<instructions>\n${systemPrompt}\n</instructions>\n\n${fullPrompt}`;
  }

  const args = ['-p', '--output-format', 'json', '--model', modelArg];
  const res = await runClaude(args, fullPrompt);

  if (res.error) return { ok: false, error: res.error };
  if (!res.ok) return { ok: false, error: friendlyClaudeError(res.stderr || res.stdout) };

  try {
    const data = JSON.parse(res.stdout);
    if (data.is_error || data.subtype !== 'success' || typeof data.result !== 'string') {
      return { ok: false, error: friendlyClaudeError(data.result || data.subtype || res.stderr) };
    }
    return { ok: true, text: data.result };
  } catch {
    return { ok: false, error: 'Claude Code devolvió una respuesta no válida.' };
  }
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
