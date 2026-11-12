'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  invoke: (action, payload) => ipcRenderer.invoke('desktop:invoke', action, payload),
  onChanged(callback) {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('desktop:changed', listener);
    return () => ipcRenderer.removeListener('desktop:changed', listener);
  },
});
