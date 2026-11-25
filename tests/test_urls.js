/**
 * Node tests for URL parsing and result evaluation.
 *
 * Run with: node --test tests/test_urls.js
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

// We import using dynamic import and re-export to handle the module
// (the lib files use ES modules, Node handles them fine with --test)

import { parseRunbotUrl, buildBundleUrl, buildBatchUrl, buildBuildUrl, watchItemUrl } from '../lib/urls.js';

describe('parseRunbotUrl', () => {

  it('parses a bundle URL with numeric id', () => {
    const result = parseRunbotUrl('https://runbot.odoo.com/runbot/bundle/1');
    assert.deepEqual(result, {
      type: 'bundle',
      id: '1',
      url: 'https://runbot.odoo.com/runbot/bundle/1',
    });
  });

  it('parses a bundle URL with slug id', () => {
    const result = parseRunbotUrl('https://runbot.odoo.com/runbot/bundle/master-1');
    assert.deepEqual(result, {
      type: 'bundle',
      id: 'master-1',
      url: 'https://runbot.odoo.com/runbot/bundle/master-1',
    });
  });

  it('parses a batch URL', () => {
    const result = parseRunbotUrl('https://runbot.odoo.com/runbot/batch/2896698');
    assert.deepEqual(result, {
      type: 'batch',
      id: '2896698',
      url: 'https://runbot.odoo.com/runbot/batch/2896698',
    });
  });

  it('parses a build URL (contains batch pattern)', () => {
    const result = parseRunbotUrl('https://runbot.odoo.com/runbot/batch/2896698/build/133267822');
    assert.deepEqual(result, {
      type: 'build',
      id: '133267822',
      batchId: '2896698',
      url: 'https://runbot.odoo.com/runbot/batch/2896698/build/133267822',
    });
  });

  it('returns null for non-runbot URL', () => {
    assert.equal(parseRunbotUrl('https://google.com'), null);
  });

  it('returns null for empty/null input', () => {
    assert.equal(parseRunbotUrl(null), null);
    assert.equal(parseRunbotUrl(''), null);
    assert.equal(parseRunbotUrl(undefined), null);
  });

  it('build pattern takes priority over batch pattern', () => {
    // A build URL like /runbot/batch/123/build/456 should NOT match as batch
    const result = parseRunbotUrl('https://runbot.odoo.com/runbot/batch/100/build/200');
    assert.equal(result.type, 'build');
    assert.equal(result.id, '200');
    assert.equal(result.batchId, '100');
  });

  it('handles trailing slashes and query params', () => {
    const result = parseRunbotUrl('https://runbot.odoo.com/runbot/bundle/42?foo=bar');
    assert.equal(result.type, 'bundle');
    assert.equal(result.id, '42');
  });
});

describe('URL builders', () => {

  it('buildBundleUrl', () => {
    assert.equal(buildBundleUrl('master-1'), 'https://runbot.odoo.com/runbot/bundle/master-1');
    assert.equal(buildBundleUrl(1), 'https://runbot.odoo.com/runbot/bundle/1');
  });

  it('buildBatchUrl', () => {
    assert.equal(buildBatchUrl(2896698), 'https://runbot.odoo.com/runbot/batch/2896698');
  });

  it('buildBuildUrl', () => {
    assert.equal(
      buildBuildUrl(2896698, 133267822),
      'https://runbot.odoo.com/runbot/batch/2896698/build/133267822'
    );
  });

  it('watchItemUrl for each type', () => {
    assert.equal(
      watchItemUrl({ type: 'bundle', id: '1' }),
      'https://runbot.odoo.com/runbot/bundle/1'
    );
    assert.equal(
      watchItemUrl({ type: 'batch', id: '2896698' }),
      'https://runbot.odoo.com/runbot/batch/2896698'
    );
    assert.equal(
      watchItemUrl({ type: 'build', id: '133267822', batchId: '2896698' }),
      'https://runbot.odoo.com/runbot/batch/2896698/build/133267822'
    );
  });
});

describe('parseRunbotUrl host check', () => {
  it('ignores runbot-like paths on other hosts', () => {
    assert.equal(parseRunbotUrl('https://example.com/runbot/batch/100/build/200'), null);
    assert.equal(parseRunbotUrl('https://runbot.odoo.com.evil.test/runbot/batch/100'), null);
  });

  it('ignores runbot paths that are not at the root', () => {
    assert.equal(parseRunbotUrl('https://runbot.odoo.com/foo/runbot/batch/100'), null);
  });
});
