/**
 * kit.ts — keys, kits and the measured capability call path
 * (beats 3, 4, 7, 9, 10 of the storyboard walk).
 *
 * · storeKey        — the secret lands at an ALIAS path; everything
 *                     downstream carries the alias, never the value.
 * · createKit       — a capability is a NARROWED re-mount of connector
 *                     tools: key alias late-bound into each call,
 *                     excluded verbs mounted as `never` types plus a
 *                     queryable `_excluded.<verb>` fact — the retained
 *                     constraint the kernel refuses forever.
 * · the impl wrapper — THE learning loop's office half (beat 9): every
 *                     call through a capability tool is really timed
 *                     (performance.now) and conjugate-updates the
 *                     `_prior.reliability` (beta) and `_prior.latency`
 *                     (gamma→exponential) posteriors the next vend
 *                     reads. Every call also appends a `_usage.*` fact
 *                     (beat 10). Nothing here authors a number: priors
 *                     move only when a real call moved them.
 * · hydrate         — beat 7: the offer derives from the manifest's
 *                     beat-6 metadata (hydratable apis only); rows land
 *                     in real local SQL tables; the extent is a fact.
 */

import Database from 'better-sqlite3';
import type { Sequence } from '@console-one/sequence/v2';
import { conjugateUpdate } from '@console-one/sequence/v2';

// ── beat 3: the key ──────────────────────────────────────────────────

/** Store a secret at `_keys.<alias>`. The alias is what circulates. */
export function storeKey(seq: Sequence, alias: string, value: string): string {
  const path = `_keys.${alias}`;
  seq.insert({ path, value });
  return path;
}

// ── beats 9/10: the measured call path ───────────────────────────────

type LatencyPrior = {
  family: 'exponential';
  /** Posterior-mean rate (per ms) — what vend emits as ~survival(exp, r). */
  rate: number;
  gamma: { shape?: number; rate?: number };
  samples: number;
};

/** Wrap a raw impl so every call OBSERVES: real duration → gamma
 *  update; success/failure → beta update; one `_usage` fact per call.
 *  The wrapper IS the office's automatic learning loop. */
function measured(
  seq: Sequence,
  capability: string,
  toolPath: string,
  run: (args: Record<string, unknown>) => unknown,
): (args: unknown) => Promise<unknown> {
  return async (argsIn: unknown) => {
    const args = (argsIn ?? {}) as Record<string, unknown>;
    const t0 = performance.now();
    let ok = true;
    try {
      return await run(args);
    } catch (e) {
      ok = false;
      throw e;
    } finally {
      const dtMs = Math.max(performance.now() - t0, 1e-6);
      const relPath = `${toolPath}._prior.reliability`;
      const rel = (seq.get(relPath) as { alpha?: number; beta?: number } | undefined) ?? { alpha: 1, beta: 1 };
      seq.insert({ path: relPath, value: conjugateUpdate('beta', rel, ok ? 'success' : 'failure') });

      const latPath = `${toolPath}._prior.latency`;
      const prev = seq.get(latPath) as LatencyPrior | undefined;
      // Declared conjugate prior: gamma(shape=1, rate=1ms) — one
      // pseudo-observation of 1ms; posterior mean = shape/rate per ms.
      const g = conjugateUpdate('gamma', prev?.gamma ?? { shape: 1, rate: 1 }, dtMs);
      const rate = (g.shape ?? 1) / (g.rate ?? 1);
      seq.insert({
        path: latPath,
        value: {
          family: 'exponential',
          rate: Number(rate.toPrecision(3)),
          gamma: g,
          samples: (prev?.samples ?? 0) + 1,
        } satisfies LatencyPrior,
      });

      const n = seq.keys(`_usage.${capability}`).length;
      seq.insert({
        path: `_usage.${capability}.u${n}`,
        value: { tool: toolPath, at: seq.now(), ok },
      });
    }
  };
}

// ── beat 4: the kit ──────────────────────────────────────────────────

export type KitSpec = {
  capability: string;
  connector: string;
  /** Alias path from storeKey — the VALUE is read only inside the call. */
  keyAlias: string;
  /** Verbs filtered OUT of the capability — the retained constraint. */
  exclude: string[];
  excludeReason?: string;
};

export type KitResult = { tools: string[]; excluded: string[] };

export function createKit(seq: Sequence, spec: KitSpec): KitResult {
  const tools: string[] = [];
  const excluded: string[] = [];
  seq.insert({
    path: `_kits.${spec.capability}`,
    value: {
      connector: spec.connector,
      keyAlias: spec.keyAlias,
      excluded: spec.exclude.join(' '),
    },
  });
  for (const api of seq.keys(`_connectors.${spec.connector}.apis`)) {
    const srcPath = `${spec.connector}.${api}`;
    const dstPath = `${spec.capability}.${api}`;
    const srcType = seq.rawTypeAt(srcPath);
    if (srcType?.kind !== 'fn') continue;

    if (spec.exclude.includes(api)) {
      // The RETAINED constraint, the v2 way: an ADMISSION RULE at the
      // verb's scope whose guard never holds — every future attempt to
      // mount a tool, a value, anything at this path is refused by the
      // kernel itself, forever. (A bare `never` type would itself be
      // refused at admission as a contradiction — the rule IS the
      // durable form.) The reason rides as a queryable fact.
      seq.insert({
        path: `_rules.exclude_${spec.capability}_${api}`,
        rules: [{
          id: `exclude_${spec.capability}_${api}`,
          phase: 'admission',
          scope: dstPath,
          when: { op: 'eq', args: [0, 1] }, // never holds → always refuse
        }],
      });
      seq.insert({
        path: `${spec.capability}._excluded.${api}`,
        value: spec.excludeReason ?? `filtered at kit creation`,
      });
      excluded.push(api);
      continue;
    }

    // The type carries over; the DESCRIPTION does not — describing the
    // capability is the owner's authoring act (beat 5), and v2 facts
    // narrow rather than overwrite, so pre-filling here would make the
    // owner's later description a refused conflict.
    seq.insert({ path: dstPath, type: srcType });

    // Late-bound alias: the key VALUE is read per call, inside the
    // impl, and handed only to the transport — it never rides on a
    // document, a type, or a usage fact.
    const raw = seq.impls.get(srcPath);
    if (!raw) continue;
    const wrapped = measured(seq, spec.capability, dstPath, (args) => {
      const key = seq.get(spec.keyAlias);
      if (typeof key !== 'string') throw new Error(`key alias ${spec.keyAlias} is not filled`);
      return raw({ ...args, _auth: key });
    });
    // The wrapper observes; the kernel's session call path must stand
    // down (observes marker) — one real observation never counts twice.
    (wrapped as { observes?: boolean }).observes = true;
    seq.impls.set(dstPath, wrapped);
    tools.push(dstPath);
  }
  return { tools, excluded };
}

// ── beat 7: hydration ────────────────────────────────────────────────

export type HydrationOffer = { api: string; ttlMs: number };

/** The offer DERIVES from beat-6 manifest metadata: only hydratable
 *  apis are offered — no metadata, no offer. */
export function offerHydration(seq: Sequence, connector: string): HydrationOffer[] {
  const out: HydrationOffer[] = [];
  for (const api of seq.keys(`_connectors.${connector}.apis`)) {
    const meta = seq.get(`_connectors.${connector}.apis.${api}`) as
      { hydratable?: boolean; ttlMs?: number } | undefined;
    if (meta?.hydratable) out.push({ api, ttlMs: meta.ttlMs ?? 0 });
  }
  return out;
}

export type HydrationResult = { emails: number; stored: number; db: InstanceType<typeof Database> };

/**
 * Hydrate through the CAPABILITY's own measured tools (search then get
 * per id) — so hydration both fills the local SQL tables AND produces
 * the first real observed posteriors the frame will annotate with.
 * The extent lands as `_hydration.<connector>` — a queryable fact.
 */
export async function hydrate(
  seq: Sequence,
  connector: string,
  capability: string,
): Promise<HydrationResult> {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY, sender TEXT, subject TEXT, body TEXT, labels TEXT
  )`);
  const searchImpl = seq.impls.get(`${capability}.search`);
  const getImpl = seq.impls.get(`${capability}.get`);
  if (!searchImpl || !getImpl) throw new Error(`capability ${capability} lacks search/get`);
  const { ids } = (await searchImpl({ q: '' })) as { ids: string[] };
  const insert = db.prepare('INSERT OR REPLACE INTO emails (id, sender, subject, body, labels) VALUES (?, ?, ?, ?, ?)');
  let stored = 0;
  for (const id of ids) {
    const m = (await getImpl({ id })) as { from: string; subject: string; body: string; labels: string };
    insert.run(id, m.from, m.subject, m.body, m.labels);
    stored++;
  }
  seq.insert({
    path: `_hydration.${connector}`,
    value: { emails: ids.length, stored, from: 'manifest-offer', heldUntil: 0 },
  });
  return { emails: ids.length, stored, db };
}
