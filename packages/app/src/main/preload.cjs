// Runs in the sandboxed preload context and exposes only specific operations to the page.
// The main process decides which method names exist; this file never trusts the page beyond a name check.
const { contextBridge, ipcRenderer } = require('electron');

const unwrap = (err) => new Error(String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));

contextBridge.exposeInMainWorld('aioBridge', {
  writeClipboardText: (text) => ipcRenderer.invoke('aio:writeClipboardText', text).catch((err) => { throw unwrap(err); }),
  invoke: (method, args) => {
    if (typeof method !== 'string' || !/^[a-zA-Z]{1,40}$/.test(method)) return Promise.reject(new Error('Invalid method'));
    return ipcRenderer.invoke(`aio:${method}`, ...(Array.isArray(args) ? args : [])).catch((err) => {
      throw unwrap(err);
    });
  },
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('aio:event', listener);
    return () => ipcRenderer.removeListener('aio:event', listener);
  },
});
