/**
 * URL parsing and building utilities for runbot pages.
 *
 * Base URL: https://runbot.odoo.com
 *
 * Page patterns:
 *   Bundle: /runbot/bundle/<id>          (id can be numeric or slug like master-1)
 *   Batch:  /runbot/batch/<id>
 *   Build:  /runbot/batch/<batchId>/build/<buildId>
 */

export const RUNBOT_BASE = 'https://runbot.odoo.com';
const RUNBOT_HOST = new URL(RUNBOT_BASE).host;

// Build pattern checked first because it contains the batch pattern.
const BUILD_RE = /^\/runbot\/batch\/(\d+)\/build\/(\d+)/;
const BATCH_RE = /^\/runbot\/batch\/(\d+)/;
const BUNDLE_RE = /^\/runbot\/bundle\/([\w-]+)/;

/**
 * Parse a runbot URL into a structured descriptor.
 * @param {string} url
 * @returns {{ type: 'build'|'batch'|'bundle', id: string, batchId?: string, url: string } | null}
 */
export function parseRunbotUrl(url) {
  if (!url) return null;
  let path;
  try {
    const parsed = new URL(url);
    // The API calls always target RUNBOT_BASE, so ignore other hosts.
    if (parsed.host !== RUNBOT_HOST) return null;
    path = parsed.pathname;
  } catch {
    return null;
  }
  let match;

  // Check build first (it contains the batch pattern)
  match = path.match(BUILD_RE);
  if (match) {
    return { type: 'build', id: match[2], batchId: match[1], url };
  }

  match = path.match(BATCH_RE);
  if (match) {
    return { type: 'batch', id: match[1], url };
  }

  match = path.match(BUNDLE_RE);
  if (match) {
    return { type: 'bundle', id: match[1], url };
  }

  return null;
}

/**
 * Build a runbot page URL.
 */
export function buildBundleUrl(bundleId) {
  return `${RUNBOT_BASE}/runbot/bundle/${bundleId}`;
}

export function buildBatchUrl(batchId) {
  return `${RUNBOT_BASE}/runbot/batch/${batchId}`;
}

export function buildBuildUrl(batchId, buildId) {
  return `${RUNBOT_BASE}/runbot/batch/${batchId}/build/${buildId}`;
}

/**
 * Build the canonical URL for a watch item.
 */
export function watchItemUrl(item) {
  switch (item.type) {
    case 'bundle': return buildBundleUrl(item.id);
    case 'batch':  return buildBatchUrl(item.id);
    case 'build':  return buildBuildUrl(item.batchId, item.id);
    default:       return buildBundleUrl(item.id);
  }
}

/**
 * Build the API URL for a resource.
 */
export function apiBundleUrl(idOrName) {
  return `${RUNBOT_BASE}/runbot/api/bundle/${encodeURIComponent(idOrName)}`;
}

export function apiBatchUrl(id) {
  return `${RUNBOT_BASE}/runbot/api/batch/${id}?depth=1&logs=errors`;
}

export function apiBuildUrl(id) {
  return `${RUNBOT_BASE}/runbot/api/build/${id}?depth=1&logs=errors`;
}
