/**
 * writer-authority.test.ts — Session-scoped writer-authority proof.
 *
 * The server's `sessions.*` schema carries an admission law (see
 * server.ts line ~326): only the current holder of a session may
 * write to paths under `sessions.{user}.*`. This test exercises that
 * law end-to-end over real WebSocket clients — two users connect,
 * each stamps their own session, and each tries to write under the
 * other's session. The cross-user attempt must be rejected while
 * same-user writes succeed.
 *
 * This is the security primitive described in the brief: "only
 * requests signed by that env can update that sessions contents."
 * The signing step is the connection's identity path. Admission
 * enforcement is type-state, not procedural gating — the law lives
 * on the schema, fires on every mount, and the violation surfaces
 * as a no-op (the mount never applies).
 */

import { ContextGraphServer } from '../office-space-server.js';
import WebSocket from 'ws';
import { rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'writer-auth-')), 'store.db');
}

interface RawClient {
  send: (ft: string) => void;
  messages: string[];
  waitFor: (match: string, timeout?: number) => Promise<string>;
  close: () => void;
}

function createRawClient(port: number): Promise<RawClient> {
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
      waitFor: (match: string, timeout = 3000) => {
        const hit = messages.find(m => m.includes(match));
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const t = setTimeout(() => {
            const i = waiters.findIndex(w => w.resolve === res);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error(`timeout waiting for "${match}"`));
          }, timeout);
          waiters.push({ match, resolve: (s) => { clearTimeout(t); res(s); } });
        });
      },
      close: () => ws.close(),
    }));
    ws.on('error', reject);
  });
}

describe('writer-authority admission on sessions.*', () => {
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

  test('a client can write to its own session', async () => {
    // Connect as alice. The server stamps sessions.alice.holder with
    // this connection's identity path during the ws handler. Then a
    // mount to sessions.alice.note arrives — admission law sees the
    // author matches the holder, allows it.
    const alice = await createRawClient(port);
    await alice.waitFor('id.sessions', 2000);
    // Kick the session-mount path so sessions.alice exists + holder
    // is stamped to alice's identity. The server handler auto-stamps
    // on any write under sessions.*.
    alice.send('sessions.alice.user = "alice"');
    await new Promise(r => setTimeout(r, 150));

    const seq = server.seq!;
    expect(seq.get('sessions.alice.user')).toBe('alice');
    // Alice can continue writing within her session.
    alice.send('sessions.alice.note = "hello from alice"');
    await new Promise(r => setTimeout(r, 150));
    expect(seq.get('sessions.alice.note')).toBe('hello from alice');

    alice.close();
  });

  test('a client CANNOT write to another user\'s session', async () => {
    // Alice connects and claims sessions.alice.
    const alice = await createRawClient(port);
    await alice.waitFor('id.sessions', 2000);
    alice.send('sessions.alice.user = "alice"');
    alice.send('sessions.alice.note = "alice owns this"');
    await new Promise(r => setTimeout(r, 200));

    const seq = server.seq!;
    expect(seq.get('sessions.alice.note')).toBe('alice owns this');
    const aliceHolder = seq.get('sessions.alice.holder');
    expect(typeof aliceHolder).toBe('string');

    // Bob connects and tries to overwrite sessions.alice.note. His
    // author is his own identity path — NOT alice's holder. The
    // admission law rejects, and the value stays as alice wrote it.
    const bob = await createRawClient(port);
    await bob.waitFor('id.sessions', 2000);
    bob.send('sessions.alice.note = "bob trying to steal"');
    await new Promise(r => setTimeout(r, 200));

    expect(seq.get('sessions.alice.note')).toBe('alice owns this');
    // And alice's holder is unchanged — bob's attempt didn't
    // accidentally re-stamp it through the stampSessionHolder path
    // either (that path gates on the content-addressed routing
    // rules, not on admission alone).
    expect(seq.get('sessions.alice.holder')).toBe(aliceHolder);

    alice.close();
    bob.close();
  });

  test('each client can write to their own session independently', async () => {
    const alice = await createRawClient(port);
    const bob = await createRawClient(port);
    await alice.waitFor('id.sessions', 2000);
    await bob.waitFor('id.sessions', 2000);

    alice.send('sessions.alice.user = "alice"');
    bob.send('sessions.bob.user = "bob"');
    alice.send('sessions.alice.note = "alice wrote this"');
    bob.send('sessions.bob.note = "bob wrote that"');
    await new Promise(r => setTimeout(r, 250));

    const seq = server.seq!;
    expect(seq.get('sessions.alice.note')).toBe('alice wrote this');
    expect(seq.get('sessions.bob.note')).toBe('bob wrote that');

    // Cross-contamination: alice's holder is not bob's identity,
    // and vice versa.
    const aliceHolder = seq.get('sessions.alice.holder') as string;
    const bobHolder = seq.get('sessions.bob.holder') as string;
    expect(aliceHolder).not.toBe(bobHolder);

    alice.close();
    bob.close();
  });
});
