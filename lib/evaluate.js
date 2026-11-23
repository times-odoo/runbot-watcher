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

export function isServerBuild(build, trigger) {
  if (!build) return false;
  // If it has children, it's a test runner/parent (e.g. Parallel testing), not a plain server
  if (Array.isArray(build.children) && build.children.length > 0) {
    return false;
  }
  const trig = (trigger || build.trigger || '').toLowerCase().trim();
  const conf = (build.config || '').toLowerCase().trim();
  if (trig === 'community run' || trig === 'enterprise run' || trig === 'design-themes') {
    return true;
  }
  if (trig.endsWith(' run') || conf === 'install and run' || conf === 'design theme') {
    return true;
  }
  return false;
}

/**
 * Summarize a single build (already fetched with depth=1, logs=errors).
 * @param {Object} build
 * @returns {{ state: string, result: string|null, errors: Array }}
 */
export function evaluateBuild(build) {
  if (build.orphan_result) {
    return { state: 'done', result: 'killed', errors: [] };
  }

  const activeChildren = Array.isArray(build.children) ? getActiveChildren(build.children) : [];
  let state = build.global_state || build.local_state || 'pending';
  let result = build.global_result || build.local_result || null;

  if (activeChildren.length > 0) {
    let anyChildRunning = false;
    let allChildrenDone = true;
    let worstChild = null;

    for (const child of activeChildren) {
      const cs = child.global_state || child.local_state || 'pending';
      const cr = child.global_result || child.local_result || null;
      if (cs !== 'done') allChildrenDone = false;
      if (['testing', 'running', 'waiting'].includes(cs)) anyChildRunning = true;
      worstChild = mergeResult(worstChild, cr);
    }

    if (!allChildrenDone && anyChildRunning) {
      state = 'running';
    } else if (allChildrenDone) {
      state = 'done';
    }

    if (result === 'ko' && (!worstChild || worstChild !== 'ko') && !allChildrenDone) {
      result = worstChild;
    } else if (allChildrenDone) {
      result = worstChild || result || 'ok';
    }
  }

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
  let anyTestRunning = false;
  let allTestsDone = true;

  for (const { build, trigger } of builds) {
    if (build.orphan_result) continue;

    const isServer = isServerBuild(build, trigger);
    const activeChildren = Array.isArray(build.children) ? getActiveChildren(build.children) : [];
    let buildState = build.global_state || build.local_state || 'pending';
    let buildResult = build.global_result || build.local_result || null;

    if (activeChildren.length > 0) {
      let anyChildRunning = false;
      let allChildrenDone = true;
      let worstChild = null;

      for (const child of activeChildren) {
        const cs = child.global_state || child.local_state || 'pending';
        const cr = child.global_result || child.local_result || null;
        if (cs !== 'done') allChildrenDone = false;
        if (['testing', 'running', 'waiting'].includes(cs)) anyChildRunning = true;
        worstChild = mergeResult(worstChild, cr);
      }

      if (!allChildrenDone && anyChildRunning) {
        buildState = 'running';
      } else if (allChildrenDone) {
        buildState = 'done';
      }

      if (buildResult === 'ko' && (!worstChild || worstChild !== 'ko') && !allChildrenDone) {
        buildResult = worstChild;
      } else if (allChildrenDone) {
        buildResult = worstChild || buildResult;
      }
    }

    const isRunning = ['testing', 'running', 'waiting'].includes(buildState);

    if (buildState !== 'done') {
      allDone = false;
      if (!isServer) {
        allTestsDone = false;
      }
    }

    if (isRunning) {
      anyRunning = true;
      if (!isServer) {
        anyTestRunning = true;
      }
    }

    worstResult = mergeResult(worstResult, buildResult);

    // Collect errors from builds
    const buildErrors = extractBuildErrors(build, trigger);
    errors.push(...buildErrors);
  }

  // If no slot builds exist yet (all slots have build: false), it cannot be allDone from slots
  if (builds.length === 0) {
    allDone = false;
    allTestsDone = false;
  }

  // Determine overall state and completion.
  // 1. If ANY test or child build is actively running/testing/waiting, the batch is currently running/rebuilding — NEVER done!
  // 2. If no tests are running:
  //    - If batch.state === 'done' or 'killed', or all tests have finished (allTestsDone), then the batch is done.
  //    - Otherwise, if any build or batch itself is in running/testing/ready, state is 'running'.
  let state;
  let allDoneResult = false;

  if (anyTestRunning) {
    state = 'running';
    allDoneResult = false;
  } else if (batch.state === 'running' || batch.state === 'ready' || batch.state === 'testing') {
    state = 'running';
    allDoneResult = false;
  } else if (batch.state === 'done' || batch.state === 'killed' || allTestsDone) {
    state = 'done';
    allDoneResult = true;
  } else if (anyRunning) {
    state = 'running';
    allDoneResult = false;
  } else {
    state = batch.state || 'pending';
    allDoneResult = false;
  }

  // Combined result of slot builds and batch-level result
  const combinedResult = mergeResult(worstResult, batch.result);
  let result;
  if (allDoneResult) {
    result = combinedResult || batch.result || 'ok';
  } else {
    // While running/rebuilding, only report failure if an active test has already failed
    result = worstResult === 'ko' ? 'ko' : null;
  }

  return { state, result, errors, allDone: allDoneResult };
}

/**
 * Filter and resolve active children of a build, taking rebuilds and orphaned results into account.
 * When a child build is rebuilt, the old build gets orphan_result: true and the new build has a higher ID.
 * Group by step identity (description, display_name, config) and select the active (non-orphaned, newest) build.
 *
 * @param {Array} children
 * @returns {Array} active children
 */
export function getActiveChildren(children) {
  if (!Array.isArray(children)) return [];

  const byStep = new Map();

  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    const stepKey = child.description || child.display_name || child.config || String(child.id);

    if (!byStep.has(stepKey)) {
      byStep.set(stepKey, [child]);
    } else {
      byStep.get(stepKey).push(child);
    }
  }

  const active = [];
  for (const group of byStep.values()) {
    // Prefer non-orphaned builds
    const nonOrphan = group.filter(c => !c.orphan_result);
    const pool = nonOrphan.length > 0 ? nonOrphan : group;
    // Pick the latest by id
    pool.sort((a, b) => (b.id || 0) - (a.id || 0));
    active.push(pool[0]);
  }

  return active;
}

/**
 * Extract error info from a build and its children.
 * Ignores builds or children marked with orphan_result: true or superseded by rebuilds.
 */
export function extractBuildErrors(build, triggerName) {
  const errors = [];
  if (!build || typeof build !== 'object') return errors;
  if (build.orphan_result) return errors;

  const trigger = triggerName || build.trigger || build.config || null;
  const globalResult = build.global_result || build.local_result || null;
  const localResult = build.local_result || null;

  // Active children (filtering out superseded/orphaned rebuilds)
  const activeChildren = Array.isArray(build.children) ? getActiveChildren(build.children) : [];

  // Recurse into active children first
  for (const child of activeChildren) {
    errors.push(...extractBuildErrors(child, trigger));
  }

  // If no child produced an error, but this build itself failed (leaf build or local parent error):
  if (errors.length === 0 && (globalResult === 'ko' || localResult === 'ko')) {
    if (activeChildren.length === 0 || localResult === 'ko') {
      const firstError = findFirstErrorLog(build);
      errors.push({
        buildId: build.id,
        trigger,
        message: firstError?.message || `Build ${build.id} failed`,
        knownError: firstError?.knownError || false,
      });
    }
  }

  // Check build logs for ERROR/CRITICAL lines even if result isn't ko yet
  if (errors.length === 0 && Array.isArray(build.logs)) {
    for (const log of build.logs) {
      if (isErrorLog(log) && globalResult !== 'ko' && localResult !== 'ko') {
        errors.push({
          buildId: build.id,
          trigger,
          message: log.message || log.line || String(log),
          knownError: log.known_error || false,
        });
        break;
      }
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
  // Check active children
  if (Array.isArray(build.children)) {
    const activeChildren = getActiveChildren(build.children);
    for (const child of activeChildren) {
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
  const byTrigger = new Map();

  for (const slot of batch.slots) {
    if (slot.build && typeof slot.build === 'object') {
      const trigger = slot.trigger || String(slot.build.id);
      if (!byTrigger.has(trigger)) {
        byTrigger.set(trigger, []);
      }
      byTrigger.get(trigger).push({ build: slot.build, trigger: slot.trigger || null });
    }
  }

  const result = [];
  for (const group of byTrigger.values()) {
    // If multiple slot builds exist for the same trigger:
    // 1. Prefer non-orphaned builds
    const nonOrphan = group.filter(item => !item.build.orphan_result);
    const pool = nonOrphan.length > 0 ? nonOrphan : group;
    // 2. Pick latest by build id
    pool.sort((a, b) => (b.build.id || 0) - (a.build.id || 0));
    result.push(pool[0]);
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
