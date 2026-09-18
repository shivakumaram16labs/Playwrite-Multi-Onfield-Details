'use strict';

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { chromium } = require('playwright');

const app = express();
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_DIR = path.join(ROOT, 'cache');
const UPLOAD_DIR = path.join(ROOT, 'uploads');

const PORT = Number(process.env.PORT || 9595);
const ALLOWED_HOST = (process.env.ALLOWED_HOST || 'kbocwwb.karnataka.gov.in').toLowerCase();
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 45000);
const POST_LOAD_WAIT_MS = Number(process.env.POST_LOAD_WAIT_MS || 1200);
const VIEWPORT_WIDTH = Number(process.env.VIEWPORT_WIDTH || 1440);
const VIEWPORT_HEIGHT = Number(process.env.VIEWPORT_HEIGHT || 1000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);

for (const dir of [CACHE_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = new Set(['.xlsx', '.xls', '.xlsm', '.csv', '.tsv']);
    if (!allowed.has(ext)) {
      return cb(new Error('Only .xlsx, .xls, .xlsm, .csv, and .tsv files are supported.'));
    }
    cb(null, true);
  }
});

app.use(express.json({ limit: '1mb' }));
app.use('/snapshots', express.static(CACHE_DIR, {
  etag: true,
  immutable: true,
  maxAge: '365d'
}));
app.use(express.static(PUBLIC_DIR));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

let browserPromise = null;
const renderJobs = new Map();
let cacheClearPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox'
      ]
    }).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const LINK_HEADERS = new Set([
  'onfield_link',
  'onfiled_link',
  'on_field_link',
  'onfiledlink',
  'onfieldlink',
  'link',
  'url'
]);

function extractLinkValue(cell) {
  if (!cell) return '';
  if (cell.l && cell.l.Target) return String(cell.l.Target).trim();
  if (typeof cell.v === 'string') return cell.v.trim();
  if (cell.w) return String(cell.w).trim();
  if (cell.v != null) return String(cell.v).trim();
  return '';
}

function parseWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellFormula: false, cellHTML: false });
  const sheets = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
    const headers = [];

    for (let c = range.s.c; c <= range.e.c; c++) {
      const address = XLSX.utils.encode_cell({ r: range.s.r, c });
      const cell = sheet[address];
      headers.push({
        col: c,
        label: cell ? String(cell.w ?? cell.v ?? '').trim() : '',
        normalized: normalizeHeader(cell ? (cell.w ?? cell.v ?? '') : '')
      });
    }

    const matching = headers.find((h) => LINK_HEADERS.has(h.normalized));
    sheets.push({
      name: sheetName,
      headers: headers.map((h) => h.label || XLSX.utils.encode_col(h.col)),
      detectedColumn: matching ? matching.col : null
    });
  }

  return { workbook, sheets };
}

function linksFromSheet(workbook, sheetName, columnIndex) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);

  if (!Number.isInteger(columnIndex) || columnIndex < 0) {
    throw new Error('Select a valid link column.');
  }

  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  const links = [];

  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const address = XLSX.utils.encode_cell({ r, c: columnIndex });
    const value = extractLinkValue(sheet[address]);
    if (!value) continue;

    links.push({
      row: r + 1,
      url: value
    });
  }

  return links;
}

function linksForSelection(workbook, sheets, sheetName, columnIndex) {
  const selectedSheet = sheets.find((sheet) => sheet.name === sheetName) || sheets[0];
  if (!selectedSheet) throw new Error('Workbook contains no sheets.');

  const selectedColumn = Number(columnIndex);
  if (!Number.isInteger(selectedColumn) || selectedColumn < 0 || selectedColumn >= selectedSheet.headers.length) {
    throw new Error('Select a valid link column.');
  }

  const rawLinks = linksFromSheet(workbook, selectedSheet.name, selectedColumn);
  const links = [];
  const rejected = [];

  for (const item of rawLinks) {
    try {
      links.push({ row: item.row, url: assertAllowedUrl(item.url) });
    } catch (err) {
      rejected.push({ row: item.row, value: item.url, reason: err.message });
    }
  }

  if (!links.length) {
    throw new Error('No valid allowed URLs were found in the selected column.');
  }

  return { sheet: selectedSheet.name, columnIndex: selectedColumn, links, rejected };
}

function assertAllowedUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http/https URLs are allowed');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname !== ALLOWED_HOST) {
    throw new Error(`URL host is not allowed. Expected ${ALLOWED_HOST}`);
  }

  return url.toString();
}

function cacheKey(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function cachePaths(url) {
  const key = cacheKey(url);
  return {
    key,
    png: path.join(CACHE_DIR, `${key}.png`),
    json: path.join(CACHE_DIR, `${key}.json`),
    publicPng: `/snapshots/${key}.png`
  };
}

async function readCached(url) {
  const paths = cachePaths(url);
  try {
    const [pngStat, metaText] = await Promise.all([
      fsp.stat(paths.png),
      fsp.readFile(paths.json, 'utf8')
    ]);
    if (!pngStat.isFile()) return null;
    const meta = JSON.parse(metaText);
    return {
      cached: true,
      snapshotUrl: paths.publicPng,
      ...meta
    };
  } catch {
    return null;
  }
}

async function renderSnapshot(rawUrl) {
  if (cacheClearPromise) await cacheClearPromise;
  const url = assertAllowedUrl(rawUrl);
  const cached = await readCached(url);
  if (cached) return cached;

  const key = cacheKey(url);
  if (renderJobs.has(key)) return renderJobs.get(key);

  const job = (async () => {
    const paths = cachePaths(url);
    const browser = await getBrowser();
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      ignoreHTTPSErrors: false,
      serviceWorkers: 'block'
    });

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(RENDER_TIMEOUT_MS);
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);

    // Keep the page visually complete but avoid wasting bandwidth on video/audio.
    await page.route('**/*', async (route) => {
      const type = route.request().resourceType();
      if (type === 'media') return route.abort();
      return route.continue();
    });

    let status = null;
    let finalUrl = url;
    let title = '';
    const startedAt = Date.now();

    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: RENDER_TIMEOUT_MS
      });
      status = response ? response.status() : null;

      // Give client-side apps time to finish painting.
      try {
        await page.waitForLoadState('networkidle', { timeout: Math.min(8000, RENDER_TIMEOUT_MS) });
      } catch {
        // Some apps keep polling; this is fine.
      }
      await page.waitForTimeout(POST_LOAD_WAIT_MS);

      finalUrl = page.url();
      title = await page.title().catch(() => '');

      // A full-page PNG becomes the immutable render for this URL.
      await page.screenshot({
        path: paths.png,
        fullPage: true,
        type: 'png',
        animations: 'disabled'
      });

      const dimensions = await page.evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
        height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
      })).catch(() => ({ width: null, height: null }));

      const meta = {
        originalUrl: url,
        finalUrl,
        title,
        httpStatus: status,
        capturedAt: new Date().toISOString(),
        renderMs: Date.now() - startedAt,
        width: dimensions.width,
        height: dimensions.height
      };

      await fsp.writeFile(paths.json, JSON.stringify(meta, null, 2), 'utf8');

      return {
        cached: false,
        snapshotUrl: paths.publicPng,
        ...meta
      };
    } finally {
      await context.close().catch(() => {});
    }
  })();

  renderJobs.set(key, job);
  try {
    return await job;
  } finally {
    renderJobs.delete(key);
  }
}

const sessions = new Map();

function makeSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

app.post('/api/upload', upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Excel file is required.' });

  try {
    const { workbook, sheets } = parseWorkbook(req.file.path);
    const firstDetected = sheets.find((s) => s.detectedColumn !== null) || sheets[0];

    if (!firstDetected) throw new Error('Workbook contains no sheets.');

    const selectedSheet = req.body.sheet || firstDetected.name;
    const selectedSheetMeta = sheets.find((s) => s.name === selectedSheet) || firstDetected;
    const requestedColumn = req.body.columnIndex !== undefined && req.body.columnIndex !== ''
      ? Number(req.body.columnIndex)
      : selectedSheetMeta.detectedColumn;
    const selection = requestedColumn === null
      ? { sheet: selectedSheetMeta.name, columnIndex: null, links: [], rejected: [] }
      : linksForSelection(workbook, sheets, selectedSheetMeta.name, requestedColumn);

    const sessionId = makeSessionId();
    sessions.set(sessionId, {
      id: sessionId,
      originalName: req.file.originalname,
      workbook,
      sheets,
      sheet: selection.sheet,
      columnIndex: selection.columnIndex,
      links: selection.links,
      createdAt: Date.now()
    });

    res.json({
      sessionId,
      fileName: req.file.originalname,
      sheet: selection.sheet,
      columnIndex: selection.columnIndex,
      total: selection.links.length,
      rejected: selection.rejected,
      sheets
    });
  } catch (err) {
    next(err);
  } finally {
    await fsp.unlink(req.file.path).catch(() => {});
  }
});

app.post('/api/session/:sessionId/select', (req, res, next) => {
  try {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found.' });

    const selection = linksForSelection(session.workbook, session.sheets, req.body.sheet, req.body.columnIndex);
    session.sheet = selection.sheet;
    session.columnIndex = selection.columnIndex;
    session.links = selection.links;

    res.json({
      sessionId: session.id,
      sheet: session.sheet,
      columnIndex: session.columnIndex,
      total: session.links.length,
      rejected: selection.rejected
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/session/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  res.json({
    sessionId: session.id,
    fileName: session.originalName,
    sheet: session.sheet,
    columnIndex: session.columnIndex,
    total: session.links.length,
    links: session.links,
    sheets: session.sheets
  });
});

app.get('/api/session/:sessionId/render/:index', async (req, res, next) => {
  try {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found.' });

    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= session.links.length) {
      return res.status(400).json({ error: 'Invalid record index.' });
    }

    const item = session.links[index];
    const rendered = await renderSnapshot(item.url);

    res.json({
      index,
      row: item.row,
      url: item.url,
      ...rendered
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/cache/status', async (_req, res) => {
  const files = await fsp.readdir(CACHE_DIR).catch(() => []);
  const pngCount = files.filter((f) => f.endsWith('.png')).length;
  res.json({ cachedSnapshots: pngCount });
});

app.delete('/api/cache', async (_req, res, next) => {
  if (cacheClearPromise) return res.status(409).json({ error: 'Cache deletion is already in progress.' });

  cacheClearPromise = (async () => {
    await Promise.allSettled([...renderJobs.values()]);
    const files = await fsp.readdir(CACHE_DIR).catch(() => []);
    const generatedFiles = files.filter((file) => file.endsWith('.png') || file.endsWith('.json'));
    await Promise.all(generatedFiles.map((file) => fsp.unlink(path.join(CACHE_DIR, file))));
    return generatedFiles.length;
  })();

  try {
    const deleted = await cacheClearPromise;
    res.json({ deleted, cachedSnapshots: 0 });
  } catch (err) {
    next(err);
  } finally {
    cacheClearPromise = null;
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err instanceof multer.MulterError ? 400 : 500;
  res.status(status).json({ error: err.message || 'Unexpected server error.' });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`On-field Snapshot Gallery running at http://localhost:${PORT}`);
  console.log(`Allowed host: ${ALLOWED_HOST}`);
});

async function shutdown() {
  server.close();
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      await browser.close();
    } catch {}
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
