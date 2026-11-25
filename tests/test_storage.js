/**
 * Tests for lib/storage.js against an in-memory chrome.storage mock.
 *
 * Run with: node --test tests/test_storage.js
 */

import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

let store;
globalThis.chrome = {
  storage: { local: {
    get: async (key) => (key in store ? { [key]: structuredClone(store[key]) } : {}),
    set: async (obj) => Object.assign(store, structuredClone(obj)),
  } },
};

const {
  addWatch, getWatches, removeWatches, restoreWatches, renameWatch, mergePolledWatches,
} = await import('../lib/storage.js');

const keys = async () => (await getWatches()).map(w => w.key);

describe('storage', () => {
  beforeEach(async () => {
    store = {};
    for (const id of ['1', '2', '3']) await addWatch({ type: 'batch', id });
  });

  it('restores removed watches at their former positions', async () => {
    const removed = await removeWatches(['batch:1', 'batch:3']);
    assert.deepEqual(await keys(), ['batch:2']);
    await addWatch({ type: 'batch', id: '4' });
    await restoreWatches(removed);
    assert.deepEqual(await keys(), ['batch:1', 'batch:2', 'batch:3', 'batch:4']);
  });

  it('does not duplicate a watch re-added before undo', async () => {
    const removed = await removeWatches(['batch:1']);
    await addWatch({ type: 'batch', id: '1' });
    await restoreWatches(removed);
    assert.deepEqual(await keys(), ['batch:2', 'batch:3', 'batch:1']);
  });

  it('renames, and an empty name restores the runbot one', async () => {
    await renameWatch('batch:2', '  my fix  ');
    assert.equal((await getWatches())[1].customLabel, 'my fix');
    await renameWatch('batch:2', '');
    assert.equal('customLabel' in (await getWatches())[1], false);
  });

  it('keeps a rename made while a poll was running', async () => {
    const snapshot = await getWatches(); // poll starts
    await renameWatch('batch:2', 'mine'); // user renames meanwhile
    const polled = snapshot.map(w => ({ ...w, label: 'runbot name', lastCheckedAt: 'now' }));
    await mergePolledWatches(polled); // poll ends
    const w = (await getWatches())[1];
    assert.equal(w.customLabel, 'mine');
    assert.equal(w.label, 'runbot name');
  });

  it('keeps an un-rename made while a poll was running', async () => {
    await renameWatch('batch:2', 'old');
    const snapshot = await getWatches();
    await renameWatch('batch:2', '');
    await mergePolledWatches(snapshot);
    assert.equal('customLabel' in (await getWatches())[1], false);
  });

  it('does not resurrect a watch removed while a poll was running', async () => {
    const snapshot = await getWatches();
    await removeWatches(['batch:1']);
    await mergePolledWatches(snapshot);
    assert.deepEqual(await keys(), ['batch:2', 'batch:3']);
  });
});
