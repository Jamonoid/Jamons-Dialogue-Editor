const { contextBridge, ipcRenderer } = require('electron');

// Expose safe APIs to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  // File persistence
  openFile: () => ipcRenderer.invoke('dialog:open'),
  saveFile: (data, filePath) => ipcRenderer.invoke('dialog:save', { data, filePath }),
  setTitle: (title) => ipcRenderer.send('set-title', title),
});
