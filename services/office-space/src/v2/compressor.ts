/**
 * v2/compressor.ts — narrative compressor on the v2 kernel
 * (deletion-ledger stage 4 port of sequenceutils/transport's
 * compressor; same product contract, honest v2 carriers).
 *
 * When the projection's non-internal key count exceeds the configured
 * limit, COLD CLUSTERS are serialized to storage and evicted from the
 * live projection, replaced by a narrative pointer:
 *
 *   _narratives.{id}.paths      = "tasks.old1 tasks.old2 …"
 *   _narratives.{id}.size       = 847
 *   _narratives.{id}.summary    = "847 paths (tasks)"
 *   _narratives.{id}.storeKey   = "compacted/{id}"
 *   _narratives.{id}.compactedAt
 *
 * What changed in the port:
 *   · COLD = lowest ACCESS POSTERIOR (accessScore — observed reads),
 *     not the v1 render pipeline's authored weight vector. Clusters
 *     (top-level subtrees) evict all-or-nothing, coldest first.
 *   · storage is the IStorage contract (the v2 storage surface), not
 *     the v1 sqlite Store; the serialized form is SnapshotEntry[]
 *     (types AND values), so expansion restores both.
 *   · the auto trigger is an OBSERVATION RULE (rules-as-data), not an
 *     onBlockApplied server hook; non-reentrant by guard.
 *   · eviction is the kernel's own invalidate op.
 */

import { Sequence, accessScore, type IStorage } from '@console-one/sequence/v2';
import type { SnapshotEntry } from '@console-one/sequence/v2';

export interface CompressorConfig {
  /** Max non-internal value-bearing keys before compaction fires. */
  maxKeys: number;
  /** How many paths to free per pass. Default: maxKeys * 0.2. */
  evictTarget?: number;
  /** Don't install the observation rule — tests call compact(). */
  disableObserver?: boolean;
}

export function registerCompressor(
  seq: Sequence,
  storage: IStorage,
  config: CompressorConfig,
): { compact: () => Promise<number> } {
  const maxKeys = config.maxKeys;
  const evictTarget = config.evictTarget ?? Math.floor(maxKeys * 0.2);
  let compacting = false;
  let nextNarrativeId = 1;

  const livePaths = (): string[] =>
    seq.cells()
      .filter((c) => c.path && !c.path.startsWith('_') && c.value !== undefined)
      .map((c) => c.path);

  async function compact(): Promise<number> {
    if (compacting) return 0;
    compacting = true;
    try {
      const paths = livePaths();
      if (paths.length <= maxKeys) return 0;

      // Clusters are top-level subtrees; a cluster's warmth is its
      // best member's access posterior — evict coldest, whole
      // clusters at a time, until the target headroom is freed.
      const clusters = new Map<string, string[]>();
      for (const p of paths) {
        const root = p.split('.')[0];
        (clusters.get(root) ?? clusters.set(root, []).get(root)!).push(p);
      }
      const scored = [...clusters.entries()]
        .map(([root, members]) => ({
          root,
          members,
          warmth: Math.max(...members.map((p) => accessScore(seq, p))),
        }))
        .sort((a, b) => a.warmth - b.warmth || a.root.localeCompare(b.root));

      const evicted: string[] = [];
      for (const cluster of scored) {
        if (evicted.length >= evictTarget) break;
        if (paths.length - evicted.length - cluster.members.length < 0) continue;
        evicted.push(...cluster.members);
      }
      if (evicted.length === 0) return 0;

      // Serialize types AND values, store, then evict.
      const entries: SnapshotEntry[] = [];
      for (const path of evicted) {
        const cell = seq.getCell(path);
        if (!cell) continue;
        if (cell.type !== undefined) entries.push({ path, type: cell.type });
        if (cell.value !== undefined) entries.push({ path, value: cell.value });
      }
      const narrativeId = `n_${nextNarrativeId++}_${seq.now()}`;
      const storeKey = `compacted/${narrativeId}`;
      await storage.write(storeKey, JSON.stringify(entries));

      for (const path of evicted) seq.insert({ path, op: 'invalidate' });

      const prefixes = new Set(evicted.map((p) => p.split('.')[0]));
      seq.insert({ path: `_narratives.${narrativeId}.paths`, value: evicted.join(' ') });
      seq.insert({ path: `_narratives.${narrativeId}.size`, value: evicted.length });
      seq.insert({ path: `_narratives.${narrativeId}.summary`, value: `${evicted.length} paths (${[...prefixes].join(', ')})` });
      seq.insert({ path: `_narratives.${narrativeId}.storeKey`, value: storeKey });
      seq.insert({ path: `_narratives.${narrativeId}.compactedAt`, value: seq.now() });

      return evicted.length;
    } finally {
      compacting = false;
    }
  }

  if (!config.disableObserver) {
    seq.emitters.set('compressor.threshold', () => {
      if (!compacting && livePaths().length > maxKeys) void compact();
      return [];
    });
    seq.insert({
      path: '_rules.compressor_threshold',
      rules: [{
        id: 'compressor_threshold',
        phase: 'observation',
        scope: '',
        when: { op: 'deltaKindIs', args: ['value'] },
        emit: 'compressor.threshold',
      }],
    });
  }

  return { compact };
}

/** Re-expand a narrative: load the stored entries and re-insert them.
 *  The pointer stays (append-only state); the paths are live again. */
export async function expandNarrative(
  seq: Sequence,
  storage: IStorage,
  narrativeId: string,
): Promise<number> {
  const storeKey = seq.getCell(`_narratives.${narrativeId}.storeKey`)?.value as string | undefined;
  if (!storeKey) return 0;
  let raw: string;
  try { raw = await storage.read(storeKey); } catch { return 0; }
  const entries = JSON.parse(raw) as SnapshotEntry[];
  let restored = 0;
  for (const entry of entries) {
    seq.insert(entry);
    restored++;
  }
  seq.insert({ path: `_narratives.${narrativeId}.expandedAt`, value: seq.now() });
  return restored;
}
