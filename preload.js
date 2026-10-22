'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const chunkHandlers = new Set();

ipcRenderer.on('ai:chunk', (_event, data) => {
  chunkHandlers.forEach((handler) => {
    try {
      handler(data);
    } catch (_) {}
  });
});

contextBridge.exposeInMainWorld('aiBridge', {
  getConfig: () => ipcRenderer.invoke('ai:get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('ai:save-config', cfg),
  clearKey: () => ipcRenderer.invoke('ai:clear-key'),
  test: () => ipcRenderer.invoke('ai:test'),
  chat: (payload) => ipcRenderer.invoke('ai:chat', payload),
  abort: (id) => ipcRenderer.send('ai:abort', id),
  onChunk: (handler) => {
    chunkHandlers.add(handler);
    return () => chunkHandlers.delete(handler);
  },

  materialsPick: () => ipcRenderer.invoke('materials:pick'),
  materialsAdd: (payload) => ipcRenderer.invoke('materials:add', payload),
  materialsAddText: (payload) => ipcRenderer.invoke('materials:add-text', payload),
  materialsRemove: (payload) => ipcRenderer.invoke('materials:remove', payload),
  materialsText: (payload) => ipcRenderer.invoke('materials:text', payload),
  materialsReadText: (payload) => ipcRenderer.invoke('materials:read-text', payload),
  materialsWriteText: (payload) => ipcRenderer.invoke('materials:write-text', payload),
  materialsOpen: (payload) => ipcRenderer.invoke('materials:open', payload),
  materialsPurge: (payload) => ipcRenderer.invoke('materials:purge', payload),
  saveTextFile: (payload) => ipcRenderer.invoke('file:save-text', payload),
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (_) {
      return '';
    }
  }
});
