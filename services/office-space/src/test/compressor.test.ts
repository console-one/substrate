/**
 * compressor.test.ts — Narrative compressor.
 *
 * Verifies: threshold triggers compaction, cold paths are evicted
 * from projection + stored, narrative pointer is mounted, re-expansion
 * restores the paths from storage.
 *
 * Re-expressed on the v2 transport (deletion-ledger stage 4): the
 * kernel is v2, storage is the IStorage contract (real NodeStorage on
 * a temp dir), cold = lowest observed access posterior.
 */

import { Sequence, NodeStorage } from '@console-one/sequence/v2';
import { registerCompressor, expandNarrative } from '../v2/compressor.js';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('narrative compressor', () => {
  let storage: NodeStorage;

  beforeEach(() => {
    storage = new NodeStorage(mkdtempSync(join(tmpdir(), 'compressor-')));
  });

  // Use varied root prefixes so clusters are small enough for
  // budget eviction (all-or-nothing per cluster) to evict some
  // and keep others.
  function mountMany(seq: Sequence, count: number): void {
    for (let i = 0; i < count; i++) {
      const group = `g${Math.floor(i / 5)}`;
      seq.insert({ path: `${group}.k${i}`, value: `value_${i}` });
    }
  }

  function nonInternalKeyCount(seq: Sequence): number {
    return seq.cells()
      .filter((c) => c.path && !c.path.startsWith('_') && c.value !== undefined)
      .length;
  }

  async function untilNarratives(seq: Sequence, ms = 2000): Promise<string[]> {
    const t0 = Date.now();
    for (;;) {
      const keys = seq.keys('_narratives');
      if (keys.length > 0) return keys;
      if (Date.now() - t0 > ms) return keys;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  test('does not compact when below threshold', async () => {
    const seq = new Sequence(() => Date.now());
    const { compact } = registerCompressor(seq, storage, { maxKeys: 100, disableObserver: true });
    mountMany(seq, 50);
    const evicted = await compact();
    expect(evicted).toBe(0);
    expect(nonInternalKeyCount(seq)).toBe(50);
  });

  test('compacts when projection exceeds maxKeys', async () => {
    const seq = new Sequence(() => Date.now());
    const { compact } = registerCompressor(seq, storage, { maxKeys: 50, evictTarget: 20, disableObserver: true });
    mountMany(seq, 60);
    expect(nonInternalKeyCount(seq)).toBe(60);

    const evicted = await compact();
    expect(evicted).toBeGreaterThan(0);
    expect(nonInternalKeyCount(seq)).toBeLessThanOrEqual(50);
  });

  test('evicted paths are removed from projection', async () => {
    const seq = new Sequence(() => Date.now());
    registerCompressor(seq, storage, { maxKeys: 30, evictTarget: 15 });
    mountMany(seq, 40);
    await untilNarratives(seq);

    let missing = 0;
    for (let i = 0; i < 40; i++) {
      const group = `g${Math.floor(i / 5)}`;
      if (seq.getCell(`${group}.k${i}`)?.value === undefined) missing++;
    }
    expect(missing).toBeGreaterThan(0);
  });

  test('narrative pointer is mounted after compaction', async () => {
    const seq = new Sequence(() => Date.now());
    const { compact } = registerCompressor(seq, storage, { maxKeys: 30, evictTarget: 10, disableObserver: true });
    mountMany(seq, 40);
    await compact();

    const narrativeKeys = seq.keys('_narratives');
    expect(narrativeKeys.length).toBeGreaterThan(0);

    const nid = narrativeKeys[0];
    expect(seq.get(`_narratives.${nid}.size`)).toBeGreaterThan(0);
    expect(seq.get(`_narratives.${nid}.storeKey`)).toBeTruthy();
    expect(seq.get(`_narratives.${nid}.summary`)).toBeTruthy();
    expect(seq.get(`_narratives.${nid}.compactedAt`)).toBeGreaterThan(0);
  });

  test('evicted data is retrievable from storage', async () => {
    const seq = new Sequence(() => Date.now());
    const { compact } = registerCompressor(seq, storage, { maxKeys: 30, evictTarget: 10, disableObserver: true });
    mountMany(seq, 40);
    await compact();

    const nid = seq.keys('_narratives')[0];
    const storeKey = seq.get(`_narratives.${nid}.storeKey`) as string;
    const entries = JSON.parse(await storage.read(storeKey)) as unknown[];
    expect(entries.length).toBeGreaterThan(0);
  });

  test('expandNarrative restores evicted paths into the projection', async () => {
    const seq = new Sequence(() => Date.now());
    const { compact } = registerCompressor(seq, storage, { maxKeys: 30, evictTarget: 10, disableObserver: true });
    mountMany(seq, 40);
    await compact();

    const nid = seq.keys('_narratives')[0];
    const beforeExpand = nonInternalKeyCount(seq);

    const restored = await expandNarrative(seq, storage, nid);
    expect(restored).toBeGreaterThan(0);
    expect(nonInternalKeyCount(seq)).toBeGreaterThan(beforeExpand);
    expect(seq.get(`_narratives.${nid}.expandedAt`)).toBeGreaterThan(0);
  });

  test('compaction is non-reentrant (narrative mount does not re-trigger)', async () => {
    const seq = new Sequence(() => Date.now());
    registerCompressor(seq, storage, { maxKeys: 20, evictTarget: 5 });
    mountMany(seq, 30);
    const keys = await untilNarratives(seq);
    // No hang, no stack overflow — and compaction actually ran.
    expect(keys.length).toBeGreaterThan(0);
  });

  test('auto-compaction fires from observer when threshold is crossed', async () => {
    const seq = new Sequence(() => Date.now());
    registerCompressor(seq, storage, { maxKeys: 20, evictTarget: 5 });
    mountMany(seq, 30);
    const narrativeKeys = await untilNarratives(seq);
    expect(narrativeKeys.length).toBeGreaterThan(0);
  });
});
