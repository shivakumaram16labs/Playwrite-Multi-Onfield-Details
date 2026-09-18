# On-field Snapshot Gallery

This application solves the iframe reload problem by **not keeping multiple KBOCWWB pages live in the browser**.

Each Excel URL is opened by a headless Chromium browser on the Node.js server exactly when needed. A full-page PNG is captured and written to `cache/`. From that point onward, the gallery displays the cached PNG and does not open that KBOCWWB URL again unless you manually delete the cache file.

## What it does

- Upload `.xlsx`, `.xls`, `.xlsm`, `.csv`, or `.tsv`.
- Automatically detects common columns such as `onfield_link` and `onfiled_link`.
- Accepts normal URL text and Excel hyperlink cells.
- Restricts rendering to `kbocwwb.karnataka.gov.in` by default.
- Displays records in a vertical reel/gallery.
- Renders the current record first.
- Queues the next 5 records by default, one at a time.
- Uses SHA-256 of the URL as the permanent cache key.
- A cached URL is immediately reused and **not rendered again**.
- Full-page screenshots remain internally scrollable in each record card.

## Folder structure

```text
onfield_snapshot_gallery/
├── server.js
├── package.json
├── .env.example
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── cache/            # Generated PNG + JSON metadata
└── uploads/          # Temporary Excel uploads; deleted after parsing
```

## macOS setup

### 1. Install Node.js

If Node is already installed, check:

```bash
node -v
npm -v
```

If not, with Homebrew:

```bash
brew install node
```

Node 20+ is recommended.

### 2. Open the project folder

```bash
cd onfield_snapshot_gallery
```

### 3. Install dependencies

```bash
npm install
```

### 4. Install Playwright Chromium

```bash
npx playwright install chromium
```

### 5. Optional configuration

```bash
cp .env.example .env
```

Default configuration already uses:

```text
PORT=3000
ALLOWED_HOST=kbocwwb.karnataka.gov.in
```

### 6. Start the application

```bash
npm start
```

With the included `.env.example` copied to `.env`, open:

```text
http://localhost:3000
```

Without a `.env` file, the server fallback port is `9595`, so open `http://localhost:9595` instead.

Do **not** open `public/index.html` directly with `file://`; this application requires the Node backend.

## Deploy to Render with Docker

This repository includes a `Dockerfile` based on the official Playwright image. Render installs Node dependencies, Chromium, and the required browser libraries during the Docker build, so Playwright does not need to be installed separately on the Render server.

### Deploy from GitHub

1. Push this folder to a GitHub repository.
2. In Render, choose **New +** and then **Blueprint**.
3. Select the repository. Render detects `render.yaml` and creates the web service.
4. Deploy the service and open the generated `onrender.com` URL.

You can also choose **New Web Service**, select **Docker**, and deploy directly from the repository. The start command is already defined in the Docker image.

Render provides the `PORT` environment variable automatically. The application listens on `0.0.0.0` and exposes `/health` for Render health checks.

### Cache persistence on Render

The snapshot cache is stored in `/app/cache`. A normal Render filesystem is ephemeral, so cached PNGs can be lost when the service is redeployed or restarted. If snapshots must survive deployments, attach a Render persistent disk mounted at `/app/cache` on a plan that supports disks. Without a persistent disk, the application still works; it simply captures URLs again after the cache is removed.

The uploaded workbook is temporary and is deleted after parsing. It is never stored in the image or cache.

## How to use

1. Start the Node server.
2. Open the URL printed by the server in Chrome (`http://localhost:3000` with `.env`, or `http://localhost:9595` without it).
3. Click **Upload Excel**.
4. Choose the worksheet and the column containing the page links. Columns named `onfield_link`, `onfiled_link`, `on_field_link`, `link`, or `url` are detected automatically, but any column can be selected manually.
5. Click **Apply**. The workbook does not need to be uploaded again when changing the worksheet or column.
6. Record 1 starts rendering immediately.
7. The first 10 records are queued in the background. When you reach the end of the loaded range, the **Preload ahead** value adds the next batch; with the default value of `5`, reaching record 5 extends the range to record 15, then reaching record 10 extends it to record 20.
8. Scroll vertically, or use Previous / Next.
9. If you return to an earlier record, the existing PNG is used. The KBOCWWB URL is not opened again.

The browser also includes a **Help** button with this workflow, the reason snapshots are used, and a summary of the API endpoints.

## API endpoints

All endpoints are served by the same Node application.

| Method and route | Purpose |
| --- | --- |
| `POST /api/upload` | Accepts a multipart `file`, parses the workbook, creates a session, and returns sheet/header metadata. |
| `GET /api/session/:sessionId` | Returns the selected sheet, column, and current valid links for a session. |
| `POST /api/session/:sessionId/select` | Accepts JSON `{ "sheet": "Sheet1", "columnIndex": 2 }`, validates that column, and replaces the session links without another upload. |
| `GET /api/session/:sessionId/render/:index` | Renders or retrieves one record and returns its cached PNG URL and metadata. |
| `GET /api/cache/status` | Returns the number of PNG snapshots currently stored in `cache/`. |
| `DELETE /api/cache` | Deletes all generated PNG and JSON cache files. |

The render endpoint is intentionally server-side. Playwright opens the allowed URL once, captures a full-page PNG, and subsequent requests reuse that file. This avoids keeping many live pages or iframes open in the browser, prevents navigation from reloading earlier records, and makes the gallery usable for large workbooks.

## Exact caching behavior

Suppose the Excel has 381 URLs.

When viewing record 1:

```text
1 -> render now
2 -> queued
3 -> queued
4 -> queued
5 -> queued
6 -> queued
```

After record 1 is captured:

```text
cache/<sha256>.png
cache/<sha256>.json
```

If you later return to record 1, the server checks the cache first and returns the saved PNG.

There is no call to KBOCWWB for that URL again.

Even after restarting Node, the cache remains on disk.

## If you intentionally want fresh snapshots

Click **Delete cache** in the header and confirm. This removes every generated `.png` and `.json` file from `cache/`; the current gallery is reset and pages are captured again when needed.

The equivalent API request is:

```bash
curl -X DELETE http://localhost:9595/api/cache
```

You can also stop the server and delete all cache files manually:

```bash
rm -f cache/*.png cache/*.json
```

Then restart the app.

## Authentication/session note

If the on-field URLs require an authenticated login cookie, the default headless browser will not automatically inherit your normal Chrome login.

For the public URLs you provided, no additional login configuration should be necessary if they are directly accessible.

If authentication is required later, the server can be extended to use a Playwright persistent browser profile or a saved authenticated storage state.

## Security

The backend intentionally refuses URLs outside:

```text
kbocwwb.karnataka.gov.in
```

This is important because a screenshot endpoint that accepts arbitrary URLs can otherwise become an SSRF/security problem.

If you need another approved host, edit `.env`:

```text
ALLOWED_HOST=example.gov.in
```

Then restart the server.

## Troubleshooting

### Browser executable missing

Run:

```bash
npx playwright install chromium
```

### Page takes too long

Increase in `.env`:

```text
RENDER_TIMEOUT_MS=60000
POST_LOAD_WAIT_MS=2000
```

### Snapshot is stale

That is intentional. The project follows **render once and never reload** semantics.
Delete the corresponding cache file only when you explicitly want a new capture.

### Port 3000 is already in use

Set in `.env`:

```text
PORT=3001
```

Then open `http://localhost:3001`.
