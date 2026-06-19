/**
 * compressor.test.ts — Narrative compressor.
 *
 * Verifies: threshold triggers compaction, cold paths are evicted
 * from projection + stored, narrative pointer is mounted, re-expansion
 * restores the paths from storage.
 */

import { Sequence } from '@console-one/sequence';
import { Store } from '@console-one/sequenceutils/transport';
import { registerCompressor, expandNarrative } from '@console-one/sequenceutils/transport';

describe('narrative compressor', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
    store.createPartition('_server');
  });

  afterEach(() => {
    store.close();
  });

  // Use varied root prefixes so clusters are small enough for
  // budget eviction (all-or-nothing per cluster) to evict some
  // and keep others.
  function mountMany(seq: Sequence, count: number): void {
    for (let i = 0; i < count; i++) {
      const group = `g${Math.floor(i / 5)}`;
      seq.mount('bind', `${group}.k${i}`, `value_${i}`);
    }
  }

  function nonInternalKeyCount(seq: Sequence): number {
    let count = 0;
    for (const [path] of seq.iterateValues()) {
      if (!path.startsWith('_')) count++;
    }
    return count;
  }

  test('does not compact when below threshold', () => {
    const seq = new Sequence(() => Date.now());
    const { compact } = registerCompressor(seq, store, { maxKeys: 100, disableObserver: true });
    mountMany(seq, 50);
    const evicted = compact();
    expect(evicted).toBe(0);
    expect(nonInternalKeyCount(seq)).toBe(50);
  });

  test('compacts when projection exceeds maxKeys', () => {
    const seq = new Sequence(() => Date.now());
    const { compact } = registerCompressor(seq, store, { maxKeys: 50, evictTarget: 20, disableObserver: true });
    mountMany(seq, 60);
    expect(nonInternalKeyCount(seq)).toBe(60);

    const evicted = compact();
    expect(evicted).toBeGreaterThan(0);
    expect(nonInternalKeyCount(seq)).toBeLessThanOrEqual(50);
  });

  test('evicted paths are removed from projection', () => {
    const seq = new Sequence(() => Date.now());
    registerCompressor(seq, store, { maxKeys: 30, evictTarget: 15 });
    mountMany(seq, 40);

    // Observer fires during mountMany once threshold is crossed.
    // Some paths should be gone.
    let missing = 0;
    for (let i = 0; i < 40; i++) {
      const group = `g${Math.floor(i / 5)}`;
      if (seq.get(`${group}.k${i}`) === undefined) missing++;
    }
    expect(missing).toBeGreaterThan(0);
  });

  test('narrative pointer is mounted after compaction', () => {
    const seq = new Sequence(() => Date.now());
    const { compact } = registerCompressor(seq, store, { maxKeys: 30, evictTarget: 10, disableObserver: true });
    mountMany(seq, 40);
    compact();

    const narrativeKeys = seq.keys('_narratives');
    expect(narrativeKeys.length).toBeGreaterThan(0);

    const nid = narrativeKeys[0];
    expect(seq.get(`_narratives.${nid}.size`)).toBeGreaterThan(0);
    expect(seq.get(`_narratives.${nid}.storeKey`)).toBeTruthy();
    expect(seq.get(`_narratives.${nid}.summary`)).toBeTruthy();
    expect(seq.get(`_narratives.${nid}.compactedAt`)).toBeGreaterThan(0);
  });

  test('evicted data is retrievable from storage', () => {
    const seq = new Sequence(() => Date.now());
    const { compact } = registerCompressor(seq, store, { maxKeys: 30, evictTarget: 10, disableObserver: true });
    mountMany(seq, 40);
    compact();

    const narrativeKeys = seq.keys('_narratives');
    expect(narrativeKeys.length).toBeGreaterThan(0);

    const nid = narrativeKeys[0];
    const storeKey = seq.get(`_narratives.${nid}.storeKey`) as string;
    const snapshot = store.loadSnapshot(storeKey);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.entries.length).toBeGreaterThan(0);
  });

  test('expandNarrative restores evicted paths into the projection', () => {
    const seq = new Sequence(() => Date.now());
    const { compact } = registerCompressor(seq, store, { maxKeys: 30, evictTarget: 10, disableObserver: true });
    mountMany(seq, 40);
    compact();

    const narrativeKeys = seq.keys('_narratives');
    expect(narrativeKeys.length).toBeGreaterThan(0);

    const nid = narrativeKeys[0];
    const beforeExpand = nonInternalKeyCount(seq);

    const restored = expandNarrative(seq, store, nid);
    expect(restored).toBeGreaterThan(0);

    // After expansion, more keys are visible.
    expect(nonInternalKeyCount(seq)).toBeGreaterThan(beforeExpand);

    // The narrative has an expandedAt timestamp.
    expect(seq.get(`_narratives.${nid}.expandedAt`)).toBeGreaterThan(0);
  });

  test('compaction is non-reentrant (narrative mount does not re-trigger)', () => {
    const seq = new Sequence(() => Date.now());
    // The observer fires during mountMany. The test verifies
    // that the narrative mount INSIDE compact() doesn't trigger
    // the observer to run compact() again (which would be an
    // infinite loop). If we reach the end, non-reentrance works.
    registerCompressor(seq, store, { maxKeys: 20, evictTarget: 5 });
    mountMany(seq, 30);
    // No hang, no stack overflow.
    expect(seq.keys('_narratives').length).toBeGreaterThan(0);
  });

  test('auto-compaction fires from observer when threshold is crossed', () => {
    const seq = new Sequence(() => Date.now());
    registerCompressor(seq, store, { maxKeys: 20, evictTarget: 5 });
    mountMany(seq, 30);

    // Observer fires — narrative should exist.
    const narrativeKeys = seq.keys('_narratives');
    expect(narrativeKeys.length).toBeGreaterThan(0);
  });
});
