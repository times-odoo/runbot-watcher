/**
 * Pure functions to summarize batch/build data into a status descriptor.
 *
 * All functions are side-effect-free and unit-testable.
 *
 * Status shape:
 * {
 *   state: 'pending'|'testing'|'waiting'|'running'|'done',
 *   result: 'ok'|'warn'|'ko'|'skipped'|'killed'|null,
 *   errors: Array<{ buildId, trigger?, message, knownError }>,
 * }
 */

/**
 * Summarize a single build (already fetched with depth=1, logs=errors).
 * @param {Object} build
 * @returns {{ state: string, result: string|null, errors: Array }}
 */
export function evaluateBuild(build) {
  const state = build.global_state || build.local_state || 'pending';
  const result = build.global_result || build.local_result || null;
  const errors = extractBuildErrors(build);
  return { state, result, errors };
}

/**
 * Summarize a batch (already fetched with depth=1, logs=errors).
 * Considers all slot builds and batch-level logs.
 * @param {Object} batch
 * @returns {{ state: string, result: string|null, errors: Array, allDone: boolean }}
 */
export function evaluateBatch(batch) {
  const errors = [];

  // Batch-level logs
  if (Array.isArray(batch.logs)) {
    for (const log of batch.logs) {
      if (isErrorLog(log)) {
        errors.push({
          buildId: null,
          trigger: null,
          message: log.message || log.line || String(log),
          knownError: log.known_error || false,
        });
      }
    }
  }

  // Inspect slot builds
  const builds = getSlotBuilds(batch);
  let worstResult = null;
  let allDone = true;
  let anyRunning = false;

  for (const { build, trigger } of builds) {
    const globalState = build.global_state || build.local_state || 'pending';
    const globalResult = build.global_result || build.local_result || null;

    if (globalState !== 'done') {
      allDone = false;
    }
    if (['testing', 'running', 'waiting'].includes(globalState)) {
      anyRunning = true;
    }

    worstResult = mergeResult(worstResult, globalResult);

    // Collect errors from builds
    const buildErrors = extractBuildErrors(build, trigger);
    errors.push(...buildErrors);
  }

  // If no builds exist yet (all slots have build: false), not done yet
  if (builds.length === 0) {
    allDone = false;
  }

  // Determine overall state
  let state;
  if (allDone) {
    state = 'done';
  } else if (anyRunning) {
    state = 'running';
  } else {
    state = batch.state || 'pending';
  }

  // Use batch-level result if available, or computed worst
  const result = allDone ? (worstResult || batch.result || 'ok') : (worstResult || batch.result || null);

  return { state, result, errors, allDone };
}

/**
 * Extract error info from a build and its children.
 */
function extractBuildErrors(build, triggerName) {
  const errors = [];
  const trigger = triggerName || build.trigger || build.config || null;

  // Check if the build itself has a ko result
  const globalResult = build.global_result || build.local_result || null;
  const localResult = build.local_result || null;

  if (globalResult === 'ko' || localResult === 'ko') {
    // Find the first error log message
    const firstError = findFirstErrorLog(build);
    errors.push({
      buildId: build.id,
      trigger,
      message: firstError?.message || `Build ${build.id} failed`,
      knownError: firstError?.knownError || false,
    });
  }

  // Check build logs for ERROR/CRITICAL lines even if result isn't ko yet
  if (Array.isArray(build.logs)) {
    for (const log of build.logs) {
      if (isErrorLog(log) && globalResult !== 'ko' && localResult !== 'ko') {
        errors.push({
          buildId: build.id,
          trigger,
          message: log.message || log.line || String(log),
          knownError: log.known_error || false,
        });
      }
    }
  }

  // Recurse into children
  if (Array.isArray(build.children)) {
    for (const child of build.children) {
      errors.push(...extractBuildErrors(child, trigger));
    }
  }

  return errors;
}

/**
 * Find the first ERROR/CRITICAL log line in a build.
 */
function findFirstErrorLog(build) {
  if (!Array.isArray(build.logs)) return null;
  for (const log of build.logs) {
    if (isErrorLog(log)) {
      return {
        message: log.message || log.line || String(log),
        knownError: log.known_error || false,
      };
    }
  }
  // Check children
  if (Array.isArray(build.children)) {
    for (const child of build.children) {
      const found = findFirstErrorLog(child);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Check if a log entry is an error (WARNING, ERROR or CRITICAL level).
 */
function isErrorLog(log) {
  if (!log) return false;
  const level = (log.level || '').toUpperCase();
  return level === 'ERROR' || level === 'CRITICAL';
}

/**
 * Get all slot builds from a batch. Returns array of { build, trigger }.
 * Handles the case where build is false (slot not yet created).
 */
export function getSlotBuilds(batch) {
  if (!Array.isArray(batch.slots)) return [];
  const result = [];
  for (const slot of batch.slots) {
    if (slot.build && typeof slot.build === 'object') {
      result.push({ build: slot.build, trigger: slot.trigger || null });
    }
    // slot.build === false means no build created yet, skip
  }
  return result;
}

/**
 * Find the latest batch id from a bundle response.
 * Batches may be ids (numbers) or objects with an .id field.
 * Returns the highest id found, or null.
 */
export function findLatestBatchId(bundle) {
  // First check last_batch_id if available
  if (bundle.last_batch_id) {
    return String(bundle.last_batch_id);
  }

  if (!Array.isArray(bundle.batches) || bundle.batches.length === 0) {
    return null;
  }

  let maxId = -1;
  for (const batch of bundle.batches) {
    const id = typeof batch === 'object' ? (batch.id || 0) : (Number(batch) || 0);
    if (id > maxId) maxId = id;
  }

  return maxId > 0 ? String(maxId) : null;
}

/**
 * Merge two results, keeping the worst one.
 * Priority: ko > warn > killed > skipped > ok > null
 */
const RESULT_SEVERITY = { ko: 5, warn: 4, killed: 3, skipped: 2, ok: 1 };

export function mergeResult(a, b) {
  const sevA = RESULT_SEVERITY[a] || 0;
  const sevB = RESULT_SEVERITY[b] || 0;
  if (sevA >= sevB) return a;
  return b;
}

/**
 * Check if a bundle/branch name represents a forward-port (ends with -fw).
 * Accepts a string (branch name or label) or a watch item object.
 * @param {string|Object} target
 * @returns {boolean}
 */
export function isForwardPort(target) {
  if (!target) return false;
  if (typeof target === 'string') {
    return /-fw(\s*#\d+)?$/i.test(target.trim());
  }
  const label = typeof target.label === 'string' ? target.label.trim() : '';
  const id = typeof target.id === 'string' ? target.id.trim() : '';
  return /-fw(\s*#\d+)?$/i.test(label) || /-fw$/i.test(id);
}

/**
 * Format a summary of failed builds from a status object.
 * Returns null if no errors/failures.
 * If 1 build failed: "Failed: <Build 1>"
 * If 2 builds failed: "Failed: <Build 1>, <Build 2>"
 * If > 2 builds failed: "Failed: <Build 1>, <Build 2>... (<N> builds failed)"
 *
 * @param {Object} status
 * @returns {{ text: string, tooltip: string } | null}
 */
export function formatFailedBuilds(status) {
  if (!status) return null;
  const isError = status.result === 'ko' || (Array.isArray(status.errors) && status.errors.length > 0);
  if (!isError) return null;

  const failedMap = new Map();

  if (Array.isArray(status.errors)) {
    for (const err of status.errors) {
      const key = (err.trigger ? `trigger:${err.trigger}` : `build:${err.buildId}`) || 'unknown';
      if (!failedMap.has(key)) {
        const name = err.trigger || (err.buildId ? `Build #${err.buildId}` : 'Unknown build');
        failedMap.set(key, { name, id: err.buildId, trigger: err.trigger });
      }
    }
  }

  const failedList = Array.from(failedMap.values());

  if (failedList.length === 0) {
    if (status.result === 'ko') {
      return { text: 'Failed', tooltip: 'Build/batch failed' };
    }
    return null;
  }

  const tooltipList = failedList.map(f => {
    if (f.trigger && f.id) return `${f.trigger} (#${f.id})`;
    return f.name;
  });
  const tooltip = `Failed: ${tooltipList.join(', ')}`;

  let text = '';
  if (failedList.length === 1) {
    text = `Failed: ${failedList[0].name}`;
  } else if (failedList.length === 2) {
    text = `Failed: ${failedList[0].name}, ${failedList[1].name}`;
  } else {
    text = `Failed: ${failedList[0].name}, ${failedList[1].name}... (${failedList.length} builds failed)`;
  }

  return { text, tooltip };
}

/**
 * Determine a display status string for the popup badge.
 */
export function statusDisplay(status) {
  if (!status) return { text: 'pending', cssClass: 'status-pending' };
  if (status.state === 'done') {
    if (status.result === 'ko') return { text: 'ko', cssClass: 'status-ko' };
    if (status.result === 'warn') return { text: 'warn', cssClass: 'status-warn' };
    if (status.result === 'ok') return { text: 'ok', cssClass: 'status-ok' };
    return { text: status.result || 'done', cssClass: 'status-done' };
  }
  if (status.state === 'running' || status.state === 'testing') {
    return { text: 'running', cssClass: 'status-running' };
  }
  return { text: status.state || 'pending', cssClass: 'status-pending' };
}
