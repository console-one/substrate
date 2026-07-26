/**
 * v2-transport.test.ts — the stage-4 migration contract, ENFORCED on
 * the v2 transport (src/v2/server.ts + src/v2/client.ts).
 *
 * These are the product behaviors the v1 suites pinned (routing,
 * writer-authority, session tokens, broadcast, persistence, offline
 * buffering, snapshot-as-ft, planned-from-suspended), re-expressed
 * against the v2 stack. Enforcement or round-trip only — no shape
 * assertions on internals.
 */

import { ContextGraphServer } from '../v2/server.js';
import { OfficeSpaceClient } from '../v2/client.js';
import { validateSessionToken, type SessionToken } from '@console-one/sequence/v2';
import WebSocket from 'ws';
import { mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'v2-transport-'));

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

type Raw = {
  send: (ft: string) => void;
  messages: string[];
  close: () => void;
};

function rawClient(port: number): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const messages: string[] = [];
    ws.on('message', (d) => messages.push(d.toString()));
    ws.on('open', () => resolve({
      send: (ft) => ws.send(ft),
      messages,
      close: () => ws.close(),
    }));
    ws.on('error', reject);
  });
}

describe('v2 transport — the stage-4 contract', () => {
  test('session landing: first claimant becomes holder; heartbeat does not move it; welcome hoist arrives', async () => {
    const server = new ContextGraphServer({ port: 0, workspaceRoot: tmp() });
    const port = await server.start();
    try {
      const a = await rawClient(port);
      // The welcome hoist is the first message, unconditionally.
      await until(() => a.messages.length > 0);

      a.send('sessions.alice.user = "alice"\nsessions.alice.env = "test"');
      const holder = await until(() => server.seq!.getCell('sessions.alice.holder')?.value) as string;
      expect(holder).toMatch(/^id\.sessions\.c_/);

      a.send(`sessions.alice.heartbeat = ${Date.now()}`);
      await until(() => server.seq!.getCell('sessions.alice.heartbeat')?.value);
      expect(server.seq!.getCell('sessions.alice.holder')?.value).toBe(holder);
      a.close();
    } finally {
      await server.stop();
    }
  });

  test('writer authority over the wire: a second connection cannot write another user\'s session', async () => {
    const server = new ContextGraphServer({ port: 0, workspaceRoot: tmp() });
    const port = await server.start();
    try {
      const a = await rawClient(port);
      const b = await rawClient(port);
      a.send('sessions.alice.user = "alice"');
      const holder = await until(() => server.seq!.getCell('sessions.alice.holder')?.value) as string;

      b.send('sessions.alice.env = "hijack"');
      // Give the async receive a beat, then assert the write NEVER landed
      // and the holder never moved.
      await new Promise((r) => setTimeout(r, 150));
      expect(server.seq!.getCell('sessions.alice.env')?.value).toBeUndefined();
      expect(server.seq!.getCell('sessions.alice.holder')?.value).toBe(holder);

      // B's own session is untouched by the rejection.
      b.send('sessions.bob.user = "bob"');
      const bHolder = await until(() => server.seq!.getCell('sessions.bob.holder')?.value) as string;
      expect(bHolder).not.toBe(holder);
      a.close(); b.close();
    } finally {
      await server.stop();
    }
  });

  test('disconnect releases the holder; the next claimant takes over with a NEW identity', async () => {
    const server = new ContextGraphServer({ port: 0, workspaceRoot: tmp() });
    const port = await server.start();
    try {
      const a = await rawClient(port);
      a.send('sessions.alice.user = "alice"');
      const holder1 = await until(() => server.seq!.getCell('sessions.alice.holder')?.value) as string;

      a.close();
      await until(() => server.seq!.getCell('sessions.alice.holder')?.value === undefined);

      const b = await rawClient(port);
      b.send('sessions.alice.user = "alice"');
      const holder2 = await until(() => server.seq!.getCell('sessions.alice.holder')?.value) as string;
      expect(holder2).not.toBe(holder1);
      b.close();
    } finally {
      await server.stop();
    }
  });

  test('session tokens: minted on landing, validate against the configured secret, refuse tampering; rotation invalidates', async () => {
    const secret = 'stable-secret-for-this-test';
    const dir = tmp();
    const server = new ContextGraphServer({ port: 0, workspaceRoot: dir, tokenSecret: secret });
    const port = await server.start();
    let token: SessionToken;
    try {
      const a = await rawClient(port);
      a.send('sessions.alice.user = "alice"');
      token = await until(() => server.seq!.getCell('sessions.alice.token')?.value) as SessionToken;
      expect(validateSessionToken(token, secret, Date.now()).ok).toBe(true);
      const forged = { ...token, user: 'mallory' };
      const v = validateSessionToken(forged, secret, Date.now()) as { ok: boolean; reason?: string };
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('signature_mismatch');
      a.close();
    } finally {
      await server.stop();
    }

    // Same secret across restart → old token still validates; a rotated
    // secret refuses it.
    expect(validateSessionToken(token!, secret, Date.now()).ok).toBe(true);
    const rotated = validateSessionToken(token!, 'a-different-secret', Date.now());
    expect(rotated.ok).toBe(false);
  });

  test('broadcast: one client\'s write reaches the other as a receivable ft line', async () => {
    const server = new ContextGraphServer({ port: 0, workspaceRoot: tmp() });
    const port = await server.start();
    try {
      const a = await rawClient(port);
      const b = await rawClient(port);
      await until(() => a.messages.length > 0 && b.messages.length > 0);
      const bBefore = b.messages.length;

      a.send('tasks.t1.title = "write the doc"');
      const line = await until(() =>
        b.messages.slice(bBefore).find((m) => m.includes('tasks.t1.title')));
      expect(line).toContain('tasks.t1.title = "write the doc"');
      a.close(); b.close();
    } finally {
      await server.stop();
    }
  });

  test('persistence: values survive a server restart on the same dbPath; sessions do NOT lock out the next boot', async () => {
    const dir = tmp();
    const dbPath = join(dir, 'store.db');
    const s1 = new ContextGraphServer({ port: 0, workspaceRoot: dir, dbPath });
    const port1 = await s1.start();
    const a = await rawClient(port1);
    a.send('org.name = "Acme"\ntasks.t1.status = "open"\nsessions.alice.user = "alice"');
    await until(() => s1.seq!.getCell('tasks.t1.status')?.value);
    a.close();
    await s1.stop();

    const s2 = new ContextGraphServer({ port: 0, workspaceRoot: dir, dbPath });
    const port2 = await s2.start();
    try {
      expect(s2.seq!.getCell('org.name')?.value).toBe('Acme');
      expect(s2.seq!.getCell('tasks.t1.status')?.value).toBe('open');
      // Session state is connection-lived — a fresh boot must not
      // resurrect a dead holder.
      expect(s2.seq!.getCell('sessions.alice.holder')?.value).toBeUndefined();
      // And a new client can land the same user immediately.
      const b = await rawClient(port2);
      b.send('sessions.alice.user = "alice"');
      await until(() => s2.seq!.getCell('sessions.alice.holder')?.value);
      b.close();
    } finally {
      await s2.stop();
    }
  });

  test('priorSnapshot: ft text replays; an unreadable ftPath rejects start() by name', async () => {
    const server = new ContextGraphServer({
      port: 0, workspaceRoot: tmp(),
      priorSnapshot: { kind: 'ft', text: 'org.name = "Restored"\ncounter = 42' },
    });
    await server.start();
    try {
      expect(server.seq!.getCell('org.name')?.value).toBe('Restored');
      expect(server.seq!.getCell('counter')?.value).toBe(42);
    } finally {
      await server.stop();
    }

    const bad = new ContextGraphServer({
      port: 0, workspaceRoot: tmp(),
      priorSnapshot: { kind: 'ftPath', path: '/no/such/file.ft' },
    });
    await expect(bad.start()).rejects.toThrow(/priorSnapshot ftPath.*unreadable/);
  });

  test('client: offline mounts are visible locally at once, buffer through restarts, and land on connect', async () => {
    const dataDir = tmp();
    // No server yet — the client starts OFFLINE.
    const offline = new OfficeSpaceClient({
      dataDir, serverUrl: 'ws://localhost:1', user: 'alice', env: 'unix',
      reconnectMs: 100_000,
    });
    await offline.mount('notes.first = "written offline"');
    expect(offline.get('notes.first')).toBe('written offline');
    offline.shutdown();

    // The snapshot is ft text; meta.json is bookkeeping ONLY.
    const snapshot = readFileSync(join(dataDir, 'snapshot.ft'), 'utf-8');
    expect(snapshot).toContain('notes.first');
    expect(snapshot.trimStart().startsWith('{')).toBe(false);
    const meta = JSON.parse(readFileSync(join(dataDir, 'meta.json'), 'utf-8'));
    expect(Array.isArray(meta.pendingBuffer)).toBe(true);
    expect(meta.pendingBuffer.length).toBeGreaterThan(0);
    expect(JSON.stringify(meta)).not.toContain('written offline'.toUpperCase());
    expect(Object.keys(meta).sort()).toEqual(['lastServerSeq', 'pendingBuffer', 'savedAt']);

    // A real server comes up; a NEW client on the same dataDir boots,
    // reloads both state and buffer, connects, and the offline write
    // LANDS upstream.
    const server = new ContextGraphServer({ port: 0, workspaceRoot: tmp() });
    const port = await server.start();
    try {
      const online = new OfficeSpaceClient({
        dataDir, serverUrl: `ws://localhost:${port}`, user: 'alice', env: 'unix',
      });
      await online.boot();
      expect(online.get('notes.first')).toBe('written offline'); // snapshot reload
      await until(() => server.seq!.getCell('notes.first')?.value);
      expect(server.seq!.getCell('notes.first')?.value).toBe('written offline');
      await until(() => server.seq!.getCell('sessions.alice.holder')?.value);
      online.shutdown();
    } finally {
      await server.stop();
    }
  });

  test('client sync: a server-side change reaches a connected client\'s local kernel', async () => {
    const server = new ContextGraphServer({ port: 0, workspaceRoot: tmp() });
    const port = await server.start();
    try {
      const client = new OfficeSpaceClient({
        dataDir: tmp(), serverUrl: `ws://localhost:${port}`, user: 'bob', env: 'unix',
      });
      await client.boot();
      await until(() => server.seq!.getCell('sessions.bob.holder')?.value);

      server.seq!.insert({ path: 'announcements.today', value: 'standup at 10' });
      await until(() => client.get('announcements.today'));
      expect(client.get('announcements.today')).toBe('standup at 10');
      client.shutdown();
    } finally {
      await server.stop();
    }
  });

  test('planned(): scheduled facts are SUSPENDED BLOCKS, resumed by the clock — no sidecar field', async () => {
    const client = new OfficeSpaceClient({
      dataDir: tmp(), serverUrl: 'ws://localhost:1', user: 'ann', env: 'unix',
      reconnectMs: 100_000,
    });
    const fireAt = Date.now() + 60_000;
    client.mountBlock({
      entries: [{ path: 'reminders.standup', value: 'daily standup' }],
      where: [{ op: 'gt', args: ['_rt', fireAt] }],
    });
    // Suspended: not applied, but planned() sees it with its fire time.
    expect(client.get('reminders.standup')).toBeUndefined();
    const planned = client.planned();
    expect(planned).toHaveLength(1);
    expect(planned[0].path).toBe('reminders.standup');
    expect(planned[0].fireAt).toBe(fireAt);
    expect(planned[0].msUntil).toBeGreaterThan(0);

    // A literal `.fireAt` sidecar is NOT a schedule (the corrected
    // convention): it never appears in planned().
    await client.mount('other.thing = "x"\nother.thing.fireAt = 99');
    expect(client.planned()).toHaveLength(1);

    // The clock passes the bound → the block applies, planned() empties.
    client.advanceClock(fireAt + 1);
    expect(client.get('reminders.standup')).toBe('daily standup');
    expect(client.planned()).toHaveLength(0);
    client.shutdown();
  });
});
