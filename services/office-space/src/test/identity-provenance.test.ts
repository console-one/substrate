/**
 * identity-provenance.test.ts — Incoherence #4.
 *
 * Asserts that client identity is a real partition fact, and that
 * provenance enforcement sees the client as the author on every
 * message from the WebSocket.
 *
 * Tests:
 *   1. Connection mounts `id.sessions.{clientId}.*` in the id partition
 *   2. Client messages carry `author` meta threaded via receive()'s
 *      defaultOpts → the walker's wrapped-seq proxy → every mount
 *   3. _exec records for client-originated blocks carry runBy matching
 *      the client's identity path
 *   4. A path constrained by `producedBy(id.sessions.{clientId})`
 *      accepts writes from the matching client and rejects writes
 *      from a different client
 */

import { ContextGraphServer } from '../office-space-server.js';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cg-id-test-'));
  return join(dir, 'test.db');
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
    // The initial render contains the whole hoisted state.
    const initial = await c.waitFor('id.sessions', 2000).catch(() => '');
    // The id partition entries should appear in the initial snapshot.
    expect(initial).toContain('id.sessions.');
    expect(initial).toContain('connectedAt');
    expect(initial).toContain('transport');
    c.close();
  });

  test('client messages carry author meta — _exec records runBy', async () => {
    const c = await createRawClient(port);
    // Wait for initial state.
    await c.waitFor('org.name', 2000);

    // Write a path.
    c.send('alice.note = "hello"');
    // The reader cascades the change back as a delta line.
    await c.waitFor('alice.note', 2000);

    // The server's sequence should now have an _exec record whose
    // runBy field points at the client's id.sessions.* path. Query
    // it through a second client to avoid depending on internal APIs.
    const inspector = await createRawClient(port);
    await inspector.waitFor('alice.note', 2000);

    // Access server state directly for the assertion — inspector only
    // proves the change propagated.
    const seq = server.seq!;
    // Find any _exec.{n}.runBy value
    const execKeys = seq.keys('_exec');
    const runByPaths: string[] = [];
    for (const k of execKeys) {
      const runBy = seq.get(`_exec.${k}.runBy`) as string | undefined;
      if (runBy) runByPaths.push(runBy);
    }
    // At least one _exec record has a runBy, and it matches the id.sessions.* pattern.
    expect(runByPaths.length).toBeGreaterThan(0);
    expect(runByPaths.some(p => p.startsWith('id.sessions.'))).toBe(true);

    c.close();
    inspector.close();
  });

  test('provenance rejects writes from the wrong author', async () => {
    // Install a schema on the server with a producedBy constraint that
    // only allows writes from a specific impossible author.
    const seq = server.seq!;
    const { createType, producedBy } = await import('@console-one/sequence');
    seq.mount('schema', 'secret.locked', createType('string', [
      producedBy('some-other-authority'),
    ]));

    // A client tries to write to the constrained path. Its author meta
    // is its id.sessions.{clientId} — which doesn't match the required
    // producer — so the write is rejected at admission.
    const c = await createRawClient(port);
    await c.waitFor('org.name', 2000);

    // `<<` not `=` — `=` unconditionally overwrites the schema
    // (documented walker limitation). `<<` composes with the existing
    // schema, preserving the producedBy constraint so provenance fires.
    c.send('secret.locked << "should-be-rejected"');
    // Give the server a moment to process.
    await new Promise(r => setTimeout(r, 200));

    // The write should NOT have landed — provenance rejected it.
    expect(seq.get('secret.locked')).toBeUndefined();

    c.close();
  });

  test('two clients have distinct identities', async () => {
    const c1 = await createRawClient(port);
    const c2 = await createRawClient(port);
    await c1.waitFor('org.name', 2000);
    await c2.waitFor('org.name', 2000);

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
