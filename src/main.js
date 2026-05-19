const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const { fileURLToPath } = require('node:url');
const sharp = require('sharp');

const SUPPORTED_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff',
  '.avif', '.gif', '.bmp', '.heic', '.heif',
]);

let mainWindow = null;
let rendererReady = false;
let pendingOpenPaths = [];

// ---------- settings ----------
const SETTINGS_DEFAULTS = {
  quality: 85,
  replaceOriginal: true,
  outputMode: 'source', // 'source' | 'custom'
  outputDir: '',         // absolute path, used when outputMode === 'custom'
};

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettingsSync() {
  try {
    const raw = fssync.readFileSync(settingsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return { ...SETTINGS_DEFAULTS, ...parsed };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

async function saveSettings(next) {
  const merged = { ...loadSettingsSync(), ...next };
  await fs.mkdir(path.dirname(settingsFilePath()), { recursive: true });
  await fs.writeFile(settingsFilePath(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function createWindow() {
  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 720,
    minHeight: 600,
    backgroundColor: '#1a1a1f',
    title: 'ImageCompressor',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    rendererReady = true;
    flushPendingOpenPaths();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });
}

function pathFromArg(arg) {
  if (typeof arg !== 'string') return '';
  const trimmed = arg.trim();
  if (!trimmed || trimmed.startsWith('--')) return '';
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return '';
    }
  }
  return path.resolve(trimmed);
}

function isSupportedInputPath(p) {
  try {
    const stat = fssync.statSync(p);
    if (stat.isDirectory()) return true;
    if (!stat.isFile()) return false;
    return SUPPORTED_EXT.has(path.extname(p).toLowerCase());
  } catch {
    return false;
  }
}

function collectLaunchPaths(argv) {
  const args = app.isPackaged ? argv.slice(1) : argv.slice(2);
  const out = [];
  const seen = new Set();
  for (const arg of args) {
    const p = pathFromArg(arg);
    if (!p || seen.has(p) || !isSupportedInputPath(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function queueOpenPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  for (const p of paths) {
    if (!pendingOpenPaths.includes(p)) pendingOpenPaths.push(p);
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  flushPendingOpenPaths();
}

function flushPendingOpenPaths() {
  if (!mainWindow || !rendererReady || pendingOpenPaths.length === 0) return;
  const payload = pendingOpenPaths;
  pendingOpenPaths = [];
  mainWindow.webContents.send('open-paths', payload);
}

const initialLaunchPaths = collectLaunchPaths(process.argv);
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    queueOpenPaths(collectLaunchPaths(argv));
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    queueOpenPaths([filePath].filter(isSupportedInputPath));
  });

  app.whenReady().then(() => {
    createWindow();
    queueOpenPaths(initialLaunchPaths);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

async function expandToImageFiles(inputPaths) {
  const out = [];
  const seen = new Set();
  for (const p of inputPaths) {
    if (!p) continue;
    try {
      const stat = await fs.stat(p);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(p, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            const full = path.join(p, entry.name);
            const ext = path.extname(entry.name).toLowerCase();
            if (SUPPORTED_EXT.has(ext) && !seen.has(full)) {
              seen.add(full);
              out.push(full);
            }
          }
        }
      } else if (stat.isFile()) {
        const ext = path.extname(p).toLowerCase();
        if (SUPPORTED_EXT.has(ext) && !seen.has(p)) {
          seen.add(p);
          out.push(p);
        }
      }
    } catch {
      // ignore unreadable paths
    }
  }
  return out;
}

async function trashIfExists(p) {
  try {
    await fs.access(p);
  } catch {
    return false;
  }
  try {
    await shell.trashItem(p);
    return true;
  } catch (err) {
    try { await fs.unlink(p); return true; } catch { return false; }
  }
}

async function uniqueDestPath(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  let i = 1;
  // If file exists, suffix with " (N)"
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${base} (${i})${ext}`);
      i++;
    } catch {
      return candidate;
    }
  }
}

async function compressOne(src, opts) {
  const { quality, replaceOriginal, outputDir } = opts;
  const srcDir = path.dirname(src);
  const base = path.basename(src, path.extname(src));

  const useCustom = !!outputDir && outputDir !== srcDir;
  const destDir = useCustom ? outputDir : srcDir;
  await fs.mkdir(destDir, { recursive: true });

  // For source-folder output we keep the in-place semantics (replace existing .webp by trashing).
  // For custom-folder output we pick a unique name on collision so we never silently overwrite.
  const dest = useCustom
    ? await uniqueDestPath(destDir, base, '.webp')
    : path.join(destDir, base + '.webp');

  const tmpDest = path.join(destDir, `.${base}.${process.pid}.${Date.now()}.tmp.webp`);

  const srcStat = await fs.stat(src);
  const srcSize = srcStat.size;

  await sharp(src, { failOn: 'none', animated: true })
    .rotate()
    .webp({ quality, effort: 4, smartSubsample: true })
    .toFile(tmpDest);

  const isSamePath =
    path.normalize(src).toLowerCase() === path.normalize(dest).toLowerCase();

  if (isSamePath) {
    // Source IS destination (re-encoding .webp in place).
    await fs.unlink(src).catch(() => {});
    await fs.rename(tmpDest, dest);
  } else {
    if (!useCustom) {
      // Same-folder mode: if a stale destination exists from a prior run, send it to recycle bin.
      await trashIfExists(dest);
    }
    await fs.rename(tmpDest, dest);
    if (replaceOriginal) {
      await trashIfExists(src);
    }
  }

  const destStat = await fs.stat(dest);
  return {
    src,
    dest,
    srcSize,
    destSize: destStat.size,
    ratio: destStat.size / srcSize,
  };
}

ipcMain.handle('compress-images', async (event, paths, options = {}) => {
  const quality = Math.min(95, Math.max(60, Number(options.quality) || 85));
  const replaceOriginal = options.replaceOriginal !== false;
  const outputDir = typeof options.outputDir === 'string' && options.outputDir.trim()
    ? options.outputDir.trim()
    : '';

  const files = await expandToImageFiles(paths);
  event.sender.send('compress:start', { total: files.length });

  const results = [];
  for (let i = 0; i < files.length; i++) {
    const src = files[i];
    event.sender.send('compress:progress', {
      index: i, total: files.length, current: src, status: 'working',
    });
    try {
      const r = await compressOne(src, { quality, replaceOriginal, outputDir });
      results.push({ ok: true, ...r });
      event.sender.send('compress:progress', {
        index: i, total: files.length, current: src, status: 'done', result: r,
      });
    } catch (err) {
      const errResult = { ok: false, src, error: String(err && err.message || err) };
      results.push(errResult);
      event.sender.send('compress:progress', {
        index: i, total: files.length, current: src, status: 'error', error: errResult.error,
      });
    }
  }

  event.sender.send('compress:done', { results });
  return { results };
});

ipcMain.handle('pick-files', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select images',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'avif', 'gif', 'bmp', 'heic', 'heif'] },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('pick-output-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose default output folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return '';
  return res.filePaths[0];
});

ipcMain.handle('reveal-in-folder', async (_e, p) => {
  if (p) shell.showItemInFolder(p);
});

ipcMain.handle('get-settings', async () => {
  return loadSettingsSync();
});

ipcMain.handle('set-settings', async (_e, next) => {
  return saveSettings(next || {});
});
