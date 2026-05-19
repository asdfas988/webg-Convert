const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Robust File -> absolute path extraction.
// Electron 32+ deprecates `file.path`; the supported replacement is
// `webUtils.getPathForFile(file)`. We try both because some Electron builds
// in the wild still expose `file.path` and `webUtils` can be missing in
// older runtimes.
function pathForFile(file) {
  if (!file) return '';
  try {
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      const p = webUtils.getPathForFile(file);
      if (p) return p;
    }
  } catch {}
  if (typeof file.path === 'string' && file.path) return file.path;
  return '';
}

contextBridge.exposeInMainWorld('api', {
  // FileList survives contextBridge as a non-iterable proxy, so the renderer
  // iterates and hands single File objects here one at a time.
  getPathForFile(file) {
    return pathForFile(file);
  },

  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickOutputFolder: () => ipcRenderer.invoke('pick-output-folder'),
  compressImages: (paths, options) => ipcRenderer.invoke('compress-images', paths, options),
  revealInFolder: (p) => ipcRenderer.invoke('reveal-in-folder', p),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (next) => ipcRenderer.invoke('set-settings', next),

  onStart: (cb) => ipcRenderer.on('compress:start', (_e, d) => cb(d)),
  onProgress: (cb) => ipcRenderer.on('compress:progress', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('compress:done', (_e, d) => cb(d)),
  onOpenPaths: (cb) => ipcRenderer.on('open-paths', (_e, paths) => cb(Array.isArray(paths) ? paths : [])),
});
