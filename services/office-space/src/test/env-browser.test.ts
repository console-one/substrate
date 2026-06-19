/**
 * env-browser.test.ts — Browser env adapter.
 *
 * Runs against a real `ContextGraphServer` using an in-process
 * WebSocket stub that bridges `runBrowserEnv` to the server's
 * actual `ws` listener. This exercises:
 *
 *   - the `transport` injection point on OfficeSpaceClient,
 *   - the async persistence path through BrowserStorage,
 *   - the full session-mount / heartbeat / holder-release cycle,
 *   - `handle.storage` as a separate BrowserStorage instance
 *     scoped to the workspace prefix.
 *
 * The stub uses the EventTarget API (addEventListener) matching
 * both browser WebSocket and Node ws's DOM-compat surface. Its
 * `send` forwards directly to the real server's WebSocket
 * instance (looked up by port via a module-global registry that
 * the stub's constructor populates from `ws://host:port` URLs).
 */

import { ContextGraphServer } from '../office-space-server.js';
import { runBrowserEnv } from '../env/browser';
import { resetAllBrowserStorage } from '@console-one/sequenceutils/transport';
import { WebSocket as NodeWebSocket } from 'ws';
import type { WebSocketCtor } from '@console-one/sequenceutils/transport';

// ═══════════════════════════════════════════════════════════════════════
// In-process WebSocket: a thin wrapper that routes `send` through the
// real Node `ws` client but exposes the DOM-style addEventListener
// surface. The real ws package supports both APIs; this test uses only
// addEventListener to guarantee the browser path gets exercised.
// ═══════════════════════════════════════════════════════════════════════

function makeInProcessTransport(): WebSocketCtor {
  // Closure captures the real ws import so the test doesn't need
  // to stub the network — we rely on the fact that Node ws instances
  // already implement addEventListener as part of their EventTarget
  // compat. The BrowserEnv's client will call addEventListener on
  // this wrapper; we forward every call 1:1 to the Node instance.
  class TransportStub {
    private readonly ws: NodeWebSocket;
    constructor(url: string) {
      this.ws = new NodeWebSocket(url);
    }
    get readyState() { return this.ws.readyState; }
    send(data: string) { this.ws.send(data); }
    close() { this.ws.close(); }
    addEventListener(type: 'open' | 'message' | 'close' | 'error', handler: (ev: any) => void) {
      // Node ws implements DOM-style addEventListener with the right
      // event shapes (`{data}` on message, etc.). Forwarding preserves
      // the contract OfficeSpaceClient expects.
      (this.ws as any).addEventListener(type, handler);
    }
  }
  return TransportStub as unknown as WebSocketCtor;
}

// ═══════════════════════════════════════════════════════════════════════

describe('Browser env adapter', () => {
  let server: ContextGraphServer;
  let port: number;

  beforeEach(async () => {
    server = new ContextGraphServer({ port: 0, dbPath: ':memory:' });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    resetAllBrowserStorage();
  });

  test('runBrowserEnv boots, connects over the injected transport, and lands a session', async () => {
    const handle = await runBrowserEnv({
      user: 'alice',
      serverUrl: `ws://localhost:${port}`,
      transport: makeInProcessTransport(),
      heartbeatMs: 60_000,
      forceMemoryStorage: true,
    });

    // Let the ws round-trip land the session mount.
    await new Promise((r) => setTimeout(r, 100));

    const seq = server.seq!;
    expect(seq.get('sessions.alice.user')).toBe('alice');
    expect(seq.get('sessions.alice.env')).toBe('browser');

    await handle.shutdown();
  });

  test('stamps a routing record (sessions.alice.holder) pointing at this browser env', async () => {
    const handle = await runBrowserEnv({
      user: 'alice',
      serverUrl: `ws://localhost:${port}`,
      transport: makeInProcessTransport(),
      heartbeatMs: 60_000,
      forceMemoryStorage: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const seq = server.seq!;
    const holder = seq.get('sessions.alice.holder') as string | undefined;
    expect(typeof holder).toBe('string');
    expect(holder).toMatch(/^id\.sessions\.c_/);

    await handle.shutdown();
  });

  test('handle.storage is a BrowserStorage scoped to the workspace prefix', async () => {
    const handle = await runBrowserEnv({
      user: 'alice',
      serverUrl: `ws://localhost:${port}`,
      transport: makeInProcessTransport(),
      heartbeatMs: 60_000,
      forceMemoryStorage: true,
    });

    await handle.storage.write('notes/welcome.md', '# hello\n');
    expect(await handle.storage.read('notes/welcome.md')).toBe('# hello\n');

    // The workspace storage and the client-private persistence
    // share a database but live under different trusted prefixes,
    // so a bare `welcome.md` write in workspace doesn't collide
    // with the client's `snapshot.ft` key.
    const keys = await handle.storage.list('');
    expect(keys).toContain('notes/welcome.md');
    expect(keys).not.toContain('snapshot.ft');

    await handle.shutdown();
  });

  test('two browser envs with different users hold independent sessions', async () => {
    const alice = await runBrowserEnv({
      user: 'alice',
      serverUrl: `ws://localhost:${port}`,
      transport: makeInProcessTransport(),
      heartbeatMs: 60_000,
      forceMemoryStorage: true,
    });
    const bob = await runBrowserEnv({
      user: 'bob',
      serverUrl: `ws://localhost:${port}`,
      transport: makeInProcessTransport(),
      heartbeatMs: 60_000,
      forceMemoryStorage: true,
    });
    await new Promise((r) => setTimeout(r, 150));

    const seq = server.seq!;
    const aliceHolder = seq.get('sessions.alice.holder') as string;
    const bobHolder = seq.get('sessions.bob.holder') as string;
    expect(aliceHolder).not.toBe(bobHolder);

    await alice.shutdown();
    await bob.shutdown();
  });

  test('two browser envs sharing a dbName do NOT collide: workspace prefix scopes their data', async () => {
    // Same database name (simulating two tabs for the same user),
    // but each env has its own trusted workspace prefix. Writes
    // stay scoped — that's the discipline IndexedDB-backed envs
    // need since IndexedDB has no filesystem namespace.
    const a = await runBrowserEnv({
      user: 'alice',
      serverUrl: `ws://localhost:${port}`,
      dbName: 'shared-db',
      workspaceRoot: 'workspace-a',
      transport: makeInProcessTransport(),
      heartbeatMs: 60_000,
      forceMemoryStorage: true,
    });
    const b = await runBrowserEnv({
      user: 'alice-alt',
      serverUrl: `ws://localhost:${port}`,
      dbName: 'shared-db',
      workspaceRoot: 'workspace-b',
      transport: makeInProcessTransport(),
      heartbeatMs: 60_000,
      forceMemoryStorage: true,
    });

    await a.storage.write('note.txt', 'alpha');
    await b.storage.write('note.txt', 'beta');
    expect(await a.storage.read('note.txt')).toBe('alpha');
    expect(await b.storage.read('note.txt')).toBe('beta');

    await a.shutdown();
    await b.shutdown();
  });

  test('shutdown followed by a fresh env as the same user takes over the hold', async () => {
    const first = await runBrowserEnv({
      user: 'alice',
      serverUrl: `ws://localhost:${port}`,
      transport: makeInProcessTransport(),
      heartbeatMs: 60_000,
      forceMemoryStorage: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const seq = server.seq!;
    const firstHolder = seq.get('sessions.alice.holder') as string;
    expect(typeof firstHolder).toBe('string');

    await first.shutdown();
    await new Promise((r) => setTimeout(r, 150));
    expect(seq.get('sessions.alice.holder')).toBeUndefined();

    const second = await runBrowserEnv({
      user: 'alice',
      serverUrl: `ws://localhost:${port}`,
      transport: makeInProcessTransport(),
      heartbeatMs: 60_000,
      forceMemoryStorage: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const secondHolder = seq.get('sessions.alice.holder') as string;
    expect(typeof secondHolder).toBe('string');
    expect(secondHolder).not.toBe(firstHolder);

    await second.shutdown();
  });

  test('local client.mount is observable on the server through the injected transport', async () => {
    const handle = await runBrowserEnv({
      user: 'alice',
      serverUrl: `ws://localhost:${port}`,
      transport: makeInProcessTransport(),
      heartbeatMs: 60_000,
      forceMemoryStorage: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    // Mount some user state through the client; it should land
    // on the server via the ws pipe.
    handle.client.mount('notes.one = "first note from browser"');
    await new Promise((r) => setTimeout(r, 100));

    expect(server.seq!.get('notes.one')).toBe('first note from browser');

    await handle.shutdown();
  });
});
