/**
 * connector.ts — the mailbox connector AS DATA (beats 2 and 6).
 *
 * The manifest is ft text: tool declarations plus per-API TEMPORAL
 * METADATA (cacheable/hydratable, read/write throughput, TTL) as plain
 * fact binds. Installing it is receiving that document — no compiled
 * connector code. The only code involved is the generic TRANSPORT
 * BINDING step: each declared tool gets a thin impl that dispatches to
 * a transport by api name, the same way a real deployment binds
 * manifests to an HTTP transport. The transport here is the local
 * simulator, and says so.
 */

import type { Sequence } from '@console-one/sequence/v2';
import { receiveDocument } from '@console-one/sequence/v2';
import { MailboxSim } from './mailbox-sim';

/** The manifest — pure data. Beat 6 lives in the `apis.*` binds. */
export const MAILBOX_MANIFEST_FT = `
-- connector: mailbox (LOCAL SIMULATOR — labeled, not Gmail)
_connectors.mailbox.displayName = "Local Mailbox (simulator)"
_connectors.mailbox.kind = "mailbox"
_connectors.mailbox.transport = "local-sim"

-- beat 6: timewise coherence per API — metadata only, kernel-readable
_connectors.mailbox.apis.search = { cacheable: true, hydratable: true, ttlMs: 60000, readPerMin: 120, writePerMin: 0 }
_connectors.mailbox.apis.get = { cacheable: true, hydratable: true, ttlMs: 300000, readPerMin: 240, writePerMin: 0 }
_connectors.mailbox.apis.labels = { cacheable: true, hydratable: false, ttlMs: 600000, readPerMin: 60, writePerMin: 0 }
_connectors.mailbox.apis.send = { cacheable: false, hydratable: false, ttlMs: 0, readPerMin: 0, writePerMin: 30 }

mailbox.search = (q: string) -> { ids: [string] }
mailbox.search._description = "Search messages by subject/body substring."
mailbox.get = (id: string) -> { from: string, subject: string, body: string, labels: string }
mailbox.get._description = "Fetch one message by id."
mailbox.labels = () -> { labels: string }
mailbox.labels._description = "List the mailbox's labels."
mailbox.send = (to: string, subject: string, body: string) -> { ok: boolean }
mailbox.send._description = "Compose and send a message."
`;

export type ConnectorDirectoryEntry = { name: string; displayName: string; kind: string };

/** Beat 2's browse/search: the directory is just cells under
 *  `_connectors`, queryable like anything else. */
export function browseConnectors(seq: Sequence, query?: string): ConnectorDirectoryEntry[] {
  const out: ConnectorDirectoryEntry[] = [];
  for (const name of seq.keys('_connectors')) {
    const displayName = String(seq.get(`_connectors.${name}.displayName`) ?? name);
    const kind = String(seq.get(`_connectors.${name}.kind`) ?? '');
    const hay = `${name} ${displayName} ${kind}`.toLowerCase();
    if (!query || hay.includes(query.toLowerCase())) out.push({ name, displayName, kind });
  }
  return out;
}

export type InstallResult = { tools: string[]; errors: string[] };

/**
 * Install = receive the manifest document, then bind declared tools to
 * the transport. The dispatch table is DERIVED from the manifest's api
 * names — adding an api to the manifest data adds the binding; no new
 * connector code per case.
 */
export async function installMailboxConnector(
  seq: Sequence,
  sim: MailboxSim,
): Promise<InstallResult> {
  const r = await receiveDocument(seq, MAILBOX_MANIFEST_FT);
  const auth = (a: Record<string, unknown>): string | undefined =>
    typeof a._auth === 'string' ? a._auth : undefined;
  const transport: Record<string, (args: Record<string, unknown>) => unknown> = {
    search: (a) => sim.search(String(a.q ?? ''), auth(a)),
    get: (a) => sim.get(String(a.id ?? ''), auth(a)),
    labels: (a) => sim.labels(auth(a)),
    send: (a) => sim.send(String(a.to ?? ''), String(a.subject ?? ''), String(a.body ?? ''), auth(a)),
  };
  for (const api of seq.keys('_connectors.mailbox.apis')) {
    const toolPath = `mailbox.${api}`;
    if (seq.rawTypeAt(toolPath)?.kind !== 'fn') continue;
    const dispatch = transport[api];
    if (!dispatch) continue;
    seq.impls.set(toolPath, (args: unknown) => dispatch((args ?? {}) as Record<string, unknown>));
  }
  return { tools: r.tools, errors: r.errors };
}
