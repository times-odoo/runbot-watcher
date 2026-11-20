/**
 * Fetch wrappers for the runbot JSON API.
 *
 * Every function returns the parsed JSON array or throws on network/HTTP error.
 * The caller is responsible for error handling (the polling loop catches quietly).
 */

import { apiBundleUrl, apiBatchUrl, apiBuildUrl } from './urls.js';

async function fetchJson(url) {
  const response = await fetch(url, {
    credentials: 'omit',
    headers: { 'Accept': 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

/**
 * Fetch a bundle by id or name. Returns the first element of the JSON array.
 * @param {string|number} idOrName  numeric id, slug like "master-1", or name like "master"
 * @returns {Promise<Object>}       bundle object with .batches (array of batch summaries)
 */
export async function fetchBundle(idOrName) {
  const data = await fetchJson(apiBundleUrl(idOrName));
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Bundle "${idOrName}" not found`);
  }
  // The API may return multiple bundles for a name (across projects).
  // Return the first one (project_id=1 is R&D, the main one).
  return data[0];
}

/**
 * Fetch a batch with depth=1 and logs=errors.
 * @param {number|string} id
 * @returns {Promise<Object>}
 */
export async function fetchBatch(id) {
  const data = await fetchJson(apiBatchUrl(id));
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Batch ${id} not found`);
  }
  return data[0];
}

/**
 * Fetch a build with depth=1 and logs=errors.
 * @param {number|string} id
 * @returns {Promise<Object>}
 */
export async function fetchBuild(id) {
  const data = await fetchJson(apiBuildUrl(id));
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Build ${id} not found`);
  }
  return data[0];
}
