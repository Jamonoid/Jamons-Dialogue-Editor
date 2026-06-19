import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'Dialogue Forge',
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

  return win;
}

// ─── IPC HANDLERS ────────────────────────────────────

// Open file dialog → read and return content
ipcMain.handle('dialog:open', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Dialogue Forge', extensions: ['json'] },
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
        { name: 'Dialogue Forge', extensions: ['json'] },
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

// ─── APP LIFECYCLE ───────────────────────────────────

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
