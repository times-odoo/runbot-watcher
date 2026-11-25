/**
 * Runbot Watcher — Popup UI
 *
 * Shows the current runbot page (with a Watch button) and the watch list.
 * Talks to the service worker via chrome.runtime.sendMessage and reads/writes
 * chrome.storage.local; the list re-renders on every storage change.
 */

import { parseRunbotUrl, watchItemUrl, RUNBOT_BASE } from '../lib/urls.js';
import {
  getWatches, addWatch, removeWatches, restoreWatches, renameWatch,
  getApiError, getLastPollAt,
} from '../lib/storage.js';
import { statusDisplay, isForwardPort, formatFailedBuilds } from '../lib/evaluate.js';

const $ = (id) => document.getElementById(id);

const contextNotRunbot = $('context-not-runbot');
const contextDetected  = $('context-detected');
const contextIdEl      = $('context-id');
const btnAdd           = $('btn-add');
const watchingState    = $('watching-state');
const btnRemoveContext = $('btn-remove-context');
const watchCountEl     = $('watch-count');
const lastPollEl       = $('last-poll');
const btnClearDone     = $('btn-clear-done');
const btnClearAll      = $('btn-clear-all');
const watchListEl      = $('watch-list');
const emptyListEl      = $('empty-list');
const btnPoll          = $('btn-poll');
const apiErrorEl       = $('api-error');
const apiErrorMsg      = $('api-error-msg');
const toastEl          = $('toast');
const toastMsg         = $('toast-msg');
const toastAction      = $('toast-action');

const ICON_OPEN = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/></svg>';
const ICON_RENAME = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.5l3 3-8 8H2.5v-3z"/><path d="M9 4l3 3"/></svg>';
const ICON_REMOVE = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

// A watch whose last check is this much older than the last poll is shown
// with its own time (finished-OK watches are no longer polled, failed polls).
const STALE_MS = 90_000;

let currentParsed = null; // parsed URL of the active tab
let lastPollAt = null;    // ISO time of the last poll (shared timer)
let editingKey = null;    // watch being renamed: don't re-render under the input
let renderPending = false;

// ── Init ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  lastPollAt = await getLastPollAt();
  await detectCurrentTab();
  await renderWatchList();
  await checkApiError();

  btnPoll.addEventListener('click', onPollNow);
  btnClearAll.addEventListener('click', onClearAll);
  btnClearDone.addEventListener('click', onClearDone);
  $('link-runbot').addEventListener('click', (e) => {
    e.preventDefault();
    openTab(RUNBOT_BASE);
  });

  // Live relative times: only text updates, no re-render.
  setInterval(tickTimes, 1000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.lastPollAt) {
      lastPollAt = changes.lastPollAt.newValue || null;
      tickTimes();
    }
    if (changes.watches) {
      renderWatchList();
      updateContextButtons();
    }
    if (changes.apiError) checkApiError();
  });
});

// ── Current tab ──────────────────────────────────────────────────────

async function detectCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentParsed = parseRunbotUrl(tab?.url);
  } catch {
    currentParsed = null;
  }

  contextNotRunbot.classList.toggle('hidden', !!currentParsed);
  contextDetected.classList.toggle('hidden', !currentParsed);
  if (!currentParsed) return;

  contextIdEl.title = currentParsed.url;
  btnAdd.onclick = () => onAdd(currentParsed);
  btnRemoveContext.onclick = () => onRemoveContext(currentParsed);
  await updateContextButtons();
}

async function updateContextButtons() {
  if (!currentParsed) return;
  const watches = await getWatches();
  const watch = watches.find(w => w.key === `${currentParsed.type}:${currentParsed.id}`);
  btnAdd.classList.toggle('hidden', !!watch);
  watchingState.classList.toggle('hidden', !watch);
  // Once watched (and named), show the same name as in the list.
  contextIdEl.textContent = (watch && displayName(watch)) || `${capitalize(currentParsed.type)} ${currentParsed.id}`;
}

// ── Add / Remove ─────────────────────────────────────────────────────

async function onAdd(parsed) {
  btnAdd.disabled = true;
  try {
    const item = await addWatch({
      type: parsed.type,
      id: parsed.id,
      batchId: parsed.batchId,
      label: parsed.id, // placeholder, replaced by the first poll
    });
    showToast('Watching');
    // Poll only the new item: fills in its label and status.
    chrome.runtime.sendMessage({ action: 'pollNow', keys: [item.key] }).catch(() => {});
  } finally {
    btnAdd.disabled = false;
  }
}

async function onRemoveContext(parsed) {
  await removeWithUndo([`${parsed.type}:${parsed.id}`]);
}

async function onClearAll() {
  const watches = await getWatches();
  await removeWithUndo(watches.map(w => w.key));
}

async function onClearDone() {
  const watches = await getWatches();
  await removeWithUndo(watches.filter(w => w.finished).map(w => w.key));
}

async function removeWithUndo(keys) {
  if (keys.length === 0) return;
  const removed = await removeWatches(keys);
  const message = removed.length === 1
    ? `Stopped watching ${displayName(removed[0].item)}`
    : `Stopped watching ${removed.length} items`;
  showToast(message, {
    action: 'Undo',
    onAction: async () => {
      await restoreWatches(removed);
      showToast('Restored');
    },
  });
}

// ── Watch list ───────────────────────────────────────────────────────

function displayName(item) {
  if (item.customLabel) return item.customLabel;
  const loaded = item.lastCheckedAt || item.lastError;
  return loaded ? (item.label || item.id) : `${capitalize(item.type)} ${item.id}`;
}

async function renderWatchList() {
  if (editingKey) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const watches = await getWatches();

  watchCountEl.textContent = String(watches.length);
  watchCountEl.classList.toggle('hidden', watches.length === 0);
  btnClearAll.classList.toggle('hidden', watches.length === 0);
  btnClearDone.classList.toggle('hidden', !watches.some(w => w.finished) || watches.every(w => w.finished));
  emptyListEl.classList.toggle('hidden', watches.length > 0);
  watchListEl.replaceChildren(...watches.map(createWatchItem));
  tickTimes(watches);
}

function createWatchItem(item) {
  const status = statusDisplay(item.status);
  const statusKey = status.cssClass.replace('status-', ''); // ok|ko|warn|running|pending|done
  const isLoading = !item.lastCheckedAt && !item.lastError;
  const name = displayName(item);
  const tooltip = item.customLabel && item.label ? `${item.customLabel} (${item.label})` : name;
  const url = watchItemUrl(item);

  const failed = formatFailedBuilds(item.status);
  const meta = [`<span>${escapeHtml(item.type)}</span>`];
  if (isLoading) {
    meta.push('<span class="sep">loading…</span>');
  } else if (!failed) {
    // When there are failures, the "Failed: …" summary already says it.
    meta.push(`<span class="sep st-${statusKey}">${escapeHtml(status.text)}</span>`);
  }
  if (isForwardPort(item)) meta.push('<span class="sep">fw-port</span>');
  if (item.lastError) {
    meta.push(`<span class="sep fail" title="${escapeHtml(item.lastError)}">poll failed</span>`);
  }
  if (failed) {
    meta.push(`<span class="sep fail" title="${escapeHtml(failed.tooltip)}">${escapeHtml(failed.text)}</span>`);
  }

  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.status = statusKey;
  li.innerHTML = `
    <span class="dot" title="${escapeHtml(status.text)}"></span>
    <button class="title${isLoading ? ' loading' : ''}" data-action="open" title="${escapeHtml(tooltip)}">${escapeHtml(name)}</button>
    <span class="time" data-since="${escapeHtml(item.lastCheckedAt || '')}" title="Last checked"></span>
    <div class="meta">${meta.join('')}</div>
    <div class="actions">
      <button class="icon-btn" data-action="open" title="Open in runbot" aria-label="Open in runbot">${ICON_OPEN}</button>
      <button class="icon-btn" data-action="rename" title="Rename" aria-label="Rename">${ICON_RENAME}</button>
      <button class="icon-btn remove" data-action="remove" title="Stop watching" aria-label="Stop watching">${ICON_REMOVE}</button>
    </div>
  `;

  for (const btn of li.querySelectorAll('[data-action="open"]')) {
    btn.addEventListener('click', () => openTab(url));
  }
  li.querySelector('[data-action="rename"]').addEventListener('click', () => startRename(li, item));
  li.querySelector('.title').addEventListener('dblclick', (e) => {
    e.preventDefault();
    startRename(li, item);
  });
  li.querySelector('[data-action="remove"]').addEventListener('click', async () => {
    li.classList.add('removing');
    await removeWithUndo([item.key]);
  });

  return li;
}

// ── Rename ───────────────────────────────────────────────────────────

function startRename(li, item) {
  if (editingKey) return;
  editingKey = item.key;

  const input = document.createElement('input');
  input.className = 'rename';
  input.value = displayName(item);
  input.placeholder = item.label || item.id;
  input.setAttribute('aria-label', 'Name (empty to use the runbot name)');
  li.querySelector('.title').replaceWith(input);
  li.classList.add('editing');
  const meta = li.querySelector('.meta');
  const metaHtml = meta.innerHTML;
  meta.textContent = 'Enter to save · Esc to cancel · empty = runbot name';
  meta.classList.add('rename-hint');
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    const changed = save && value !== displayName(item);
    editingKey = null;
    meta.innerHTML = metaHtml;
    meta.classList.remove('rename-hint');
    if (changed) {
      // Typing the runbot name back (or nothing) removes the custom name.
      await renameWatch(item.key, value === item.label ? '' : value);
    } else {
      renderWatchList();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault(); // keep the popup open
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

// ── Times ────────────────────────────────────────────────────────────

/** Update the shared "checked …" timer and stale per-row times. */
function tickTimes(watches) {
  // Before the first poll after an update, fall back to the newest check.
  let last = lastPollAt;
  if (!last && Array.isArray(watches)) {
    last = watches.map(w => w.lastCheckedAt).filter(Boolean).sort().pop() || null;
    lastPollAt = last;
  }
  const hasWatches = watchListEl.childElementCount > 0;
  lastPollEl.textContent = last && hasWatches ? `checked ${formatRelativeTime(last)}` : '';

  const lastMs = last ? Date.parse(last) : 0;
  for (const el of watchListEl.querySelectorAll('.time')) {
    const since = el.dataset.since;
    const stale = since && lastMs - Date.parse(since) > STALE_MS;
    el.textContent = stale ? formatRelativeTime(since) : '';
  }
}

// ── Poll now ─────────────────────────────────────────────────────────

async function onPollNow() {
  btnPoll.disabled = true;
  btnPoll.classList.add('busy');
  try {
    const response = await chrome.runtime.sendMessage({ action: 'pollNow' });
    if (response?.error) showToast(`Check failed: ${response.error}`);
  } catch (err) {
    showToast(`Check failed: ${err.message}`);
  } finally {
    btnPoll.classList.remove('busy');
    btnPoll.disabled = false;
  }
}

// ── API error ────────────────────────────────────────────────────────

async function checkApiError() {
  const err = await getApiError();
  apiErrorMsg.textContent = err || '';
  apiErrorEl.classList.toggle('hidden', !err);
}

// ── Toast ────────────────────────────────────────────────────────────

let toastTimer = null;

/**
 * @param {string} message
 * @param {{ action?: string, onAction?: Function }} [options]  e.g. an Undo button
 */
function showToast(message, { action = null, onAction = null } = {}) {
  toastMsg.textContent = message;
  toastAction.textContent = action || '';
  toastAction.classList.toggle('hidden', !action);
  toastAction.onclick = action ? () => {
    hideToast();
    onAction();
  } : null;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  // Leave time to reach the Undo button.
  toastTimer = setTimeout(hideToast, action ? 6000 : 1800);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.classList.remove('show');
}

// ── Helpers ──────────────────────────────────────────────────────────

function openTab(url) {
  chrome.tabs.create({ url });
}

function capitalize(str) {
  return str ? str[0].toUpperCase() + str.slice(1) : '';
}

function escapeHtml(str) {
  // Also escapes quotes: the result is used inside attribute values.
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRelativeTime(isoString) {
  if (!isoString) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
