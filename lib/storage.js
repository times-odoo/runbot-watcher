/**
 * Watch list CRUD and notified-set helpers backed by chrome.storage.local.
 *
 * Watch item shape:
 * {
 *   key: "<type>:<id>",         // unique identifier
 *   type: "bundle"|"batch"|"build",
 *   id: string,                 // bundle id/slug, batch id, or build id
 *   batchId?: string,           // for build watches
 *   label: string,              // human-readable name, fetched async
 *   addedAt: string,            // ISO timestamp
 *   lastCheckedAt: string|null, // ISO timestamp of last poll
 *   status: object|null,        // { state, result, errors[] } from evaluate
 *   finished: boolean,          // true when done polling
 *   lastError?: string|null,    // message of the last failed poll, if any
 *   customLabel?: string,       // name given by the user (popup-owned, wins over label)
 *   trackedBatchId?: string,    // for bundle watches: the latest batch being tracked
 *   notified: string[],         // dedup keys like "error:123", "done:456"
 * }
 */

const WATCHES_KEY = 'watches';
// Dedup keys kept per watch; bundle watches accumulate keys for every new batch.
const MAX_NOTIFIED_KEYS = 300;

/**
 * Get all watched items.
 * @returns {Promise<Object[]>}
 */
export async function getWatches() {
  const result = await chrome.storage.local.get(WATCHES_KEY);
  return result[WATCHES_KEY] || [];
}

/**
 * Save the full watches array.
 */
export async function saveWatches(watches) {
  await chrome.storage.local.set({ [WATCHES_KEY]: watches });
}

/**
 * Add a new watch item. Returns the created item.
 * No-op if already watching (returns existing item).
 */
export async function addWatch({ type, id, batchId, label }) {
  const watches = await getWatches();
  const key = `${type}:${id}`;
  const existing = watches.find(w => w.key === key);
  if (existing) return existing;

  const item = {
    key,
    type,
    id,
    ...(batchId ? { batchId } : {}),
    label: label || id,
    addedAt: new Date().toISOString(),
    lastCheckedAt: null,
    status: null,
    finished: false,
    ...(type === 'bundle' ? { trackedBatchId: null } : {}),
    notified: [],
  };
  watches.push(item);
  await saveWatches(watches);
  return item;
}

/**
 * Remove watches by key. Returns the removed items with their positions,
 * so they can be put back with restoreWatches() (undo).
 * @param {string[]} keys
 * @returns {Promise<Array<{ item: Object, index: number }>>}
 */
export async function removeWatches(keys) {
  const watches = await getWatches();
  const removed = [];
  const kept = [];
  watches.forEach((item, index) => {
    if (keys.includes(item.key)) removed.push({ item, index });
    else kept.push(item);
  });
  await saveWatches(kept);
  return removed;
}

export async function removeWatch(key) {
  return removeWatches([key]);
}

/**
 * Undo a removal: put the items back at their former positions
 * (skipping any that were re-added meanwhile).
 */
export async function restoreWatches(removed) {
  const watches = await getWatches();
  const existing = new Set(watches.map(w => w.key));
  for (const { item, index } of [...removed].sort((a, b) => a.index - b.index)) {
    if (existing.has(item.key)) continue;
    watches.splice(Math.min(index, watches.length), 0, item);
  }
  await saveWatches(watches);
}

/**
 * Give a watch a custom name; an empty name restores the runbot one.
 */
export async function renameWatch(key, name) {
  const watches = await getWatches();
  const item = watches.find(w => w.key === key);
  if (!item) return;
  const trimmed = (name || '').trim();
  if (trimmed) item.customLabel = trimmed;
  else delete item.customLabel;
  await saveWatches(watches);
}

// Fields the popup owns: a poll that started before the user edited them
// must not write back its stale copy.
const POPUP_FIELDS = ['customLabel'];

/**
 * Persist polled watch items without clobbering changes made meanwhile.
 *
 * Polling takes a while; during that time the popup may add or remove
 * watches. Re-read the stored list and only replace items that still exist.
 * @param {Object[]} polled  updated watch items, keyed by .key
 */
export async function mergePolledWatches(polled) {
  const byKey = new Map(polled.map(w => [w.key, w]));
  const current = await getWatches();
  const merged = current.map(w => {
    const updated = byKey.get(w.key);
    if (!updated) return w;
    const notified = updated.notified || [];
    const merged = {
      ...updated,
      notified: notified.length > MAX_NOTIFIED_KEYS ? notified.slice(-MAX_NOTIFIED_KEYS) : notified,
    };
    for (const field of POPUP_FIELDS) {
      if (field in w) merged[field] = w[field];
      else delete merged[field];
    }
    return merged;
  });
  await saveWatches(merged);
  return merged;
}

/**
 * Check if a notification key has already been sent for a watch.
 */
export function hasNotified(watchItem, notifKey) {
  return (watchItem.notified || []).includes(notifKey);
}

/**
 * Store/get the last API error state for the popup to show.
 */
export async function setApiError(errorMsg) {
  await chrome.storage.local.set({ apiError: errorMsg || null });
}

/** When the last poll finished (shown as one shared timer in the popup). */
export async function setLastPollAt(iso) {
  await chrome.storage.local.set({ lastPollAt: iso });
}

export async function getLastPollAt() {
  return (await chrome.storage.local.get('lastPollAt')).lastPollAt || null;
}

export async function getApiError() {
  const result = await chrome.storage.local.get('apiError');
  return result.apiError || null;
}
