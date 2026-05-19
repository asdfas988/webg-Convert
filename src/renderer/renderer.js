const dropEl = document.getElementById('drop');
const dropOverlay = document.getElementById('dropOverlay');
const pickBtn = document.getElementById('pickBtn');
const qInput = document.getElementById('quality');
const qVal = document.getElementById('qVal');
const replaceInput = document.getElementById('replaceOriginal');
const summary = document.getElementById('summary');
const listEl = document.getElementById('list');
const clearBtn = document.getElementById('clearBtn');
const outputModeInputs = document.querySelectorAll('input[name="outputMode"]');
const outputDirRow = document.getElementById('outputDirRow');
const outputDirPathEl = document.getElementById('outputDirPath');
const pickOutputBtn = document.getElementById('pickOutputBtn');

const fmtBytes = (n) => {
  if (n == null || isNaN(n)) return '—';
  const u = ['B','KB','MB','GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

let settings = {
  quality: 85,
  replaceOriginal: true,
  outputMode: 'source',
  outputDir: '',
};

function applySettingsToUI() {
  qInput.value = settings.quality;
  qVal.textContent = String(settings.quality);
  replaceInput.checked = !!settings.replaceOriginal;
  for (const r of outputModeInputs) r.checked = r.value === settings.outputMode;
  refreshOutputDirRow();
}

function refreshOutputDirRow() {
  const isCustom = settings.outputMode === 'custom';
  outputDirRow.hidden = !isCustom && !settings.outputDir;
  outputDirRow.classList.toggle('inactive', !isCustom);
  if (settings.outputDir) {
    outputDirPathEl.textContent = isCustom ? settings.outputDir : `Saved custom folder: ${settings.outputDir}`;
    outputDirPathEl.title = settings.outputDir;
    outputDirPathEl.classList.remove('empty');
  } else {
    outputDirPathEl.textContent = 'Choose a folder to use custom output.';
    outputDirPathEl.title = '';
    outputDirPathEl.classList.add('empty');
  }
}

async function persistSettings(patch) {
  settings = { ...settings, ...patch };
  try { await window.api.setSettings(patch); } catch {}
}

qInput.addEventListener('input', () => { qVal.textContent = qInput.value; });
qInput.addEventListener('change', () => persistSettings({ quality: Number(qInput.value) }));
replaceInput.addEventListener('change', () => persistSettings({ replaceOriginal: !!replaceInput.checked }));
for (const r of outputModeInputs) {
  r.addEventListener('change', () => {
    if (r.checked) {
      persistSettings({ outputMode: r.value });
      refreshOutputDirRow();
    }
  });
}
pickOutputBtn.addEventListener('click', async () => {
  const dir = await window.api.pickOutputFolder();
  if (dir) {
    await persistSettings({ outputDir: dir, outputMode: 'custom' });
    applySettingsToUI();
    summary.textContent = `Output folder: ${dir}`;
  }
});

let busy = false;
let readyToRun = false;
const items = new Map();
const queuedRunPaths = [];

function enqueueRun(paths) {
  if (!paths || paths.length === 0) return;
  for (const p of paths) {
    if (p && !queuedRunPaths.includes(p)) queuedRunPaths.push(p);
  }
  flushQueuedRuns();
}

function flushQueuedRuns() {
  if (!readyToRun || busy || queuedRunPaths.length === 0) return;
  const paths = queuedRunPaths.splice(0, queuedRunPaths.length);
  run(paths);
}

function ensureItem(p) {
  if (items.has(p)) return items.get(p);
  const li = document.createElement('li');
  li.className = 'working';
  li.innerHTML = `
    <span class="icon">●</span>
    <span class="name" title="${p}">${p.replace(/\\/g, '/').split('/').pop()}</span>
    <span class="sizes">…</span>
    <span class="savings">…</span>`;
  li.querySelector('.name').addEventListener('click', () => window.api.revealInFolder(p));
  listEl.appendChild(li);
  const rec = { liEl: li, status: 'working' };
  items.set(p, rec);
  return rec;
}

function markDone(p, result) {
  const rec = items.get(p);
  if (!rec) return;
  rec.status = 'done';
  rec.result = result;
  rec.liEl.className = '';
  rec.liEl.querySelector('.icon').textContent = '✓';
  rec.liEl.querySelector('.sizes').textContent =
    `${fmtBytes(result.srcSize)} → ${fmtBytes(result.destSize)}`;
  const pct = Math.round((1 - result.destSize / result.srcSize) * 100);
  const sav = rec.liEl.querySelector('.savings');
  if (pct >= 0) sav.textContent = `-${pct}%`;
  else sav.textContent = `+${-pct}%`;
  rec.liEl.querySelector('.name').addEventListener('click',
    () => window.api.revealInFolder(result.dest));
}

function markError(p, error) {
  const rec = items.get(p);
  if (!rec) return;
  rec.status = 'error';
  rec.liEl.className = 'error';
  rec.liEl.querySelector('.icon').textContent = '✗';
  rec.liEl.querySelector('.sizes').textContent = '';
  rec.liEl.querySelector('.savings').textContent = error.length > 40 ? error.slice(0, 40) + '…' : error;
  rec.liEl.title = error;
}

let totalForRun = 0;

function refreshSummary() {
  const all = [...items.values()];
  if (busy) {
    if (totalForRun === 0) { summary.textContent = 'Scanning…'; return; }
    const done = all.filter(r => r.status !== 'working').length;
    summary.textContent = `Processing… ${done}/${totalForRun}`;
    return;
  }
  if (all.length === 0) { summary.textContent = 'Ready.'; clearBtn.hidden = true; return; }
  const ok = all.filter(r => r.status === 'done');
  const failed = all.filter(r => r.status === 'error');
  const srcTotal = ok.reduce((s, r) => s + r.result.srcSize, 0);
  const destTotal = ok.reduce((s, r) => s + r.result.destSize, 0);
  const saved = srcTotal - destTotal;
  const pct = srcTotal > 0 ? Math.round((saved / srcTotal) * 100) : 0;
  let msg = `Done. ${ok.length} converted, saved ${fmtBytes(saved)} (-${pct}%).`;
  if (failed.length) msg += ` ${failed.length} failed.`;
  summary.textContent = msg;
  clearBtn.hidden = false;
}

async function run(paths) {
  if (busy || !paths || paths.length === 0) return;
  if (settings.outputMode === 'custom' && !settings.outputDir) {
    summary.textContent = 'Pick an output folder first, or switch to "Same as source".';
    return;
  }
  busy = true;
  summary.textContent = 'Scanning…';
  clearBtn.hidden = true;
  try {
    await window.api.compressImages(paths, {
      quality: Number(qInput.value),
      replaceOriginal: !!replaceInput.checked,
      outputDir: settings.outputMode === 'custom' ? settings.outputDir : '',
    });
  } catch (err) {
    summary.textContent = 'Error: ' + (err && err.message || err);
  } finally {
    busy = false;
    refreshSummary();
    flushQueuedRuns();
  }
}

window.api.onStart((d) => { totalForRun = d.total; refreshSummary(); });
window.api.onProgress((d) => {
  if (d.status === 'working') ensureItem(d.current);
  else if (d.status === 'done') markDone(d.current, d.result);
  else if (d.status === 'error') markError(d.current, d.error);
  refreshSummary();
});
window.api.onDone(() => { totalForRun = 0; });
window.api.onOpenPaths((paths) => enqueueRun(paths));

// ---- Drag-and-drop, window-wide ----
// Extract absolute paths from a DataTransfer in a way that copes with how
// Chromium delivers file drops on Windows.
function pathsFromDataTransfer(dt) {
  if (!dt) return [];
  const seen = new Set();
  const out = [];

  // FileList survives contextBridge as a non-iterable proxy, so we iterate
  // in the renderer and hand single File objects to preload one at a time.
  if (dt.files && dt.files.length) {
    for (let i = 0; i < dt.files.length; i++) {
      const f = dt.files[i];
      if (!f) continue;
      try {
        const p = window.api.getPathForFile(f);
        if (p && !seen.has(p)) { seen.add(p); out.push(p); }
      } catch {}
    }
  }

  // Items fallback — same logic, in case files is empty for some sources.
  if (out.length === 0 && dt.items && dt.items.length) {
    for (let i = 0; i < dt.items.length; i++) {
      const it = dt.items[i];
      if (!it || it.kind !== 'file') continue;
      try {
        const f = it.getAsFile();
        if (!f) continue;
        const p = window.api.getPathForFile(f);
        if (p && !seen.has(p)) { seen.add(p); out.push(p); }
      } catch {}
    }
  }

  return out;
}

let dragDepth = 0;
function hasFiles(dt) {
  if (!dt) return false;
  const types = dt.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true;
  }
  return false;
}
function showOverlay() {
  dropOverlay.hidden = false;
  dropEl.classList.add('dragover');
}
function hideOverlay() {
  dragDepth = 0;
  dropOverlay.hidden = true;
  dropEl.classList.remove('dragover');
}

// Always preventDefault on drag events so the browser does NOT navigate to
// the dropped file. Without this, drop never fires on the window.
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (hasFiles(e.dataTransfer)) {
    dragDepth++;
    showOverlay();
  }
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer && hasFiles(e.dataTransfer)) {
    e.dataTransfer.dropEffect = 'copy';
  }
});
window.addEventListener('dragleave', (e) => {
  if (dragDepth > 0) {
    dragDepth--;
    if (dragDepth === 0) hideOverlay();
  }
});
window.addEventListener('dragend', hideOverlay);
window.addEventListener('drop', (e) => {
  e.preventDefault();
  hideOverlay();
  const paths = pathsFromDataTransfer(e.dataTransfer);
  if (paths.length === 0) {
    summary.textContent = 'Could not read those files. Try "Choose files" instead.';
    return;
  }
  enqueueRun(paths);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !dropOverlay.hidden) hideOverlay();
});
window.addEventListener('mouseleave', () => { if (dragDepth === 0) hideOverlay(); });

// Block the default "navigate to file" behavior if a stray drop slips past
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

dropEl.addEventListener('click', async (e) => {
  if (e.target === pickBtn) return;
  const paths = await window.api.pickFiles();
  enqueueRun(paths);
});
pickBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const paths = await window.api.pickFiles();
  enqueueRun(paths);
});

clearBtn.addEventListener('click', () => {
  listEl.innerHTML = '';
  items.clear();
  refreshSummary();
});

// ---- bootstrap ----
(async function init() {
  try {
    const loaded = await window.api.getSettings();
    if (loaded) settings = { ...settings, ...loaded };
  } catch {}
  applySettingsToUI();
  readyToRun = true;
  flushQueuedRuns();
})();
