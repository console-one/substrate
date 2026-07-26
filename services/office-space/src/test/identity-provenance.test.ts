/**
 * identity-provenance.test.ts — Incoherence #4.
 *
 * Asserts that client identity is a real partition fact, and that
 * provenance enforcement sees the client as the author on every
 * message from the WebSocket.
 *
 * Tests:
 *   1. Connection mounts `id.sessions.{clientId}.*` in the id partition
 *   2. Client messages carry `author` meta threaded via receiveDocument's
 *      `{author: identityPath}` option — proved observably through
 *      writer-authority's own admission decision over `sessions.*`
 *      (v2 judges authorship at admission time; there is no `_exec`
 *      log of it, so the v1 `runBy` assertion has no v2 counterpart —
 *      see the comment on the second test below)
 *   3. A path constrained by installWriterAuthority on a custom scope
 *      accepts writes from the matching claimant and rejects writes
 *      from a different connection
 *   4. Two connections get distinct identities
 *
 * Re-expressed on the v2 transport — deletion-ledger stage 4.
 */

import { ContextGraphServer } from '../office-space-server.js';
import { installWriterAuthority } from '@console-one/sequence/v2';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cg-id-test-'));
  return join(dir, 'test.db');
}

/** Poll until `fn` returns truthy (the transport applies async). */
async function until<T>(fn: () => T, ms = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function createRawClient(port: number): Promise<{
  send: (ft: string) => void;
  messages: string[];
  waitFor: (match: string, timeout?: number) => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const messages: string[] = [];
    const waiters: Array<{ match: string; resolve: (s: string) => void }> = [];

    ws.on('message', (raw: any) => {
      const text = raw.toString();
      messages.push(text);
      const idx = waiters.findIndex(w => text.includes(w.match));
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(text);
    });

    ws.on('open', () => resolve({
      send: (ft: string) => ws.send(ft),
      messages,
      waitFor: (match: string, timeout = 5000) => {
        const existing = messages.find(m => m.includes(match));
        if (existing) return Promise.resolve(existing);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const i = waiters.findIndex(w => w.resolve === res);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error(`timeout waiting for "${match}"`));
          }, timeout);
          waiters.push({ match, resolve: (s) => { clearTimeout(timer); res(s); } });
        });
      },
      close: () => ws.close(),
    }));
    ws.on('error', reject);
  });
}

describe('identity as partition (incoherence #4)', () => {
  let server: ContextGraphServer;
  let port: number;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb();
    server = new ContextGraphServer({ port: 0, dbPath });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    try { rmSync(dbPath, { force: true }); } catch {}
  });

  test('connection mounts id.sessions.{clientId} in the id partition', async () => {
    const c = await createRawClient(port);
    // On connect the server inserts connectedAt then transport — each
    // insert fires installCrossSequence's broadcast immediately (one
    // ft line per delta, to every connected client including this
    // brand-new one), and ONLY THEN sends the full welcome hoist. So
    // this connection's mailbox is [connectedAt line, transport line,
    // full hoist, ...] — assert over the combined transcript, not a
    // single message.
    await c.waitFor('transport', 2000);
    const combined = c.messages.join('\n');
    expect(combined).toContain('id.sessions.');
    expect(combined).toContain('connectedAt');
    expect(combined).toContain('transport');
    c.close();
  });

  test('client-authored writes carry the connection identity as author, enforced by writer authority', async () => {
    const c = await createRawClient(port);
    await c.waitFor('id.sessions', 2000);

    // Server threads `{author: identityPath}` through receiveDocument
    // for every message from this socket (v2/server.ts's ws.on('message')
    // handler). stampSessions then sets sessions.alice.holder to that
    // SAME identity — the observable proof that the connection's
    // identity, not the asserted username in the ft text, is what
    // lands as authorship.
    //
    // v1 proved this via an `_exec.{n}.runBy` record. v2 has no such
    // log: authorship is judged at admission time (the writer-
    // authority guard reading block.author), never written down as a
    // side-channel fact — so the admission DECISION over sessions.*
    // is the equivalent observable, not a record to query.
    c.send('sessions.alice.user = "alice"');
    const seq = server.seq!;
    const holder = await until(() => seq.getCell('sessions.alice.holder')?.value) as string;
    expect(holder).toMatch(/^id\.sessions\.c_/);

    // A second connection's write to the SAME session path is refused
    // — its author is its own identity, not the holder's.
    const other = await createRawClient(port);
    await other.waitFor('id.sessions', 2000);
    other.send('sessions.alice.note = "hijack"');
    await new Promise((r) => setTimeout(r, 200));

    expect(seq.get('sessions.alice.note')).toBeUndefined();
    expect(seq.getCell('sessions.alice.holder')?.value).toBe(holder);

    c.close();
    other.close();
  });

  test('provenance rejects writes from the wrong author — installWriterAuthority on a custom scope', async () => {
    // v1 proved provenance with a `producedBy` type constraint mounted
    // via `<<` (schema compose, not overwrite). v2's ft receive path
    // has no `<<` compose operator, so this is re-expressed with the
    // primitive the product's own sessions.* law is built from:
    // installWriterAuthority on an arbitrary scope. There is no
    // stampSessions-equivalent auto-holder for a scope the product
    // hasn't wired — so the test plays that role directly, exactly as
    // a real product's ServerConfig.register would.
    const secretDbPath = tmpDb();
    const secretServer = new ContextGraphServer({
      port: 0,
      dbPath: secretDbPath,
      register: (seq) => {
        installWriterAuthority(seq, { scope: 'secret', ownerSegmentIndex: 1 });
      },
    });
    const secretPort = await secretServer.start();
    try {
      const seq = secretServer.seq!;

      // First connection claims secret.thing.* by writing it — holder
      // is unset, so the write is admitted (first-claim condition).
      const first = await createRawClient(secretPort);
      await first.waitFor('id.sessions', 2000);
      first.send('secret.thing.value = "claimed"');
      await until(() => seq.get('secret.thing.value'));
      expect(seq.get('secret.thing.value')).toBe('claimed');

      // Stamp the holder to the first connection's identity — the
      // product-level bookkeeping installWriterAuthority itself
      // deliberately leaves to the host (server.ts does this for
      // sessions.* via stampSessions; there is no such wiring for
      // this synthetic scope, so the test does it explicitly).
      const [firstClientKey] = seq.keys('id.sessions');
      seq.insert({ path: 'secret.thing.holder', value: `id.sessions.${firstClientKey}` });

      // A second, different connection's write is rejected — its
      // author does not match the recorded holder.
      const second = await createRawClient(secretPort);
      await second.waitFor('id.sessions', 2000);
      second.send('secret.thing.value = "should-be-rejected"');
      await new Promise((r) => setTimeout(r, 200));

      expect(seq.get('secret.thing.value')).toBe('claimed');

      first.close();
      second.close();
    } finally {
      await secretServer.stop();
      try { rmSync(secretDbPath, { force: true }); } catch {}
    }
  });

  test('two clients have distinct identities', async () => {
    const c1 = await createRawClient(port);
    const c2 = await createRawClient(port);
    await c1.waitFor('id.sessions', 2000);
    await c2.waitFor('id.sessions', 2000);

    const seq = server.seq!;
    const sessionKeys = seq.keys('id.sessions');
    expect(sessionKeys.length).toBeGreaterThanOrEqual(2);

    // Each session has its own connectedAt.
    const timestamps = new Set<number>();
    for (const k of sessionKeys) {
      const t = seq.get(`id.sessions.${k}.connectedAt`) as number | undefined;
      if (typeof t === 'number') timestamps.add(t);
    }
    // At least 2 distinct sessions (timestamps may collide within 1ms
    // so count sessions instead of unique timestamps).
    expect(sessionKeys.length).toBeGreaterThanOrEqual(2);

    c1.close();
    c2.close();
  });
});
