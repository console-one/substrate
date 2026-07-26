/**
 * v2/api.ts — the wrapped client API surface (`OfficeSpaceAPI`) on the
 * v2 kernel — the browser shell's one dependency (deletion-ledger
 * stage 4 port of sequenceutils/transport's api.ts).
 *
 * Honesty notes on the read surfaces:
 *   · `recent()` reads the kernel's own block log (append-only) —
 *     newest applied non-internal blocks, with author and path.
 *   · `feed()` ranks value-bearing cells by their ACCESS POSTERIOR
 *     (accessScore — observed reads, Beta-backed), descending. Real
 *     evidence, not an authored score. The full relevance-elected
 *     feed is the elected-frame concern preset (stage 3); this is its
 *     posterior-ranked precursor, same inputs.
 *   · `render()` without a reader name hoists the full state; with a
 *     name it renders that declared reader contract (hoistForReader).
 */

import {
  hoist, hoistForReader, accessScore, createType,
} from '@console-one/sequence/v2';
import { OfficeSpaceClient, type ClientEvent } from './client';

export interface PanelInfo {
  id: string;
  title: string;
  position: string;
  order: number;
  render: string;
  reader?: string;
}

export interface OfficeSpaceAPI {
  readonly status: { connected: boolean; user: string; serverUrl: string };
  on(cb: (ev: ClientEvent) => void): () => void;
  mount(ftText: string, opts?: { mutable?: boolean }): void;
  mountBlock(opts: {
    entries: Array<{ path: string; value: unknown }>;
    where?: Array<{ op: string; args: unknown[] }>;
  }): void;
  declareType(path: string, kind: string): { ok: boolean; reason?: string };
  render(readerName?: string): string;
  feed(scopePrefix?: string): Array<{ path: string; score: number; value: unknown }>;
  planned(scopePrefix?: string): Array<{ path: string; fireAt: number; msUntil: number }>;
  recent(scopePrefix?: string): Array<{ path: string; author?: string; time: number }>;
  get(path: string): unknown;
  keys(prefix?: string): string[];
  gaps(): Array<{ path: string; tools: string[] }>;
  panels: {
    register(renderId: string, fn: (el: unknown, api: OfficeSpaceAPI) => void): void;
    resolve(renderId: string): ((el: unknown, api: OfficeSpaceAPI) => void) | undefined;
    list(): PanelInfo[];
  };
  shutdown(): void;
}

export function wrapClient(
  client: OfficeSpaceClient,
  config: { user: string; serverUrl: string },
): OfficeSpaceAPI {
  const renderFns = new Map<string, (el: unknown, api: OfficeSpaceAPI) => void>();

  const api: OfficeSpaceAPI = {
    get status() {
      return { connected: client.isConnected, user: config.user, serverUrl: config.serverUrl };
    },
    on: (cb) => client.on(cb),
    mount: (ftText) => { void client.mount(ftText); },
    mountBlock: (opts) => { client.mountBlock(opts); },
    declareType(path, kind) {
      const r = client.seq.insert({ path, type: createType(kind as never, []) });
      return r.suspended ? { ok: false, reason: 'suspended at admission' } : { ok: true };
    },
    render(readerName) {
      if (readerName) return hoistForReader(client.seq, readerName).text;
      return hoist(client.seq, { depth: 10 }).text;
    },
    feed(scopePrefix) {
      const out: Array<{ path: string; score: number; value: unknown }> = [];
      for (const cell of client.seq.cells()) {
        const p = cell.path;
        if (!p || p.startsWith('_') || cell.value === undefined) continue;
        if (scopePrefix && p !== scopePrefix && !p.startsWith(scopePrefix + '.')) continue;
        out.push({ path: p, score: accessScore(client.seq, p), value: cell.value });
      }
      out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      return out;
    },
    planned: (scopePrefix) => client.planned({ scopePrefix }),
    recent(scopePrefix) {
      const out: Array<{ path: string; author?: string; time: number; seq: number }> = [];
      for (const cell of client.seq.cells()) {
        const p = cell.path;
        if (!p || p.startsWith('_')) continue;
        if (scopePrefix && p !== scopePrefix && !p.startsWith(scopePrefix + '.')) continue;
        for (const b of cell.blocks) {
          if (b.status !== 'applied') continue;
          out.push({ path: p, author: b.author, time: b.time, seq: b.seq });
        }
      }
      out.sort((a, b) => b.seq - a.seq);
      return out.map(({ path, author, time }) => ({ path, author, time }));
    },
    get: (path) => client.get(path),
    keys: (prefix) => client.keys(prefix),
    gaps: () => client.gaps(),
    panels: {
      register(renderId, fn) { renderFns.set(renderId, fn); },
      resolve(renderId) { return renderFns.get(renderId); },
      list() {
        const out: PanelInfo[] = [];
        for (const id of client.seq.keys('_panels')) {
          const g = (k: string): unknown => client.seq.getCell(`_panels.${id}.${k}`)?.value;
          out.push({
            id,
            title: String(g('title') ?? id),
            position: String(g('position') ?? 'main'),
            order: typeof g('order') === 'number' ? (g('order') as number) : 0,
            render: String(g('render') ?? id),
            ...(typeof g('reader') === 'string' ? { reader: g('reader') as string } : {}),
          });
        }
        const bucket = (p: string): number =>
          ['sidebar', 'main', 'main-top', 'main-bottom', 'rail-top', 'rail-bottom'].indexOf(p);
        out.sort((a, b) =>
          bucket(a.position) - bucket(b.position) || a.order - b.order || a.id.localeCompare(b.id));
        return out;
      },
    },
    shutdown: () => client.shutdown(),
  };
  return api;
}

/** Construct + boot + wrap in one call (the factory external UIs use).
 *  `onEvent` attaches BEFORE boot so the first 'connected' event —
 *  fired synchronously on open — is never lost. */
export async function createOfficeSpaceClient(
  config: ConstructorParameters<typeof OfficeSpaceClient>[0] & { user: string; serverUrl: string },
  onEvent?: (ev: ClientEvent) => void,
): Promise<OfficeSpaceAPI> {
  const client = new OfficeSpaceClient(config);
  if (onEvent) client.on(onEvent);
  await client.boot();
  return wrapClient(client, { user: config.user, serverUrl: config.serverUrl });
}
