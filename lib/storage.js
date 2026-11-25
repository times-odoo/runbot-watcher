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
 * Remove a watch by key.
 */
export async function removeWatch(key) {
  const watches = await getWatches();
  const filtered = watches.filter(w => w.key !== key);
  await saveWatches(filtered);
}

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
    return {
      ...updated,
      notified: notified.length > MAX_NOTIFIED_KEYS ? notified.slice(-MAX_NOTIFIED_KEYS) : notified,
    };
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

export async function getApiError() {
  const result = await chrome.storage.local.get('apiError');
  return result.apiError || null;
}
