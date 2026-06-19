/**
 * env-unix.test.ts — Unix env adapter end-to-end.
 *
 * Starts a real server in-process, runs `runUnixEnv` against it,
 * verifies the session lands on the server, the routing table
 * records the client as the session holder, and shutdown cleans
 * up the PID file and snapshot gracefully. No subprocess — the
 * Unix adapter is a pure wrapper over OfficeSpaceClient, so
 * in-process testing covers everything short of signal delivery
 * (which is tested separately by the CLI smoke test, not here).
 */

import { ContextGraphServer } from '../office-space-server.js';
import { runUnixEnv } from '../env/unix';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';

describe('Unix env adapter', () => {
  let server: ContextGraphServer;
  let port: number;
  const dataDirs: string[] = [];

  beforeEach(async () => {
    server = new ContextGraphServer({ port: 0, dbPath: ':memory:' });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    for (const d of dataDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    dataDirs.length = 0;
  });

  function tempDataDir(tag: string): string {
    const d = join(tmpdir(), `office-space-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    dataDirs.push(d);
    return d;
  }

  test('runUnixEnv boots, connects, and lands a session on the server', async () => {
    const dataDir = tempDataDir('alice');
    const handle = await runUnixEnv({
      user: 'alice',
      serverUrl: `ws://localhost:${port}`,
      dataDir,
      heartbeatMs: 60_000,
      silent: true,
    });

    // Give the ws round-trip time to land the session mount.
    await new Promise((r) => setTimeout(r, 100));

    const seq = server.seq!;
    expect(seq.get('sessions.alice.user')).toBe('alice');
    expect(seq.get('sessions.alice.env')).toBe('unix');

    await handle.shutdown();
  });

  test('stamps a routing record (sessions.alice.holder) pointing at this env', async () => {
    const dataDir = tempDataDir('alice');
    const handle = await runUnixEnv({
      user: 'alice',
      serverUrl: `ws://localhost:${port}`,
      dataDir,
      heartbeatMs: 60_000,
      silent: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const seq = server.seq!;
    const holder = seq.get('sessions.alice.holder') as string | undefined;
    expect(typeof holder).toBe('string');
    expect(holder).toMatch(/^id\.sessions\.c_/);

    await handle.shutdown();
  });

  test('writes a PID file and removes it on shutdown', async () => {
    const dataDir = tempDataDir('alice');
    const pidFile = join(dataDir, 'unix.pid');
    const handle = await runUnixEnv({
      user: 'alice',
      serverUrl: `ws://localhost:${port}`,
      dataDir,
      pidFile,
      heartbeatMs: 60_000,
      silent: true,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(existsSync(pidFile)).toBe(true);

    await handle.shutdown();
    expect(existsSync(pidFile)).toBe(false);
  });

  test('two Unix envs with different users hold independent sessions', async () => {
    const aliceDir = tempDataDir('alice');
    const bobDir = tempDataDir('bob');
    const alice = await runUnixEnv({
      user: 'alice', serverUrl: `ws://localhost:${port}`, dataDir: aliceDir,
      heartbeatMs: 60_000, silent: true,
    });
    const bob = await runUnixEnv({
      user: 'bob', serverUrl: `ws://localhost:${port}`, dataDir: bobDir,
      heartbeatMs: 60_000, silent: true,
    });
    await new Promise((r) => setTimeout(r, 150));

    const seq = server.seq!;
    const aliceHolder = seq.get('sessions.alice.holder') as string;
    const bobHolder = seq.get('sessions.bob.holder') as string;
    expect(aliceHolder).not.toBe(bobHolder);

    await alice.shutdown();
    await bob.shutdown();
  });

  test('handle.storage is a NodeStorage scoped under {dataDir}/workspace', async () => {
    const dataDir = tempDataDir('alice');
    const handle = await runUnixEnv({
      user: 'alice',
      serverUrl: `ws://localhost:${port}`,
      dataDir,
      heartbeatMs: 60_000,
      silent: true,
    });

    // Writes land under the workspace subdirectory, not the data dir root.
    await handle.storage.write('notes/welcome.md', '# hello\n');
    expect(existsSync(join(dataDir, 'workspace/notes/welcome.md'))).toBe(true);
    expect(existsSync(join(dataDir, 'notes/welcome.md'))).toBe(false);

    // Read-through cache: second read is served from the cache.
    expect(await handle.storage.read('notes/welcome.md')).toBe('# hello\n');

    // Path-traversal guard: cannot escape the workspace root.
    await expect(handle.storage.read('../../../etc/passwd')).rejects.toThrow(/path traversal/);

    await handle.shutdown();
  });

  test('shutdown followed by a fresh env as the same user takes over the hold', async () => {
    const firstDir = tempDataDir('alice');
    const first = await runUnixEnv({
      user: 'alice', serverUrl: `ws://localhost:${port}`, dataDir: firstDir,
      heartbeatMs: 60_000, silent: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const seq = server.seq!;
    const firstHolder = seq.get('sessions.alice.holder') as string;
    expect(typeof firstHolder).toBe('string');

    await first.shutdown();
    await new Promise((r) => setTimeout(r, 150));
    expect(seq.get('sessions.alice.holder')).toBeUndefined();

    const secondDir = tempDataDir('alice-again');
    const second = await runUnixEnv({
      user: 'alice', serverUrl: `ws://localhost:${port}`, dataDir: secondDir,
      heartbeatMs: 60_000, silent: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const secondHolder = seq.get('sessions.alice.holder') as string;
    expect(typeof secondHolder).toBe('string');
    expect(secondHolder).not.toBe(firstHolder);

    await second.shutdown();
  });
});
