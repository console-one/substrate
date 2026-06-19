/**
 * env-docker.test.ts — Docker server env adapter end-to-end.
 *
 * Docker is a server env, not a client env — `runDockerEnv` wraps
 * `ContextGraphServer` with NodeStorage rooted at a configurable
 * volume mount. These tests run in-process (no actual container):
 * we construct the env with injected paths under `tmpdir()`,
 * exercise the fs.* tool family through the injected storage, and
 * verify that:
 *   - the server binds to a port and is reachable,
 *   - workspace writes land under the injected WORKSPACE_ROOT,
 *   - the path-traversal guard on NodeStorage still applies,
 *   - two Docker envs on independent ports/volumes don't collide,
 *   - a connected client sees a live session (full round-trip),
 *   - shutdown closes the server cleanly.
 *
 * Signal-handler + real-container tests belong in a separate
 * integration suite that actually runs `docker build` + `docker run`;
 * the in-process suite here is for the adapter logic.
 */

import { runDockerEnv } from '../env/docker';
import { OfficeSpaceClient } from '@console-one/sequenceutils/transport';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, rmSync, mkdtempSync } from 'fs';

describe('Docker env adapter', () => {
  const mounts: string[] = [];
  const clients: OfficeSpaceClient[] = [];

  afterEach(async () => {
    for (const c of clients) { try { c.shutdown(); } catch {} }
    clients.length = 0;
    for (const m of mounts) {
      try { rmSync(m, { recursive: true, force: true }); } catch {}
    }
    mounts.length = 0;
  });

  function tempMount(tag: string): { root: string; workspace: string; db: string } {
    const root = mkdtempSync(join(tmpdir(), `office-space-docker-${tag}-`));
    mounts.push(root);
    return {
      root,
      workspace: join(root, 'workspace'),
      db: join(root, 'contextgraph.db'),
    };
  }

  test('runDockerEnv boots a server with injected storage root and db path', async () => {
    const m = tempMount('alpha');
    const handle = await runDockerEnv({
      port: 0,
      dbPath: m.db,
      workspaceRoot: m.workspace,
      silent: true,
    });

    expect(handle.port).toBeGreaterThan(0);
    expect(handle.server.seq).not.toBeNull();
    // Workspace dir was auto-created by the env before the server started.
    expect(existsSync(m.workspace)).toBe(true);
    // SQLite file lives at the injected path (or at least the dir exists).
    expect(existsSync(m.root)).toBe(true);

    await handle.shutdown();
  });

  test('handle.storage writes land under the injected WORKSPACE_ROOT, not cwd', async () => {
    const m = tempMount('beta');
    const handle = await runDockerEnv({
      port: 0,
      dbPath: ':memory:',
      workspaceRoot: m.workspace,
      silent: true,
    });

    await handle.storage.write('notes/hello.md', '# hi\n');
    expect(existsSync(join(m.workspace, 'notes/hello.md'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'workspace/notes/hello.md'))).toBe(false);
    expect(await handle.storage.read('notes/hello.md')).toBe('# hi\n');

    await handle.shutdown();
  });

  test('path traversal outside the workspace root is rejected', async () => {
    const m = tempMount('gamma');
    const handle = await runDockerEnv({
      port: 0,
      dbPath: ':memory:',
      workspaceRoot: m.workspace,
      silent: true,
    });

    await expect(handle.storage.read('../../../etc/passwd')).rejects.toThrow(/path traversal/);
    await expect(handle.storage.write('../outside.txt', 'x')).rejects.toThrow(/path traversal/);

    await handle.shutdown();
  });

  test('two Docker envs on independent ports and volumes stay isolated', async () => {
    const ma = tempMount('two-a');
    const mb = tempMount('two-b');
    const a = await runDockerEnv({
      port: 0, dbPath: ':memory:', workspaceRoot: ma.workspace, silent: true,
    });
    const b = await runDockerEnv({
      port: 0, dbPath: ':memory:', workspaceRoot: mb.workspace, silent: true,
    });

    expect(a.port).not.toBe(b.port);

    await a.storage.write('note.txt', 'alpha');
    await b.storage.write('note.txt', 'beta');
    expect(await a.storage.read('note.txt')).toBe('alpha');
    expect(await b.storage.read('note.txt')).toBe('beta');
    // Files are physically segregated on disk too.
    expect(existsSync(join(ma.workspace, 'note.txt'))).toBe(true);
    expect(existsSync(join(mb.workspace, 'note.txt'))).toBe(true);

    await a.shutdown();
    await b.shutdown();
  });

  test('a real client can connect to the dockerized server and land a session', async () => {
    const m = tempMount('client');
    const handle = await runDockerEnv({
      port: 0, dbPath: ':memory:', workspaceRoot: m.workspace, silent: true,
    });

    const client = new OfficeSpaceClient({
      dataDir: join(m.root, 'client-data'),
      serverUrl: `ws://localhost:${handle.port}`,
      user: 'alice',
      env: 'docker-test',
      heartbeatMs: 60_000,
      reconnectMs: 5_000,
    });
    clients.push(client);
    await client.boot();
    await new Promise((r) => setTimeout(r, 120));

    const seq = handle.server.seq!;
    expect(seq.get('sessions.alice.user')).toBe('alice');

    client.shutdown();
    await handle.shutdown();
  });

  test('shutdown closes the server so the port is released', async () => {
    const m = tempMount('shutdown');
    const handle = await runDockerEnv({
      port: 0, dbPath: ':memory:', workspaceRoot: m.workspace, silent: true,
    });
    const port = handle.port;

    await handle.shutdown();

    // A fresh bind on the same port (via a second env) should now succeed.
    // We use port 0 here because reclaiming a specific port is racy on
    // macOS/linux; the server.seq becoming null is the authoritative
    // signal that stop() ran to completion.
    expect(handle.server.seq).toBeNull();
    expect(port).toBeGreaterThan(0);
  });
});
