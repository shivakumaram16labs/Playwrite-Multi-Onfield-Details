'use strict';

const fileInput = document.getElementById('fileInput');
const gallery = document.getElementById('gallery');
const template = document.getElementById('cardTemplate');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const counter = document.getElementById('counter');
const preloadInput = document.getElementById('preloadInput');
const cacheBadge = document.getElementById('cacheBadge');
const statusText = document.getElementById('statusText');
const workbookControls = document.getElementById('workbookControls');
const sheetSelect = document.getElementById('sheetSelect');
const columnSelect = document.getElementById('columnSelect');
const applyColumnBtn = document.getElementById('applyColumnBtn');
const clearBtn = document.getElementById('clearBtn');
const deleteCacheBtn = document.getElementById('deleteCacheBtn');
const helpBtn = document.getElementById('helpBtn');
const closeHelpBtn = document.getElementById('closeHelpBtn');
const helpPanel = document.getElementById('helpPanel');

let sessionId = null;
let records = [];
let cards = [];
let activeIndex = 0;
let observer = null;
const renderState = new Map(); // index -> idle | loading | ready | error
const queue = [];
let queueRunning = false;
let preloadFrontier = 0;

function setStatus(text) {
  statusText.textContent = text;
}

async function refreshCacheBadge() {
  try {
    const res = await fetch('/api/cache/status');
    const data = await res.json();
    cacheBadge.textContent = `${data.cachedSnapshots || 0} snapshots ready`;
  } catch {}
}

function updateNavigation() {
  counter.textContent = records.length ? `${activeIndex + 1} / ${records.length}` : '0 / 0';
  prevBtn.disabled = !records.length || activeIndex <= 0;
  nextBtn.disabled = !records.length || activeIndex >= records.length - 1;
}

function populateWorkbookControls(sheets, selectedSheet, selectedColumn) {
  sheetSelect.innerHTML = '';
  for (const sheet of sheets || []) {
    const option = document.createElement('option');
    option.value = sheet.name;
    option.textContent = sheet.name;
    option.dataset.detectedColumn = sheet.detectedColumn ?? '';
    sheetSelect.appendChild(option);
  }

  if (selectedSheet) sheetSelect.value = selectedSheet;
  updateColumnOptions(selectedColumn);
  workbookControls.hidden = !sheets?.length;
}

function updateColumnOptions(selectedColumn = null) {
  const sheet = (window.sessionSheets || []).find((item) => item.name === sheetSelect.value);
  columnSelect.innerHTML = '';
  if (!sheet) return;

  sheet.headers.forEach((header, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${header || `Column ${index + 1}`} (${String.fromCharCode(65 + (index % 26))})`;
    columnSelect.appendChild(option);
  });

  const fallback = sheet.detectedColumn !== null ? sheet.detectedColumn : 0;
  columnSelect.value = String(selectedColumn ?? fallback);
}

function buildCards() {
  gallery.innerHTML = '';
  cards = records.map((record, index) => {
    const fragment = template.content.cloneNode(true);
    const card = fragment.querySelector('.record-card');
    card.dataset.index = String(index);
    card.querySelector('.record-number').textContent = `${index + 1} / ${records.length}`;
    card.querySelector('.record-url').textContent = record.url;
    const open = card.querySelector('.open-original');
    open.href = record.url;
    gallery.appendChild(fragment);
    renderState.set(index, 'idle');
    return gallery.lastElementChild;
  });

  preloadFrontier = 0;
  setupObserver();
  activeIndex = 0;
  updateNavigation();
  scheduleAround(0);
  cards[0]?.scrollIntoView({ block: 'start' });
}

function setupObserver() {
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    let best = null;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (!best || entry.intersectionRatio > best.intersectionRatio) best = entry;
    }
    if (!best) return;

    const index = Number(best.target.dataset.index);
    if (!Number.isInteger(index) || index === activeIndex) return;
    activeIndex = index;
    updateNavigation();
    scheduleAround(index);
  }, {
    root: gallery,
    threshold: [0.35, 0.55, 0.75]
  });

  cards.forEach((card) => observer.observe(card));
}

function scheduleAround(index) {
  if (!records.length) return;
  const ahead = Math.max(0, Math.min(12, Number(preloadInput.value || 5)));
  const batchSize = Math.max(1, ahead);
  const initialWindow = Math.min(records.length, Math.max(10, batchSize));

  if (preloadFrontier === 0) preloadFrontier = initialWindow;
  if (index + 1 > preloadFrontier) preloadFrontier = Math.min(records.length, index + 1);

  // Extend the frontier in batches when the active record reaches the last
  // preload range, while keeping the first view useful for fast scrolling.
  if (preloadFrontier < records.length && index >= preloadFrontier - batchSize - 1) {
    preloadFrontier = Math.min(records.length, preloadFrontier + batchSize);
  }

  enqueue(index, true);
  for (let i = 0; i < preloadFrontier; i += 1) {
    if (i !== index) enqueue(i, false);
  }
  runQueue();
}

function enqueue(index, priority) {
  const state = renderState.get(index);
  if (state === 'ready' || state === 'loading') return;
  if (queue.includes(index)) {
    if (priority) {
      const pos = queue.indexOf(index);
      queue.splice(pos, 1);
      queue.unshift(index);
    }
    return;
  }
  priority ? queue.unshift(index) : queue.push(index);
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (queue.length) {
      const index = queue.shift();
      if (renderState.get(index) === 'ready') continue;
      await renderIndex(index);
    }
  } finally {
    queueRunning = false;
  }
}

async function renderIndex(index) {
  const card = cards[index];
  if (!card || !sessionId) return;

  const stateEl = card.querySelector('.render-state');
  const titleEl = card.querySelector('.record-title');
  const placeholder = card.querySelector('.placeholder');
  const placeholderText = card.querySelector('.placeholder-text');
  const image = card.querySelector('.snapshot');

  renderState.set(index, 'loading');
  stateEl.textContent = 'Rendering…';
  stateEl.className = 'render-state';
  placeholderText.textContent = 'Rendering page once…';

  try {
    const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/render/${index}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Render failed');

    // This image URL points to a disk-cached PNG. It is never re-rendered
    // by navigation or scrolling. Browser caching is set to immutable for one year.
    image.src = data.snapshotUrl;
    await image.decode().catch(() => {});
    image.classList.add('visible');
    placeholder.classList.add('hidden');

    titleEl.textContent = data.title || `Record ${index + 1}`;
    stateEl.textContent = data.cached ? 'Cached · never reloads' : 'Rendered once · cached';
    stateEl.className = 'render-state ready';
    renderState.set(index, 'ready');

    refreshCacheBadge();
  } catch (err) {
    renderState.set(index, 'error');
    stateEl.textContent = 'Render failed';
    stateEl.className = 'render-state error';
    placeholderText.textContent = err.message;
  }
}

async function uploadFile(file) {
  if (!file) return;
  setStatus(`Uploading ${file.name}…`);
  fileInput.disabled = true;

  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    sessionId = data.sessionId;
    window.sessionSheets = data.sheets || [];
    populateWorkbookControls(window.sessionSheets, data.sheet, data.columnIndex);
    const sessionRes = await fetch(`/api/session/${encodeURIComponent(sessionId)}`);
    const session = await sessionRes.json();
    if (!sessionRes.ok) throw new Error(session.error || 'Could not read session');

    records = session.links || [];
    renderState.clear();
    queue.length = 0;
    setStatus(records.length
      ? `${records.length} valid links · ${data.rejected.length} rejected`
      : 'Choose a column containing allowed links, then Apply');
    if (records.length) buildCards();
    else updateNavigation();
    clearBtn.disabled = false;
  } catch (err) {
    alert(err.message);
    setStatus(err.message);
  } finally {
    fileInput.disabled = false;
    fileInput.value = '';
  }
}

async function applyColumnSelection() {
  if (!sessionId) return;
  applyColumnBtn.disabled = true;
  setStatus('Reading links from selected column…');

  try {
    const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet: sheetSelect.value, columnIndex: columnSelect.value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not apply column');

    records = await fetch(`/api/session/${encodeURIComponent(sessionId)}`)
      .then((response) => response.json())
      .then((session) => session.links || []);
    renderState.clear();
    queue.length = 0;
    setStatus(`${records.length} valid links · ${data.rejected.length} rejected`);
    buildCards();
  } catch (err) {
    setStatus(err.message);
  } finally {
    applyColumnBtn.disabled = false;
  }
}

function clearGallery() {
  observer?.disconnect();
  sessionId = null;
  records = [];
  cards = [];
  renderState.clear();
  queue.length = 0;
  gallery.innerHTML = '<section class="empty-state"><h1>Upload your on-field Excel sheet</h1><p>Choose a file, then select the sheet and column containing the page links.</p></section>';
  workbookControls.hidden = true;
  clearBtn.disabled = true;
  updateNavigation();
  setStatus('Upload an Excel file');
}

function resetRenderedCards() {
  if (!records.length) return;
  observer?.disconnect();
  renderState.clear();
  queue.length = 0;
  buildCards();
}

async function deleteCache() {
  if (!window.confirm('Delete all cached snapshots from the server? Pages will be captured again when needed.')) return;

  deleteCacheBtn.disabled = true;
  setStatus('Deleting cached snapshots…');
  try {
    const res = await fetch('/api/cache', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not delete cache');
    await refreshCacheBadge();
    resetRenderedCards();
    setStatus(`Deleted ${data.deleted} cached files`);
  } catch (err) {
    setStatus(err.message);
  } finally {
    deleteCacheBtn.disabled = false;
  }
}

function goTo(index) {
  if (index < 0 || index >= cards.length) return;
  activeIndex = index;
  updateNavigation();
  scheduleAround(index);
  cards[index].scrollIntoView({ behavior: 'smooth', block: 'start' });
}

fileInput.addEventListener('change', (e) => uploadFile(e.target.files?.[0]));
sheetSelect.addEventListener('change', () => updateColumnOptions());
applyColumnBtn.addEventListener('click', applyColumnSelection);
clearBtn.addEventListener('click', clearGallery);
deleteCacheBtn.addEventListener('click', deleteCache);
helpBtn.addEventListener('click', () => {
  helpPanel.hidden = !helpPanel.hidden;
  helpBtn.setAttribute('aria-expanded', String(!helpPanel.hidden));
});
closeHelpBtn.addEventListener('click', () => {
  helpPanel.hidden = true;
  helpBtn.setAttribute('aria-expanded', 'false');
});
prevBtn.addEventListener('click', () => goTo(activeIndex - 1));
nextBtn.addEventListener('click', () => goTo(activeIndex + 1));
preloadInput.addEventListener('change', () => scheduleAround(activeIndex));

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'PageDown') {
    e.preventDefault();
    goTo(activeIndex + 1);
  } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
    e.preventDefault();
    goTo(activeIndex - 1);
  }
});

refreshCacheBadge();
