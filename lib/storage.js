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
 *   trackedBatchId?: string,    // for bundle watches: the latest batch being tracked
 *   notified: string[],         // dedup keys like "error:123", "done:456"
 * }
 */

const WATCHES_KEY = 'watches';
const NOTIF_MAP_KEY = 'notifUrlMap'; // notificationId -> URL for click-to-open

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
 * Update a watch item by key (shallow merge).
 */
export async function updateWatch(key, updates) {
  const watches = await getWatches();
  const index = watches.findIndex(w => w.key === key);
  if (index === -1) return;
  watches[index] = { ...watches[index], ...updates };
  await saveWatches(watches);
  return watches[index];
}

/**
 * Check if a notification key has already been sent for a watch.
 */
export function hasNotified(watchItem, notifKey) {
  return (watchItem.notified || []).includes(notifKey);
}

/**
 * Mark a notification key as sent for a watch.
 */
export async function markNotified(watchKey, notifKey) {
  const watches = await getWatches();
  const item = watches.find(w => w.key === watchKey);
  if (!item) return;
  if (!item.notified) item.notified = [];
  if (!item.notified.includes(notifKey)) {
    item.notified.push(notifKey);
    await saveWatches(watches);
  }
}

/**
 * Store a notification-id -> URL mapping for click-to-open.
 */
export async function setNotifUrl(notifId, url) {
  const result = await chrome.storage.local.get(NOTIF_MAP_KEY);
  const map = result[NOTIF_MAP_KEY] || {};
  map[notifId] = url;
  await chrome.storage.local.set({ [NOTIF_MAP_KEY]: map });
}

/**
 * Get the URL for a notification id.
 */
export async function getNotifUrl(notifId) {
  const result = await chrome.storage.local.get(NOTIF_MAP_KEY);
  const map = result[NOTIF_MAP_KEY] || {};
  return map[notifId] || null;
}

/**
 * Remove a notification mapping.
 */
export async function clearNotifUrl(notifId) {
  const result = await chrome.storage.local.get(NOTIF_MAP_KEY);
  const map = result[NOTIF_MAP_KEY] || {};
  delete map[notifId];
  await chrome.storage.local.set({ [NOTIF_MAP_KEY]: map });
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
