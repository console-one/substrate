/**
 * snapshot-recovery.test.ts — Externally-supplied snapshot recovery.
 *
 * Every server-running env adapter (plain Unix `start`, Docker,
 * and the upcoming Lambda) must be able to recover state from a
 * snapshot supplied at boot time, not just from the local sqlite.
 * That's the primitive Lambda needs for cold-start (no local
 * state; the snapshot IS the state), that Docker needs for
 * restore-from-backup, and that the Unix server needs for ops
 * handoffs between hosts.
 *
 * ServerConfig.priorSnapshot accepts three shapes:
 *   - `{ kind: 'entries', entries }`  canonical full-fidelity replay
 *   - `{ kind: 'ft', text }`          human-readable ft-text layering
 *   - `{ kind: 'ftPath', path }`      operator convenience (env var)
 *
 * This suite exercises each shape and then verifies the Docker env
 * wrapper honours both programmatic and SNAPSHOT_FT_PATH pathways.
 */

import { ContextGraphServer } from '../office-space-server.js';
import { runDockerEnv } from '../env/docker';
import type { MountEntry } from '@console-one/sequence';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('snapshot recovery', () => {
  const tmpDirs: string[] = [];

  function tempDir(tag: string): string {
    const d = mkdtempSync(join(tmpdir(), `office-space-snap-${tag}-`));
    tmpDirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

  // ═══════════════════════════════════════════════════════════════════
  // Extract-and-replay: boot server A, capture its full state, boot
  // server B with that state, verify equivalence. This is the
  // authoritative round-trip — identical to what the hot-standby and
  // Lambda cold-start flows depend on.
  // ═══════════════════════════════════════════════════════════════════

  test('entries: server B with priorSnapshot from server A has server A state', async () => {
    const serverA = new ContextGraphServer({ port: 0, dbPath: ':memory:' });
    await serverA.start();
    const seqA = serverA.seq!;

    // Mount some user-visible state on A. Using direct binds rather
    // than going through the ws path so we can observe deterministic
    // seq.head values. (tasks.* is constrained by stdlib's taskqueue
    // schema — status must be in the pending|active|done|expired
    // union — so the test uses conforming values.)
    seqA.mount('bind', 'org.name', 'Acme');
    seqA.mount('bind', 'users.alice.role', 'admin');
    seqA.mount('bind', 'users.bob.role', 'guest');
    seqA.mount('bind', 'tasks.t1.input', 'write handoff doc');
    seqA.mount('bind', 'tasks.t1.status', 'pending');

    // Capture the full projection as a MountEntry[] in the same
    // shape server.stop() persists. This IS the snapshot primitive.
    const pA = seqA.projection;
    const snapshot: MountEntry[] = [];
    for (const [path, type] of seqA.iterateTypes()) snapshot.push({ op: 'schema', path, value: type });
    for (const [path, value] of seqA.iterateValues()) snapshot.push({ op: 'bind', path, value });
    for (const [path, policy] of pA.policies) snapshot.push({ op: 'policy', path, value: policy });
    for (const path of pA.tools.keys()) snapshot.push({ op: 'tool', path, value: true });

    await serverA.stop();

    // Boot a fresh server B with the captured state injected.
    const serverB = new ContextGraphServer({
      port: 0,
      dbPath: ':memory:',
      priorSnapshot: { kind: 'entries', entries: snapshot },
    });
    await serverB.start();
    const seqB = serverB.seq!;

    expect(seqB.get('org.name')).toBe('Acme');
    expect(seqB.get('users.alice.role')).toBe('admin');
    expect(seqB.get('users.bob.role')).toBe('guest');
    expect(seqB.get('tasks.t1.input')).toBe('write handoff doc');
    expect(seqB.get('tasks.t1.status')).toBe('pending');

    await serverB.stop();
  });

  // ═══════════════════════════════════════════════════════════════════
  // Ft text layering: hand-written or externally-authored ft text
  // replays as part of the boot pipeline, on top of the bootstrap.
  // This is the operator-facing shape (human-readable, auditable).
  // ═══════════════════════════════════════════════════════════════════

  test('ft: priorSnapshot ft text is replayed on top of bootstrap', async () => {
    const ft = [
      'org.name = "RestoredCo"',
      'users.carol.role = "admin"',
      'tasks.t42.title = "seed from snapshot"',
      'tasks.t42.status = "open"',
    ].join('\n');

    const server = new ContextGraphServer({
      port: 0,
      dbPath: ':memory:',
      priorSnapshot: { kind: 'ft', text: ft },
    });
    await server.start();
    const seq = server.seq!;

    expect(seq.get('org.name')).toBe('RestoredCo');
    expect(seq.get('users.carol.role')).toBe('admin');
    expect(seq.get('tasks.t42.title')).toBe('seed from snapshot');
    expect(seq.get('tasks.t42.status')).toBe('open');

    await server.stop();
  });

  // ═══════════════════════════════════════════════════════════════════
  // ftPath convenience: the file on disk is what env-var-driven env
  // adapters read. Docker's SNAPSHOT_FT_PATH goes through this path.
  // ═══════════════════════════════════════════════════════════════════

  test('ftPath: ServerConfig reads ft text from a file on disk', async () => {
    const dir = tempDir('ftpath');
    const file = join(dir, 'restore.ft');
    writeFileSync(file, 'org.name = "FromDisk"\nusers.dave.role = "member"\n');

    const server = new ContextGraphServer({
      port: 0,
      dbPath: ':memory:',
      priorSnapshot: { kind: 'ftPath', path: file },
    });
    await server.start();
    const seq = server.seq!;

    expect(seq.get('org.name')).toBe('FromDisk');
    expect(seq.get('users.dave.role')).toBe('member');

    await server.stop();
  });

  test('ftPath: missing file throws a clear error at start()', async () => {
    const server = new ContextGraphServer({
      port: 0,
      dbPath: ':memory:',
      priorSnapshot: { kind: 'ftPath', path: '/no/such/snapshot.ft' },
    });
    await expect(server.start()).rejects.toThrow(/priorSnapshot ftPath.*unreadable/);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Docker env: the same three shapes plus the SNAPSHOT_FT_PATH env
  // var that operators will actually use when driving `docker run`.
  // The env wrapper must honour both.
  // ═══════════════════════════════════════════════════════════════════

  test('runDockerEnv: programmatic priorSnapshot is applied', async () => {
    const dir = tempDir('docker-prog');
    const workspace = join(dir, 'workspace');
    const ft = 'org.name = "DockerProgrammatic"\nusers.eve.role = "admin"\n';

    const handle = await runDockerEnv({
      port: 0,
      dbPath: ':memory:',
      workspaceRoot: workspace,
      priorSnapshot: { kind: 'ft', text: ft },
      silent: true,
    });

    const seq = handle.server.seq!;
    expect(seq.get('org.name')).toBe('DockerProgrammatic');
    expect(seq.get('users.eve.role')).toBe('admin');

    await handle.shutdown();
  });

  test('runDockerEnv: SNAPSHOT_FT_PATH env var restores from disk', async () => {
    const dir = tempDir('docker-env');
    const workspace = join(dir, 'workspace');
    const file = join(dir, 'restore.ft');
    writeFileSync(file, 'org.name = "DockerEnvVar"\ntasks.queued.status = "ready"\n');

    const savedEnvVar = process.env.SNAPSHOT_FT_PATH;
    process.env.SNAPSHOT_FT_PATH = file;
    try {
      const handle = await runDockerEnv({
        port: 0,
        dbPath: ':memory:',
        workspaceRoot: workspace,
        silent: true,
      });
      const seq = handle.server.seq!;
      expect(seq.get('org.name')).toBe('DockerEnvVar');
      expect(seq.get('tasks.queued.status')).toBe('ready');
      await handle.shutdown();
    } finally {
      if (savedEnvVar === undefined) delete process.env.SNAPSHOT_FT_PATH;
      else process.env.SNAPSHOT_FT_PATH = savedEnvVar;
    }
  });

  test('runDockerEnv: programmatic priorSnapshot overrides SNAPSHOT_FT_PATH', async () => {
    const dir = tempDir('docker-both');
    const workspace = join(dir, 'workspace');
    const envFile = join(dir, 'env.ft');
    writeFileSync(envFile, 'org.name = "FromEnvVar"\n');

    const savedEnvVar = process.env.SNAPSHOT_FT_PATH;
    process.env.SNAPSHOT_FT_PATH = envFile;
    try {
      const handle = await runDockerEnv({
        port: 0,
        dbPath: ':memory:',
        workspaceRoot: workspace,
        priorSnapshot: { kind: 'ft', text: 'org.name = "FromProgrammatic"\n' },
        silent: true,
      });
      expect(handle.server.seq!.get('org.name')).toBe('FromProgrammatic');
      await handle.shutdown();
    } finally {
      if (savedEnvVar === undefined) delete process.env.SNAPSHOT_FT_PATH;
      else process.env.SNAPSHOT_FT_PATH = savedEnvVar;
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Hot-standby pattern: server A extracts its state via entries,
  // hands it off to server B on a different port/storage, and
  // server B continues from exactly where A left off. This is the
  // primitive Lambda will use for its cold-start recovery path.
  // ═══════════════════════════════════════════════════════════════════

  test('hot-standby: state written to A, captured, restored into B, subsequent writes land on B only', async () => {
    const a = new ContextGraphServer({ port: 0, dbPath: ':memory:' });
    await a.start();
    a.seq!.mount('bind', 'tasks.t1.input', 'original');
    a.seq!.mount('bind', 'tasks.t1.status', 'pending');

    const pA = a.seq!.projection;
    const entries: MountEntry[] = [];
    for (const [path, type] of a.seq!.iterateTypes()) entries.push({ op: 'schema', path, value: type });
    for (const [path, value] of a.seq!.iterateValues()) entries.push({ op: 'bind', path, value });
    for (const [path, policy] of pA.policies) entries.push({ op: 'policy', path, value: policy });
    for (const path of pA.tools.keys()) entries.push({ op: 'tool', path, value: true });

    await a.stop();

    const b = new ContextGraphServer({
      port: 0,
      dbPath: ':memory:',
      priorSnapshot: { kind: 'entries', entries },
    });
    await b.start();

    // State carried over
    expect(b.seq!.get('tasks.t1.input')).toBe('original');
    expect(b.seq!.get('tasks.t1.status')).toBe('pending');

    // New writes on B are visible on B (status transitions through
    // the taskqueue union — pending → active).
    b.seq!.mount('bind', 'tasks.t1.status', 'active');
    b.seq!.mount('bind', 'tasks.t2.input', 'born on B');
    b.seq!.mount('bind', 'tasks.t2.status', 'pending');
    expect(b.seq!.get('tasks.t1.status')).toBe('active');
    expect(b.seq!.get('tasks.t2.input')).toBe('born on B');

    await b.stop();
  });
});
