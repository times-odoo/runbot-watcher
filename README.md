# Runbot Watcher

A lightweight Chrome extension (Manifest V3) that watches Odoo runbot bundles, batches, and builds. It polls the runbot API every minute and sends desktop notifications on errors and completion.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![Vanilla JS](https://img.shields.io/badge/JS-Vanilla-yellow)
![No Build Step](https://img.shields.io/badge/Build-None-green)

## Features

- **Watch bundles** — tracks the latest batch automatically; switches when a new batch appears
- **Watch batches** — tracks all builds in the batch; notifies when done
- **Watch builds** — tracks a single build (with children); notifies when done
- **Desktop notifications** — instant alerts on errors (`ko` result or ERROR/CRITICAL logs) and on completion, with click-to-open
- **Deduplication** — never notifies twice for the same event
- **Live status** — popup shows real-time state (pending / running / ok / ko) with animated indicators
- **Badge** — extension icon shows the count of watches currently in error
- **Dark UI** — modern deep-navy design with violet accents

## Install

1. Clone or download this folder
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked** and select the `runbot-watcher` folder
5. The extension icon (a purple eye) appears in your toolbar

## Usage

1. Navigate to any runbot page on `https://runbot.odoo.com`:
   - Bundle: `/runbot/bundle/<id>` (e.g., `/runbot/bundle/master-1`)
   - Batch: `/runbot/batch/<id>`
   - Build: `/runbot/batch/<batchId>/build/<buildId>`
2. Click the extension icon — the popup detects the page and shows an **"Add to watch list"** button
3. Click to add it. The extension starts polling every minute.
4. Use **"Poll now"** to force an immediate check.
5. Desktop notifications fire on:
   - **Errors**: `global_result` or `local_result` is `ko`, or ERROR/CRITICAL log lines appear
   - **Completion**: batch/build finishes (green ✅ for ok/warn, red ❌ for ko)
6. Click a notification (or its **Open** button) to jump to the right runbot page.

## Watch Semantics

| Watch type | Tracks | Auto-finishes? |
|------------|--------|----------------|
| **Bundle** | Latest batch of the bundle. Switches to newer batches automatically. | No — always polls |
| **Batch** | That specific batch and all its slot builds. | Yes — when all builds are `done` |
| **Build** | That specific build (`depth=1`). | Yes — when `global_state` is `done` |

## File Structure

```
runbot-watcher/
  manifest.json          # MV3 manifest
  background.js          # Service worker: alarm, polling, notifications
  lib/
    api.js               # Fetch wrappers for bundle/batch/build
    urls.js              # URL parsing (parseRunbotUrl) + URL builders
    storage.js           # Watch list CRUD, notified-set helpers
    evaluate.js          # Pure functions: summarize batch/build → status
  popup/
    popup.html           # Popup markup
    popup.css            # Dark UI styles
    popup.js             # Popup logic: detect tab, render list, add/remove
  icons/
    icon16.png           # Toolbar icon
    icon48.png           # Extensions page
    icon128.png          # Chrome Web Store
  tests/
    test_urls.js         # URL parsing tests
    test_evaluate.js     # Evaluation logic tests
  README.md
```

## Running Tests

Tests use Node.js built-in test runner (no dependencies):

```bash
node --test tests/test_urls.js tests/test_evaluate.js
```

## Runbot API Reference

The extension uses the read-only JSON API of `runbot.odoo.com`:

| Endpoint | Description |
|----------|-------------|
| `GET /runbot/api/bundle/<ids_or_names>` | Bundles with their last 40 batches |
| `GET /runbot/api/batch/<ids>?depth=1&logs=errors` | Batches with slots, builds, commits, logs |
| `GET /runbot/api/build/<ids>?depth=1&logs=errors` | Builds with state, logs, jobs, children |

### Key Fields

- **States**: `pending`, `testing`, `waiting`, `running`, `done`
- **Results**: `ok`, `warn`, `ko`, `skipped`, `killed`
- `global_state`/`global_result` include children; `local_state`/`local_result` do not
- Batch `slots[].build` is an object (the build) or `false` (not created yet)
- `slots[].link_type`: `created`, `matched` (reused), or `rebuild`

## Permissions

| Permission | Why |
|------------|-----|
| `storage` | Persist watch list and notification dedup data |
| `alarms` | 1-minute polling interval (MV3 service workers can't use setInterval) |
| `notifications` | Desktop notifications for errors and completion |
| `tabs` | Detect the current tab URL to offer "Add to watch list" |
| `https://runbot.odoo.com/*` | Fetch the runbot API |

## License

MIT
