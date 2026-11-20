/**
 * Node tests for evaluate.js — pure functions for summarizing batch/build data.
 *
 * Run with: node --test tests/test_evaluate.js
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  evaluateBuild,
  evaluateBatch,
  findLatestBatchId,
  mergeResult,
  getSlotBuilds,
  statusDisplay,
  isForwardPort,
  formatFailedBuilds,
  getActiveChildren,
} from '../lib/evaluate.js';

// ── Mock data based on real API responses ────────────────────────────

const MOCK_BUILD_OK = {
  id: 133267822,
  display_name: 'Minimal check before starting other tests',
  local_state: 'done',
  global_state: 'done',
  local_result: 'ok',
  global_result: 'ok',
  logs: [],
  children: [],
  trigger: 'Minimal check',
  config: 'Minimal check',
  create_batch_id: 2896698,
};

const MOCK_BUILD_KO = {
  id: 133300001,
  display_name: 'Community Run',
  local_state: 'done',
  global_state: 'done',
  local_result: 'ko',
  global_result: 'ko',
  logs: [
    { level: 'ERROR', message: 'test_something failed: AssertionError', known_error: false },
    { level: 'ERROR', message: 'second error line', known_error: 'known-error-123' },
  ],
  children: [],
  trigger: 'Community Run',
  config: 'Community Run',
  create_batch_id: 2896700,
};

const MOCK_BUILD_RUNNING = {
  id: 133258777,
  display_name: 'Install and run',
  local_state: 'running',
  global_state: 'running',
  local_result: 'ok',
  global_result: 'ok',
  logs: [],
  children: [],
  trigger: 'Community Run',
};

const MOCK_BATCH_ALL_DONE = {
  id: 2896698,
  bundle_name: 'master',
  state: 'done',
  result: 'ok',
  logs: [],
  slots: [
    {
      trigger: 'Minimal check',
      build: { ...MOCK_BUILD_OK },
      link_type: 'created',
    },
    {
      trigger: 'Community Run',
      build: { ...MOCK_BUILD_OK, id: 133267823 },
      link_type: 'matched',
    },
  ],
};

const MOCK_BATCH_WITH_ERRORS = {
  id: 2896700,
  bundle_name: 'master',
  state: 'done',
  result: 'ko',
  logs: [],
  slots: [
    {
      trigger: 'Minimal check',
      build: { ...MOCK_BUILD_OK },
      link_type: 'created',
    },
    {
      trigger: 'Community Run',
      build: { ...MOCK_BUILD_KO },
      link_type: 'created',
    },
  ],
};

const MOCK_BATCH_RUNNING = {
  id: 2896699,
  bundle_name: 'master',
  state: 'ready',
  result: 'ok',
  logs: [],
  slots: [
    {
      trigger: 'Minimal check',
      build: { ...MOCK_BUILD_OK },
      link_type: 'created',
    },
    {
      trigger: 'Community Run',
      build: { ...MOCK_BUILD_RUNNING },
      link_type: 'created',
    },
    {
      trigger: 'Odoo LS Check',
      build: false, // not yet created
    },
  ],
};

const MOCK_BUNDLE = {
  id: 1,
  name: 'master',
  last_batch_id: 2896698,
  batches: [
    { id: 2896698, state: 'ready', result: 'ok' },
    { id: 2896325, state: 'done', result: 'ok' },
    { id: 2895965, state: 'done', result: 'ok' },
  ],
};

// ── Tests ────────────────────────────────────────────────────────────

describe('evaluateBuild', () => {

  it('returns ok for a passing build', () => {
    const result = evaluateBuild(MOCK_BUILD_OK);
    assert.equal(result.state, 'done');
    assert.equal(result.result, 'ok');
    assert.equal(result.errors.length, 0);
  });

  it('returns ko with errors for a failing build', () => {
    const result = evaluateBuild(MOCK_BUILD_KO);
    assert.equal(result.state, 'done');
    assert.equal(result.result, 'ko');
    assert.ok(result.errors.length > 0);
    assert.equal(result.errors[0].buildId, 133300001);
    assert.ok(result.errors[0].message.includes('test_something'));
  });

  it('returns running for an in-progress build', () => {
    const result = evaluateBuild(MOCK_BUILD_RUNNING);
    assert.equal(result.state, 'running');
    assert.equal(result.result, 'ok');
    assert.equal(result.errors.length, 0);
  });
});

describe('evaluateBatch', () => {

  it('reports allDone when all slot builds are done', () => {
    const result = evaluateBatch(MOCK_BATCH_ALL_DONE);
    assert.equal(result.allDone, true);
    assert.equal(result.state, 'done');
    assert.equal(result.result, 'ok');
    assert.equal(result.errors.length, 0);
  });

  it('reports errors from ko builds', () => {
    const result = evaluateBatch(MOCK_BATCH_WITH_ERRORS);
    assert.equal(result.allDone, true);
    assert.equal(result.result, 'ko');
    assert.ok(result.errors.length > 0);
    assert.equal(result.errors[0].buildId, 133300001);
  });

  it('reports running when some builds still active', () => {
    const result = evaluateBatch(MOCK_BATCH_RUNNING);
    assert.equal(result.allDone, false);
    assert.equal(result.state, 'running');
  });

  it('handles empty slots (all build: false)', () => {
    const batch = {
      id: 100, state: 'pending', result: 'ok', logs: [],
      slots: [{ trigger: 'Test', build: false }],
    };
    const result = evaluateBatch(batch);
    assert.equal(result.allDone, false);
  });

  it('handles rebuilds: ignores orphaned failed child when rebuild is running', () => {
    const batchWithRebuildRunning = {
      id: 2896761,
      state: 'ready',
      result: 'ok',
      logs: [],
      slots: [
        {
          trigger: 'Enterprise Tests',
          build: {
            id: 133269154,
            global_state: 'waiting',
            global_result: 'ok',
            children: [
              {
                id: 133270166,
                description: 'Post install tests for auth_totp -> !html_builder',
                orphan_result: true,
                local_state: 'done',
                global_state: 'done',
                local_result: 'ko',
                global_result: 'ko',
                logs: [{ level: 'ERROR', message: 'Test failed previously' }],
              },
              {
                id: 133272463,
                description: 'Post install tests for auth_totp -> !html_builder',
                orphan_result: false,
                local_state: 'testing',
                global_state: 'testing',
                local_result: 'ok',
                global_result: 'ok',
                logs: [],
              },
            ],
          },
        },
      ],
    };

    const result = evaluateBatch(batchWithRebuildRunning);
    assert.equal(result.state, 'running');
    assert.equal(result.allDone, false);
    assert.equal(result.errors.length, 0); // No error shown while rebuild is running!
    assert.notEqual(result.result, 'ko');
  });

  it('handles rebuilds: resolves to ok when rebuild passes', () => {
    const batchWithRebuildPassed = {
      id: 2896761,
      state: 'done',
      result: 'ok',
      logs: [],
      slots: [
        {
          trigger: 'Enterprise Tests',
          build: {
            id: 133269154,
            global_state: 'done',
            global_result: 'ok',
            children: [
              {
                id: 133270166,
                description: 'Post install tests for auth_totp -> !html_builder',
                orphan_result: true,
                local_state: 'done',
                global_state: 'done',
                local_result: 'ko',
                global_result: 'ko',
                logs: [{ level: 'ERROR', message: 'Test failed previously' }],
              },
              {
                id: 133272463,
                description: 'Post install tests for auth_totp -> !html_builder',
                orphan_result: false,
                local_state: 'done',
                global_state: 'done',
                local_result: 'ok',
                global_result: 'ok',
                logs: [],
              },
            ],
          },
        },
      ],
    };

    const result = evaluateBatch(batchWithRebuildPassed);
    assert.equal(result.state, 'done');
    assert.equal(result.allDone, true);
    assert.equal(result.result, 'ok');
    assert.equal(result.errors.length, 0);
  });

  it('handles rebuilds: reports error if rebuild fails again', () => {
    const batchWithRebuildFailedAgain = {
      id: 2896761,
      state: 'done',
      result: 'ko',
      logs: [],
      slots: [
        {
          trigger: 'Enterprise Tests',
          build: {
            id: 133269154,
            global_state: 'done',
            global_result: 'ko',
            children: [
              {
                id: 133270166,
                description: 'Post install tests for auth_totp -> !html_builder',
                orphan_result: true,
                local_state: 'done',
                global_state: 'done',
                local_result: 'ko',
                global_result: 'ko',
                logs: [{ level: 'ERROR', message: 'First failure' }],
              },
              {
                id: 133272463,
                description: 'Post install tests for auth_totp -> !html_builder',
                orphan_result: false,
                local_state: 'done',
                global_state: 'done',
                local_result: 'ko',
                global_result: 'ko',
                logs: [{ level: 'ERROR', message: 'Second failure on rebuild' }],
              },
            ],
          },
        },
      ],
    };

    const result = evaluateBatch(batchWithRebuildFailedAgain);
    assert.equal(result.state, 'done');
    assert.equal(result.allDone, true);
    assert.equal(result.result, 'ko');
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].buildId, 133272463);
    assert.ok(result.errors[0].message.includes('Second failure'));
  });
});

describe('findLatestBatchId', () => {

  it('returns last_batch_id if present', () => {
    assert.equal(findLatestBatchId(MOCK_BUNDLE), '2896698');
  });

  it('falls back to max id from batches array of objects', () => {
    const bundle = {
      batches: [
        { id: 100, state: 'done' },
        { id: 200, state: 'done' },
        { id: 150, state: 'done' },
      ],
    };
    assert.equal(findLatestBatchId(bundle), '200');
  });

  it('handles batches as plain ids (numbers)', () => {
    const bundle = { batches: [100, 200, 150] };
    assert.equal(findLatestBatchId(bundle), '200');
  });

  it('returns null for empty batches', () => {
    assert.equal(findLatestBatchId({ batches: [] }), null);
  });
});

describe('getSlotBuilds', () => {

  it('extracts builds from slots, skipping false', () => {
    const builds = getSlotBuilds(MOCK_BATCH_RUNNING);
    assert.equal(builds.length, 2); // Odoo LS Check has build: false
    assert.equal(builds[0].trigger, 'Minimal check');
    assert.equal(builds[1].trigger, 'Community Run');
  });

  it('returns empty for no slots', () => {
    assert.deepEqual(getSlotBuilds({}), []);
    assert.deepEqual(getSlotBuilds({ slots: [] }), []);
  });
});

describe('mergeResult', () => {

  it('ko wins over ok', () => {
    assert.equal(mergeResult('ok', 'ko'), 'ko');
    assert.equal(mergeResult('ko', 'ok'), 'ko');
  });

  it('warn wins over ok', () => {
    assert.equal(mergeResult('ok', 'warn'), 'warn');
  });

  it('ko wins over warn', () => {
    assert.equal(mergeResult('warn', 'ko'), 'ko');
  });

  it('null loses to anything', () => {
    assert.equal(mergeResult(null, 'ok'), 'ok');
    assert.equal(mergeResult('ok', null), 'ok');
  });
});

describe('statusDisplay', () => {

  it('returns ok for done/ok', () => {
    const s = statusDisplay({ state: 'done', result: 'ok', errors: [] });
    assert.equal(s.text, 'ok');
    assert.equal(s.cssClass, 'status-ok');
  });

  it('returns ko for done/ko', () => {
    const s = statusDisplay({ state: 'done', result: 'ko', errors: [] });
    assert.equal(s.text, 'ko');
    assert.equal(s.cssClass, 'status-ko');
  });

  it('returns running for running state', () => {
    const s = statusDisplay({ state: 'running', result: null, errors: [] });
    assert.equal(s.text, 'running');
    assert.equal(s.cssClass, 'status-running');
  });

  it('returns pending for null status', () => {
    const s = statusDisplay(null);
    assert.equal(s.text, 'pending');
    assert.equal(s.cssClass, 'status-pending');
  });
});

describe('isForwardPort', () => {

  it('detects -fw suffix in branch name strings', () => {
    assert.equal(isForwardPort('saas-19.4-18.0-account_portal-fw'), true);
    assert.equal(isForwardPort('18.0-account-edi-fw'), true);
    assert.equal(isForwardPort('master-fw'), true);
  });

  it('detects -fw in batch label strings with #batch suffix', () => {
    assert.equal(isForwardPort('saas-19.4-18.0-account_portal-fw #2896698'), true);
  });

  it('returns false for branches not ending with -fw', () => {
    assert.equal(isForwardPort('master-18.0-purchase'), false);
    assert.equal(isForwardPort('master'), false);
    assert.equal(isForwardPort('18.0-fw-something'), false);
    assert.equal(isForwardPort(''), false);
    assert.equal(isForwardPort(null), false);
    assert.equal(isForwardPort(undefined), false);
  });

  it('handles watch item objects', () => {
    assert.equal(isForwardPort({ label: 'saas-19.4-18.0-account_portal-fw' }), true);
    assert.equal(isForwardPort({ id: '18.0-something-fw' }), true);
    assert.equal(isForwardPort({ label: 'master', id: '123' }), false);
  });
});

describe('formatFailedBuilds', () => {

  it('returns null when no errors or not in error state', () => {
    assert.equal(formatFailedBuilds(null), null);
    assert.equal(formatFailedBuilds({ state: 'done', result: 'ok', errors: [] }), null);
    assert.equal(formatFailedBuilds({ state: 'running', result: 'ok', errors: [] }), null);
  });

  it('formats single failed build by trigger', () => {
    const status = {
      state: 'done',
      result: 'ko',
      errors: [{ buildId: 101, trigger: 'Community Run' }],
    };
    const res = formatFailedBuilds(status);
    assert.equal(res.text, 'Failed: Community Run');
    assert.equal(res.tooltip, 'Failed: Community Run (#101)');
  });

  it('formats two failed builds', () => {
    const status = {
      state: 'done',
      result: 'ko',
      errors: [
        { buildId: 101, trigger: 'Minimal check' },
        { buildId: 102, trigger: 'Community Run' },
      ],
    };
    const res = formatFailedBuilds(status);
    assert.equal(res.text, 'Failed: Minimal check, Community Run');
  });

  it('formats more than 2 failed builds with ... and count', () => {
    const status = {
      state: 'done',
      result: 'ko',
      errors: [
        { buildId: 101, trigger: 'Minimal check' },
        { buildId: 102, trigger: 'Community Run' },
        { buildId: 103, trigger: 'Enterprise Run' },
        { buildId: 104, trigger: 'Odoo LS Check' },
      ],
    };
    const res = formatFailedBuilds(status);
    assert.equal(res.text, 'Failed: Minimal check, Community Run... (4 builds failed)');
    assert.ok(res.tooltip.includes('Minimal check'));
    assert.ok(res.tooltip.includes('Odoo LS Check'));
  });

  it('deduplicates multiple errors under the same trigger', () => {
    const status = {
      state: 'done',
      result: 'ko',
      errors: [
        { buildId: 101, trigger: 'Community Run', message: 'err1' },
        { buildId: 102, trigger: 'Community Run', message: 'err2' },
      ],
    };
    const res = formatFailedBuilds(status);
    assert.equal(res.text, 'Failed: Community Run');
  });

  it('falls back to Build #id if trigger is not present', () => {
    const status = {
      state: 'done',
      result: 'ko',
      errors: [{ buildId: 133267822 }],
    };
    const res = formatFailedBuilds(status);
    assert.equal(res.text, 'Failed: Build #133267822');
  });
});

describe('getActiveChildren', () => {

  it('filters out orphaned rebuilds and selects newest build for same step', () => {
    const children = [
      { id: 133270166, description: 'Step A', orphan_result: true, local_result: 'ko' },
      { id: 133272463, description: 'Step A', orphan_result: false, local_result: 'ok' },
      { id: 133270167, description: 'Step B', orphan_result: false, local_result: 'ok' },
    ];
    const active = getActiveChildren(children);
    assert.equal(active.length, 2);
    const stepA = active.find(c => c.description === 'Step A');
    assert.equal(stepA.id, 133272463);
    assert.equal(stepA.orphan_result, false);
    const stepB = active.find(c => c.description === 'Step B');
    assert.equal(stepB.id, 133270167);
  });

  it('handles empty or non-array inputs gracefully', () => {
    assert.deepEqual(getActiveChildren(null), []);
    assert.deepEqual(getActiveChildren([]), []);
    assert.deepEqual(getActiveChildren(undefined), []);
  });
});
