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
import { evaluateBatch, evaluateBuild, findLatestBatchId, getSlotBuilds } from './lib/evaluate.js';
import { buildBatchUrl, buildBuildUrl, buildBundleUrl, watchItemUrl } from './lib/urls.js';
import {
  getWatches, saveWatches, updateWatch,
  hasNotified,
  setNotifUrl, getNotifUrl, clearNotifUrl,
  setApiError,
} from './lib/storage.js';

const ALARM_NAME = 'runbot-poll';
const POLL_INTERVAL_MINUTES = 1;

// ── Alarm setup ──────────────────────────────────────────────────────

function ensureAlarm() {
  chrome.alarms.get(ALARM_NAME, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
      console.log('[Runbot Watcher] Alarm created');
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  console.log('[Runbot Watcher] Installed');
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  console.log('[Runbot Watcher] Startup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    pollAll();
  }
});

// ── Message handler (popup requests) ─────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'pollNow') {
    pollAll().then(() => sendResponse({ ok: true })).catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }
  if (message.action === 'fetchLabel') {
    fetchLabelForWatch(message.type, message.id)
      .then(label => sendResponse({ label }))
      .catch(err => sendResponse({ label: message.id, error: err.message }));
    return true;
  }
});

// ── Fetch a human-readable label ─────────────────────────────────────

async function fetchLabelForWatch(type, id) {
  try {
    if (type === 'bundle') {
      const bundle = await fetchBundle(id);
      return bundle.name || String(id);
    }
    if (type === 'batch') {
      const batch = await fetchBatch(id);
      return batch.bundle_name ? `${batch.bundle_name} #${id}` : `Batch #${id}`;
    }
    if (type === 'build') {
      const build = await fetchBuild(id);
      const trigger = build.trigger || build.config || '';
      return trigger ? `Build #${id} (${trigger})` : `Build #${id}`;
    }
  } catch {
    // Fall back to the raw id
  }
  return String(id);
}

// ── Poll all watches ─────────────────────────────────────────────────

async function pollAll() {
  console.log('[Runbot Watcher] Polling...');
  const watches = await getWatches();
  if (watches.length === 0) {
    await setApiError(null);
    updateBadge(watches);
    return;
  }

  let hadError = false;

  const results = await Promise.allSettled(
    watches.map(async (item) => {
      if (item.finished) return item; // skip done items
      try {
        const updated = await pollOne(item);
        return updated;
      } catch (err) {
        console.warn(`[Runbot Watcher] Error polling ${item.key}:`, err.message);
        hadError = true;
        return { ...item, lastCheckedAt: new Date().toISOString() };
      }
    })
  );

  // Merge results back
  const updatedWatches = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return watches[i]; // keep old on rejection
  });

  await saveWatches(updatedWatches);
  await setApiError(hadError ? 'Some API requests failed' : null);
  updateBadge(updatedWatches);
}

async function pollOne(item) {
  switch (item.type) {
    case 'bundle':  return pollBundle(item);
    case 'batch':   return pollBatch(item);
    case 'build':   return pollBuildWatch(item);
    default:        return item;
  }
}

// ── Bundle polling ───────────────────────────────────────────────────

async function pollBundle(item) {
  const bundle = await fetchBundle(item.id);
  const latestBatchId = findLatestBatchId(bundle);
  const label = bundle.name || item.label;

  if (!latestBatchId) {
    return {
      ...item,
      label,
      lastCheckedAt: new Date().toISOString(),
      status: { state: 'pending', result: null, errors: [] },
    };
  }

  // Fetch the latest batch
  const batch = await fetchBatch(latestBatchId);
  const status = evaluateBatch(batch);

  // Notify errors
  await notifyBatchErrors(item, batch, status);

  // Notify completion if the tracked batch just finished
  if (status.allDone && item.trackedBatchId === latestBatchId) {
    await notifyBatchDone(item, batch, status);
  }

  return {
    ...item,
    label,
    lastCheckedAt: new Date().toISOString(),
    status: { state: status.state, result: status.result, errors: status.errors },
    trackedBatchId: latestBatchId,
    // Bundle watches never auto-finish
  };
}

// ── Batch polling ────────────────────────────────────────────────────

async function pollBatch(item) {
  const batch = await fetchBatch(item.id);
  const status = evaluateBatch(batch);
  const label = batch.bundle_name ? `${batch.bundle_name} #${item.id}` : item.label;

  // Notify errors
  await notifyBatchErrors(item, batch, status);

  // Check if done
  let finished = item.finished;
  if (status.allDone && !finished) {
    finished = true;
    await notifyBatchDone(item, batch, status);
  }

  return {
    ...item,
    label,
    lastCheckedAt: new Date().toISOString(),
    status: { state: status.state, result: status.result, errors: status.errors },
    finished,
  };
}

// ── Build polling ────────────────────────────────────────────────────

async function pollBuildWatch(item) {
  const build = await fetchBuild(item.id);
  const status = evaluateBuild(build);
  const trigger = build.trigger || build.config || '';
  const label = trigger ? `Build #${item.id} (${trigger})` : item.label;
  const batchId = item.batchId || (build.create_batch_id ? String(build.create_batch_id) : item.batchId);

  // Notify errors
  for (const error of status.errors) {
    const notifKey = `error:${item.id}`;
    if (!hasNotified(item, notifKey)) {
      const url = batchId
        ? buildBuildUrl(batchId, item.id)
        : watchItemUrl(item);
      await sendNotification(item, {
        title: `❌ Build #${item.id} error`,
        message: truncate(error.message, 200) + (error.knownError ? ' (known error)' : ''),
        url,
        notifKey,
        requireInteraction: true,
      });
    }
  }

  // Check if done
  let finished = item.finished;
  if (status.state === 'done' && !finished) {
    finished = true;
    const doneKey = `done:build:${item.id}`;
    if (!hasNotified(item, doneKey)) {
      const url = batchId
        ? buildBuildUrl(batchId, item.id)
        : watchItemUrl(item);
      if (status.result === 'ko') {
        await sendNotification(item, {
          title: `❌ Build #${item.id} failed`,
          message: status.errors[0]?.message || 'Build finished with errors',
          url,
          notifKey: doneKey,
          requireInteraction: true,
        });
      } else {
        await sendNotification(item, {
          title: `✅ Build #${item.id} finished ${status.result || 'OK'}`,
          message: trigger ? `Trigger: ${trigger}` : 'Build completed successfully',
          url,
          notifKey: doneKey,
        });
      }
    }
  }

  return {
    ...item,
    label,
    batchId,
    lastCheckedAt: new Date().toISOString(),
    status: { state: status.state, result: status.result, errors: status.errors },
    finished,
  };
}

// ── Batch notification helpers ───────────────────────────────────────

async function notifyBatchErrors(item, batch, status) {
  for (const error of status.errors) {
    if (!error.buildId) continue;
    const notifKey = `error:${error.buildId}`;
    if (!hasNotified(item, notifKey)) {
      const batchId = batch.id || item.id;
      const url = buildBuildUrl(batchId, error.buildId);
      await sendNotification(item, {
        title: `❌ Error in ${error.trigger || 'build'} #${error.buildId}`,
        message: truncate(error.message, 200) + (error.knownError ? ' (known error)' : ''),
        url,
        notifKey,
        requireInteraction: true,
      });
    }
  }
}

async function notifyBatchDone(item, batch, status) {
  const batchId = batch.id || item.id;
  const doneKey = `done:${batchId}`;
  if (hasNotified(item, doneKey)) return;

  const url = buildBatchUrl(batchId);
  if (status.result === 'ko') {
    await sendNotification(item, {
      title: `❌ Batch #${batchId} finished with failures`,
      message: status.errors.length
        ? `${status.errors.length} error(s) — ${truncate(status.errors[0].message, 150)}`
        : 'Batch finished with errors',
      url,
      notifKey: doneKey,
      requireInteraction: true,
    });
  } else {
    await sendNotification(item, {
      title: `✅ Batch #${batchId} finished OK`,
      message: batch.bundle_name ? `Bundle: ${batch.bundle_name}` : 'All builds passed',
      url,
      notifKey: doneKey,
    });
  }
}

// ── Notification sender ──────────────────────────────────────────────

async function sendNotification(item, { title, message, url, notifKey, requireInteraction }) {
  // Mark as notified IN MEMORY on the item first, before any async work.
  // This prevents duplicate notifications within the same poll cycle.
  // The caller (pollAll) persists the full watches array at the end,
  // so we must NOT use markNotified() which writes to storage and gets
  // overwritten by pollAll's final saveWatches().
  if (!item.notified) item.notified = [];
  if (!item.notified.includes(notifKey)) {
    item.notified.push(notifKey);
  }

  const notifId = `rw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await chrome.notifications.create(notifId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      requireInteraction: requireInteraction || false,
      buttons: [{ title: 'Open' }],
    });
  } catch (err) {
    // Buttons may not be supported on all platforms, retry without
    await chrome.notifications.create(notifId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      requireInteraction: requireInteraction || false,
    });
  }

  // Store URL for click handler
  await setNotifUrl(notifId, url);
}

// ── Notification click handlers ──────────────────────────────────────

chrome.notifications.onClicked.addListener(async (notifId) => {
  const url = await getNotifUrl(notifId);
  if (url) {
    chrome.tabs.create({ url });
    chrome.notifications.clear(notifId);
    await clearNotifUrl(notifId);
  }
});

chrome.notifications.onButtonClicked.addListener(async (notifId, buttonIndex) => {
  if (buttonIndex === 0) {
    const url = await getNotifUrl(notifId);
    if (url) {
      chrome.tabs.create({ url });
      chrome.notifications.clear(notifId);
      await clearNotifUrl(notifId);
    }
  }
});

// ── Badge ────────────────────────────────────────────────────────────

function updateBadge(watches) {
  const errorCount = watches.filter(
    w => w.status && (w.status.result === 'ko' || (w.status.errors && w.status.errors.length > 0))
  ).length;

  if (errorCount > 0) {
    chrome.action.setBadgeText({ text: String(errorCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ── Utilities ────────────────────────────────────────────────────────

function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}
