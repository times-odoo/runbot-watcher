/**
 * Runbot Watcher — Popup UI
 *
 * Renders the context card (current tab detection) and the watch list.
 * Communicates with the background service worker via chrome.runtime.sendMessage
 * and reads/writes chrome.storage.local.
 */

import { parseRunbotUrl, watchItemUrl } from '../lib/urls.js';
import { getWatches, addWatch, removeWatch, getApiError } from '../lib/storage.js';
import { statusDisplay, isForwardPort, formatFailedBuilds } from '../lib/evaluate.js';

// ── DOM references ───────────────────────────────────────────────────

const contextCard      = document.getElementById('context-card');
const contextNotRunbot = document.getElementById('context-not-runbot');
const contextDetected  = document.getElementById('context-detected');
const contextBadge     = document.getElementById('context-badge');
const contextFwBadge   = document.getElementById('context-fw-badge');
const contextIdEl      = document.getElementById('context-id');
const btnAdd           = document.getElementById('btn-add');
const watchingState    = document.getElementById('watching-state');
const btnRemoveContext = document.getElementById('btn-remove-context');
const watchCountEl     = document.getElementById('watch-count');
const watchListEl      = document.getElementById('watch-list');
const emptyListEl      = document.getElementById('empty-list');
const btnPoll          = document.getElementById('btn-poll');
const pollLabel        = document.getElementById('poll-label');
const pollSpinner      = document.getElementById('poll-spinner');
const apiErrorEl       = document.getElementById('api-error');
const apiErrorMsg      = document.getElementById('api-error-msg');
const toastEl          = document.getElementById('toast');
const linkRunbot       = document.getElementById('link-runbot');

let currentParsed = null; // parsed URL of current tab

// ── Init ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await detectCurrentTab();
  await renderWatchList();
  await checkApiError();

  btnPoll.addEventListener('click', onPollNow);

  if (linkRunbot) {
    linkRunbot.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'https://runbot.odoo.com' });
    });
  }

  // Listen for storage changes to live-update
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.watches) {
      renderWatchList();
      if (currentParsed) updateContextButtons();
    }
    if (area === 'local' && changes.apiError) {
      checkApiError();
    }
  });
});

// ── Current tab detection ────────────────────────────────────────────

async function detectCurrentTab() {
  contextCard.classList.remove('hidden');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      showNotRunbot();
      return;
    }

    currentParsed = parseRunbotUrl(tab.url);
    if (!currentParsed) {
      showNotRunbot();
      return;
    }

    showDetected(currentParsed);
  } catch {
    showNotRunbot();
  }
}

function showNotRunbot() {
  contextNotRunbot.classList.remove('hidden');
  contextDetected.classList.add('hidden');
}

function showDetected(parsed) {
  contextNotRunbot.classList.add('hidden');
  contextDetected.classList.remove('hidden');

  contextBadge.textContent = parsed.type;
  contextBadge.className = `type-tag type-${parsed.type}`;

  const isFw = isForwardPort(parsed.id);
  if (contextFwBadge) {
    contextFwBadge.classList.toggle('hidden', !isFw);
  }

  contextIdEl.textContent = `#${parsed.id}`;
  contextIdEl.title = parsed.id;

  updateContextButtons();

  btnAdd.onclick = () => onAdd(parsed);
  btnRemoveContext.onclick = () => onRemoveContext(parsed);
}

async function updateContextButtons() {
  if (!currentParsed) return;
  const watches = await getWatches();
  const key = `${currentParsed.type}:${currentParsed.id}`;
  const isWatched = watches.some(w => w.key === key);

  btnAdd.classList.toggle('hidden', isWatched);
  watchingState.classList.toggle('hidden', !isWatched);
}

// ── Add / Remove ─────────────────────────────────────────────────────

async function onAdd(parsed) {
  btnAdd.disabled = true;
  const item = await addWatch({
    type: parsed.type,
    id: parsed.id,
    batchId: parsed.batchId,
    label: parsed.id, // placeholder until fetched
  });

  showToast('Added to watch list');
  await updateContextButtons();
  await renderWatchList();
  btnAdd.disabled = false;

  // Fetch real label in background
  chrome.runtime.sendMessage(
    { action: 'fetchLabel', type: parsed.type, id: parsed.id },
    async (response) => {
      if (response?.label) {
        const watches = await getWatches();
        const idx = watches.findIndex(w => w.key === item.key);
        if (idx !== -1) {
          watches[idx].label = response.label;
          await chrome.storage.local.set({ watches });
          renderWatchList();
        }
      }
    }
  );

  // Trigger a poll
  chrome.runtime.sendMessage({ action: 'pollNow' });
}

async function onRemoveContext(parsed) {
  const key = `${parsed.type}:${parsed.id}`;
  await removeWatch(key);
  showToast('Removed from watch list');
  await updateContextButtons();
  await renderWatchList();
}

// ── Watch list rendering ─────────────────────────────────────────────

async function renderWatchList() {
  const watches = await getWatches();

  if (watchCountEl) {
    if (watches.length > 0) {
      watchCountEl.textContent = String(watches.length);
      watchCountEl.classList.remove('hidden');
    } else {
      watchCountEl.classList.add('hidden');
    }
  }

  if (watches.length === 0) {
    emptyListEl.classList.remove('hidden');
    watchListEl.classList.add('hidden');
    return;
  }

  emptyListEl.classList.add('hidden');
  watchListEl.classList.remove('hidden');

  watchListEl.innerHTML = '';
  for (const item of watches) {
    watchListEl.appendChild(createWatchItem(item));
  }
}

function createWatchItem(item) {
  const li = document.createElement('li');
  li.className = 'watch-item';
  li.dataset.key = item.key;

  const status = item.status ? statusDisplay(item.status) : { text: 'pending', cssClass: 'status-pending' };
  const isRunning = status.cssClass === 'status-running';
  const isLoading = !item.label || item.label === item.id;
  const isFw = isForwardPort(item);

  const lastChecked = item.lastCheckedAt
    ? formatRelativeTime(item.lastCheckedAt)
    : 'never';

  li.innerHTML = `
    <div class="watch-item-header">
      <div class="watch-item-tags">
        <span class="type-tag type-${escapeHtml(item.type)}">${escapeHtml(item.type)}</span>
        ${isFw ? '<span class="tag-fw">fw-port</span>' : ''}
        ${item.finished ? '<span class="tag-done">done</span>' : ''}
      </div>
      <div class="watch-item-status-actions">
        <span class="status-chip ${status.cssClass}">
          ${isRunning ? '<span class="pulse-dot"></span>' : ''}
          ${escapeHtml(status.text)}
        </span>
        <div class="watch-actions">
          <button class="btn btn-icon" data-action="open" title="Open in runbot">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </button>
          <button class="btn btn-icon btn-icon-danger" data-action="remove" title="Remove watch">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>
    </div>
    <div class="watch-item-title" title="${escapeHtml(item.label || item.id)}">
      ${isLoading ? '<span class="skeleton"></span>' : escapeHtml(item.label || item.id)}
    </div>
    <div class="watch-item-footer">
      <span class="meta-checked">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        ${escapeHtml(lastChecked)}
      </span>
      ${(() => {
        const failedSummary = formatFailedBuilds(item.status);
        return failedSummary
          ? `<span class="meta-failed" title="${escapeHtml(failedSummary.tooltip)}">${escapeHtml(failedSummary.text)}</span>`
          : '';
      })()}
    </div>
  `;

  // Event listeners
  li.querySelector('[data-action="open"]').addEventListener('click', () => {
    const url = watchItemUrl(item);
    chrome.tabs.create({ url });
  });

  li.querySelector('[data-action="remove"]').addEventListener('click', async () => {
    li.classList.add('removing');
    setTimeout(async () => {
      await removeWatch(item.key);
      showToast('Removed from watch list');
      await renderWatchList();
      if (currentParsed) await updateContextButtons();
    }, 200);
  });

  return li;
}

// ── Poll now ─────────────────────────────────────────────────────────

async function onPollNow() {
  btnPoll.disabled = true;
  pollLabel.classList.add('hidden');
  const pollIcon = btnPoll.querySelector('.poll-icon');
  if (pollIcon) pollIcon.classList.add('hidden');
  pollSpinner.classList.remove('hidden');

  try {
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'pollNow' }, (response) => {
        if (response?.error) reject(new Error(response.error));
        else resolve();
      });
    });
  } catch {
    // Quiet
  }

  // Small delay to let storage update propagate
  await new Promise(r => setTimeout(r, 500));
  await renderWatchList();

  pollSpinner.classList.add('hidden');
  if (pollIcon) pollIcon.classList.remove('hidden');
  pollLabel.classList.remove('hidden');
  btnPoll.disabled = false;
}

// ── API error ────────────────────────────────────────────────────────

async function checkApiError() {
  const err = await getApiError();
  if (err) {
    apiErrorEl.classList.remove('hidden');
    apiErrorMsg.textContent = err;
  } else {
    apiErrorEl.classList.add('hidden');
  }
}

// ── Toast ────────────────────────────────────────────────────────────

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  // Force reflow
  void toastEl.offsetWidth;
  toastEl.classList.add('show');

  setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => toastEl.classList.add('hidden'), 300);
  }, 1800);
}

// ── Helpers ──────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatRelativeTime(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
