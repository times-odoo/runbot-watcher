/**
 * Runbot Watcher — Popup UI
 *
 * Shows the current runbot page (with a Watch button) and the watch list.
 * Talks to the service worker via chrome.runtime.sendMessage and reads/writes
 * chrome.storage.local; the list re-renders on every storage change.
 */

import { parseRunbotUrl, watchItemUrl, RUNBOT_BASE } from '../lib/urls.js';
import { getWatches, addWatch, removeWatch, getApiError } from '../lib/storage.js';
import { statusDisplay, isForwardPort, formatFailedBuilds } from '../lib/evaluate.js';

const $ = (id) => document.getElementById(id);

const contextNotRunbot = $('context-not-runbot');
const contextDetected  = $('context-detected');
const contextIdEl      = $('context-id');
const btnAdd           = $('btn-add');
const watchingState    = $('watching-state');
const btnRemoveContext = $('btn-remove-context');
const watchCountEl     = $('watch-count');
const watchListEl      = $('watch-list');
const emptyListEl      = $('empty-list');
const btnPoll          = $('btn-poll');
const apiErrorEl       = $('api-error');
const apiErrorMsg      = $('api-error-msg');
const toastEl          = $('toast');

const ICON_OPEN = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/></svg>';
const ICON_REMOVE = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

let currentParsed = null; // parsed URL of the active tab

// ── Init ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await detectCurrentTab();
  await renderWatchList();
  await checkApiError();

  btnPoll.addEventListener('click', onPollNow);
  $('link-runbot').addEventListener('click', (e) => {
    e.preventDefault();
    openTab(RUNBOT_BASE);
  });

  // Keep the relative "last checked" times fresh while the popup is open
  setInterval(renderWatchList, 30_000);

  // Re-render on any change (also covers our own writes)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
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

  const typeName = capitalize(currentParsed.type);
  contextIdEl.textContent = `${typeName} ${currentParsed.id}`;
  contextIdEl.title = currentParsed.url;

  btnAdd.onclick = () => onAdd(currentParsed);
  btnRemoveContext.onclick = () => onRemoveContext(currentParsed);
  await updateContextButtons();
}

async function updateContextButtons() {
  if (!currentParsed) return;
  const watches = await getWatches();
  const isWatched = watches.some(w => w.key === `${currentParsed.type}:${currentParsed.id}`);
  btnAdd.classList.toggle('hidden', isWatched);
  watchingState.classList.toggle('hidden', !isWatched);
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
  await removeWatch(`${parsed.type}:${parsed.id}`);
  showToast('Stopped watching');
}

// ── Watch list ───────────────────────────────────────────────────────

async function renderWatchList() {
  const watches = await getWatches();

  watchCountEl.textContent = String(watches.length);
  watchCountEl.classList.toggle('hidden', watches.length === 0);
  emptyListEl.classList.toggle('hidden', watches.length > 0);
  watchListEl.replaceChildren(...watches.map(createWatchItem));
}

function createWatchItem(item) {
  const status = statusDisplay(item.status);
  const statusKey = status.cssClass.replace('status-', ''); // ok|ko|warn|running|pending|done
  const isLoading = !item.lastCheckedAt && !item.lastError;
  const title = isLoading ? `${capitalize(item.type)} ${item.id}` : (item.label || item.id);
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
    <button class="title${isLoading ? ' loading' : ''}" data-action="open" title="${escapeHtml(title)}">${escapeHtml(title)}</button>
    <span class="time" title="Last checked">${escapeHtml(formatRelativeTime(item.lastCheckedAt))}</span>
    <div class="meta">${meta.join('')}</div>
    <div class="actions">
      <button class="icon-btn" data-action="open" title="Open in runbot" aria-label="Open in runbot">${ICON_OPEN}</button>
      <button class="icon-btn remove" data-action="remove" title="Stop watching" aria-label="Stop watching">${ICON_REMOVE}</button>
    </div>
  `;

  for (const btn of li.querySelectorAll('[data-action="open"]')) {
    btn.addEventListener('click', () => openTab(url));
  }
  li.querySelector('[data-action="remove"]').addEventListener('click', async () => {
    li.classList.add('removing');
    await removeWatch(item.key);
    showToast('Stopped watching');
  });

  return li;
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

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
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
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
