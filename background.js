/**
 * Runbot Watcher — MV3 Service Worker
 *
 * Responsibilities:
 *  - Manage the chrome.alarms polling loop (every 1 minute)
 *  - Poll all watched items in parallel
 *  - Send desktop notifications on errors and completion
 *  - Handle notification click → open the right runbot page
 *  - Update the extension badge (error count)
 */

import { fetchBundle, fetchBatch, fetchBuild } from './lib/api.js';
import { evaluateBatch, evaluateBuild, findLatestBatchId, isBuildSettled, overallStatus } from './lib/evaluate.js';
import { buildBatchUrl, buildBuildUrl, watchItemUrl } from './lib/urls.js';
import { getWatches, mergePolledWatches, hasNotified, setApiError, setLastPollAt } from './lib/storage.js';

const ALARM_NAME = 'runbot-poll';
const POLL_INTERVAL_MINUTES = 1;
// Notification ids carry their target URL: `<url>NOTIF_SEP<unique suffix>`.
// This avoids a storage map that must be kept in sync (and cleaned up).
const NOTIF_SEP = '#rw-notif-';

// ── Alarm setup ──────────────────────────────────────────────────────

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  }
}

// Runs every time the service worker wakes up; cheap and keeps the alarm alive.
ensureAlarm();

chrome.runtime.onInstalled.addListener(() => {
  // Leftover from versions that stored notification URLs in a map.
  chrome.storage.local.remove('notifUrlMap');
  getWatches().then(updateBadge);
});

chrome.runtime.onStartup.addListener(() => {
  // The badge is not persisted across browser restarts.
  getWatches().then(updateBadge);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    pollAll();
  }
});

// ── Message handler (popup requests) ─────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'pollNow') {
    pollAll({ force: true, keys: message.keys })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }
});

// ── Poll all watches ─────────────────────────────────────────────────

// Polls are serialized: overlapping runs (alarm + "Poll now") would both
// see the same un-notified events and send duplicate notifications.
let pollQueue = Promise.resolve();

function pollAll(options = {}) {
  const run = pollQueue.then(() => doPollAll(options));
  pollQueue = run.catch(() => {});
  return run;
}

/**
 * @param {Object} options
 * @param {boolean} [options.force]  also poll watches that finished OK
 * @param {string[]} [options.keys] only poll these watch keys
 */
async function doPollAll({ force = false, keys = null } = {}) {
  const watches = await getWatches();
  const toPoll = watches.filter(item => {
    if (keys && !keys.includes(item.key)) return false;
    // Finished-and-OK items are skipped; failed ones keep being polled
    // because they can be rebuilt.
    return force || !(item.finished && item.status?.result === 'ok');
  });

  if (toPoll.length === 0) {
    if (watches.length === 0) await setApiError(null);
    updateBadge(watches);
    return;
  }

  let failures = 0;
  const polled = await Promise.all(toPoll.map(async (item) => {
    try {
      const updated = await pollOne(item);
      return { ...updated, lastCheckedAt: new Date().toISOString(), lastError: null };
    } catch (err) {
      console.warn(`[Runbot Watcher] Error polling ${item.key}:`, err);
      failures++;
      return { ...item, lastError: err.message || String(err) };
    }
  }));

  const merged = await mergePolledWatches(polled);
  await setLastPollAt(new Date().toISOString());
  await setApiError(failures ? `${failures} of ${toPoll.length} API request(s) failed` : null);
  updateBadge(merged);
}

function pollOne(item) {
  switch (item.type) {
    case 'bundle': return pollBundle(item);
    case 'batch':  return pollBatch(item);
    case 'build':  return pollBuild(item);
    default:       return item;
  }
}

function statusOf(status) {
  return { state: status.state, result: status.result, errors: status.errors };
}

// ── Bundle polling ───────────────────────────────────────────────────

async function pollBundle(item) {
  const bundle = await fetchBundle(item.id);
  const latestBatchId = findLatestBatchId(bundle);
  const label = bundle.name || item.label;

  if (!latestBatchId) {
    return { ...item, label, status: { state: 'pending', result: null, errors: [] } };
  }

  const batch = await fetchBatch(latestBatchId);
  const status = evaluateBatch(batch);

  await notifyErrors(item, status, (buildId) => buildBuildUrl(batch.id || latestBatchId, buildId));

  // Only notify completion for a batch we already saw on a previous poll:
  // when the watch is added on an already-finished bundle, stay quiet.
  if (status.allDone && item.trackedBatchId === latestBatchId) {
    await notifyBatchDone(item, batch, status);
  }

  // Bundle watches never auto-finish.
  return { ...item, label, status: statusOf(status), trackedBatchId: latestBatchId };
}

// ── Batch polling ────────────────────────────────────────────────────

async function pollBatch(item) {
  const batch = await fetchBatch(item.id);
  const status = evaluateBatch(batch);
  const label = batch.bundle_name ? `${batch.bundle_name} #${item.id}` : item.label;

  await notifyErrors(item, status, (buildId) => buildBuildUrl(item.id, buildId));

  if (status.allDone && !item.finished) {
    await notifyBatchDone(item, batch, status);
  }

  return { ...item, label, status: statusOf(status), finished: status.allDone };
}

// ── Build polling ────────────────────────────────────────────────────

async function pollBuild(item) {
  const build = await fetchBuild(item.id);
  const status = evaluateBuild(build);
  const trigger = build.trigger || build.config || '';
  const label = trigger ? `Build #${item.id} (${trigger})` : item.label;
  const batchId = item.batchId || (build.create_batch_id ? String(build.create_batch_id) : undefined);
  const urlFor = (buildId) => (batchId ? buildBuildUrl(batchId, buildId) : watchItemUrl(item));
  const finished = isBuildSettled(build, status);

  // Errors without a buildId belong to the watched build itself.
  await notifyErrors(item, status, urlFor, { defaultBuildId: item.id });

  if (finished && !item.finished) {
    const doneKey = `done:build:${item.id}:${status.result || 'ok'}`;
    if (!hasNotified(item, doneKey)) {
      const failed = status.result === 'ko';
      await sendNotification(item, {
        title: failed
          ? `❌ Build #${item.id} failed`
          : `✅ Build #${item.id} finished ${status.result || 'ok'}`,
        message: failed
          ? (status.errors[0]?.message || 'Build finished with errors')
          : (trigger ? `Trigger: ${trigger}` : 'Build completed successfully'),
        url: urlFor(item.id),
        notifKey: doneKey,
        requireInteraction: failed,
      });
    }
  }

  return { ...item, label, batchId, status: statusOf(status), finished };
}

// ── Notification helpers ─────────────────────────────────────────────

async function notifyErrors(item, status, urlFor, { defaultBuildId = null } = {}) {
  for (const error of status.errors) {
    const buildId = error.buildId || defaultBuildId;
    if (!buildId) continue; // batch-level log, no build to point to
    const notifKey = `error:${buildId}`;
    if (hasNotified(item, notifKey)) continue;
    await sendNotification(item, {
      title: `❌ Error in ${error.trigger || 'build'} #${buildId}`,
      message: truncate(error.message, 200) + (error.knownError ? ' (known error)' : ''),
      url: urlFor(buildId),
      notifKey,
      requireInteraction: true,
    });
  }
}

async function notifyBatchDone(item, batch, status) {
  const batchId = batch.id || item.id;
  const doneKey = `done:${batchId}:${status.result || 'ok'}`;
  if (hasNotified(item, doneKey)) return;

  const failed = status.result === 'ko';
  await sendNotification(item, {
    title: failed
      ? `❌ Batch #${batchId} finished with failures`
      : `✅ Batch #${batchId} finished ${status.result || 'ok'}`,
    message: failed
      ? (status.errors.length
        ? `${status.errors.length} error(s) — ${truncate(status.errors[0].message, 150)}`
        : 'Batch finished with errors')
      : (batch.bundle_name ? `Bundle: ${batch.bundle_name}` : 'All builds passed'),
    url: buildBatchUrl(batchId),
    notifKey: doneKey,
    requireInteraction: failed,
  });
}

async function sendNotification(item, { title, message, url, notifKey, requireInteraction = false }) {
  const iconState = title.startsWith('✅') ? 'ok' : 'ko';
  // Mark as notified on the in-memory item; pollAll persists it afterwards.
  item.notified = [...(item.notified || []), notifKey];

  const notifId = `${url}${NOTIF_SEP}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const options = {
    type: 'basic',
    iconUrl: chrome.runtime.getURL(`icons/status/${iconState}_128.png`),
    title,
    message: message || ' ',
    requireInteraction,
  };
  try {
    await chrome.notifications.create(notifId, { ...options, buttons: [{ title: 'Open' }] });
  } catch {
    // Buttons are not supported on every platform: retry without them.
    await chrome.notifications.create(notifId, options);
  }
}

function openFromNotification(notifId) {
  const idx = notifId.lastIndexOf(NOTIF_SEP);
  if (idx > 0) {
    chrome.tabs.create({ url: notifId.slice(0, idx) });
  }
  chrome.notifications.clear(notifId);
}

chrome.notifications.onClicked.addListener(openFromNotification);
chrome.notifications.onButtonClicked.addListener((notifId, buttonIndex) => {
  if (buttonIndex === 0) openFromNotification(notifId);
});

// ── Toolbar icon + badge ─────────────────────────────────────────────

// Icon colour = overall state (grey idle, blue running, green ok, red ko);
// the badge counts watches in error.
const STATUS_ICONS = Object.fromEntries(['idle', 'running', 'ok', 'ko'].map(state => [
  state,
  Object.fromEntries([16, 32, 48, 128].map(size => [size, `icons/status/${state}_${size}.png`])),
]));
const STATUS_TITLES = {
  idle: 'Runbot Watcher',
  running: 'Runbot Watcher: builds running',
  ok: 'Runbot Watcher: all OK',
  ko: 'Runbot Watcher: failures',
};

function updateBadge(watches) {
  const overall = overallStatus(watches);
  chrome.action.setIcon({ path: STATUS_ICONS[overall] });
  chrome.action.setTitle({ title: STATUS_TITLES[overall] });

  const errorCount = watches.filter(
    w => w.status && (w.status.result === 'ko' || w.status.errors?.length > 0)
  ).length;
  chrome.action.setBadgeText({ text: errorCount > 0 ? String(errorCount) : '' });
  // Charcoal, not red: a red badge disappears on the red (failure) icon.
  chrome.action.setBadgeBackgroundColor({ color: '#1f2328' });
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
}

// Keep the icon in sync when the popup adds/removes watches between polls.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.watches) updateBadge(changes.watches.newValue || []);
});

// ── Utilities ────────────────────────────────────────────────────────

function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}
