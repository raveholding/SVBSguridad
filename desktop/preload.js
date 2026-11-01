'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// API mínima y segura que ve el panel (window.electronAPI)
contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.invoke('svb:minimize'),
  close: () => ipcRenderer.invoke('svb:close'),
  toggleKiosk: () => ipcRenderer.invoke('svb:kiosk'),
  openExternal: (url) => ipcRenderer.invoke('svb:open', url),
  relay: (ms) => ipcRenderer.invoke('svb:relay', ms),
  serialPorts: () => ipcRenderer.invoke('svb:ports'),
});
