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
 *
 * Re-expressed on the v2 transport — deletion-ledger stage 4. The
 * `entries` shape is now `captureSnapshot(seq)` (from
 * `@console-one/sequence/v2`) instead of the v1 hand-rolled
 * iterateTypes/iterateValues/policies/tools MountEntry[] walk — v2
 * has no separate policy/tool registries to iterate, and the runtime
 * impls registry is deliberately excluded (not serializable; the
 * restorer's own boot re-installs it).
 */

import { ContextGraphServer } from '../office-space-server.js';
import { runDockerEnv } from '../env/docker';
import { captureSnapshot, type SnapshotEntry } from '@console-one/sequence/v2';
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
    const serverA = new ContextGraphServer({ port: 0, workspaceRoot: tempDir('a') });
    await serverA.start();
    const seqA = serverA.seq!;

    // Mount some user-visible state on A directly on the kernel — v2
    // has no schema constraining these paths (no bootstrap.ft), so a
    // plain insert is the honest equivalent of v1's conforming-value
    // constraint (there is nothing left here to violate).
    seqA.insert({ path: 'org.name', value: 'Acme' });
    seqA.insert({ path: 'users.alice.role', value: 'admin' });
    seqA.insert({ path: 'users.bob.role', value: 'guest' });
    seqA.insert({ path: 'tasks.t1.input', value: 'write handoff doc' });
    seqA.insert({ path: 'tasks.t1.status', value: 'pending' });

    // Capture the full projection as a SnapshotEntry[] — the v2
    // snapshot primitive (captureSnapshot), the inverse of restoreSnapshot.
    const snapshot: SnapshotEntry[] = captureSnapshot(seqA);

    await serverA.stop();

    // Boot a fresh server B with the captured state injected.
    const serverB = new ContextGraphServer({
      port: 0,
      workspaceRoot: tempDir('b'),
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
  // replays as part of the boot pipeline, ON TOP of the installed
  // boot state. This is the operator-facing shape (human-readable,
  // auditable), and its ordering contract — boot installs FIRST, the
  // external snapshot replays SECOND and wins — is what the Unix ops
  // handoff and Docker restore-from-backup both depend on.
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
      workspaceRoot: tempDir('ft'),
      // The boot installs this default FIRST (ServerConfig.register
      // runs before priorSnapshot replay in v2/server.ts's start()).
      register: (seq) => { seq.insert({ path: 'org.name', value: 'BootDefault' }); },
      priorSnapshot: { kind: 'ft', text: ft },
    });
    await server.start();
    const seq = server.seq!;

    // The restored value wins over the boot default — proof that
    // "boot installs first, then restore on top" holds in v2.
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
      workspaceRoot: tempDir('ftpath-ws'),
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
      workspaceRoot: tempDir('ftpath-missing'),
      priorSnapshot: { kind: 'ftPath', path: '/no/such/snapshot.ft' },
    });
    await expect(server.start()).rejects.toThrow(/priorSnapshot ftPath.*unreadable/);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Docker env: the same three shapes plus the SNAPSHOT_FT_PATH env
  // var that operators will actually use when driving `docker run`.
  // The env wrapper must honour both. (env/docker.ts is already
  // re-pointed at the v2 server/kernel — kept as-is here.)
  // ═══════════════════════════════════════════════════════════════════

  test('runDockerEnv: programmatic priorSnapshot is applied', async () => {
    const dir = tempDir('docker-prog');
    const workspace = join(dir, 'workspace');
    const ft = 'org.name = "DockerProgrammatic"\nusers.eve.role = "admin"\n';

    const handle = await runDockerEnv({
      port: 0,
      dbPath: join(dir, 'contextgraph.db'),
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
        dbPath: join(dir, 'contextgraph.db'),
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
        dbPath: join(dir, 'contextgraph.db'),
        workspaceRoot: workspace,
        priorSnapshot: { kind: 'ft', text: 'org.name = "FromProgrammatic"\n' },
        silent: true,
      });
      // env/docker.ts resolves config.priorSnapshot ?? SNAPSHOT_FT_PATH —
      // that IS the precedence: programmatic wins when both are set.
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
    const a = new ContextGraphServer({ port: 0, workspaceRoot: tempDir('standby-a') });
    await a.start();
    a.seq!.insert({ path: 'tasks.t1.input', value: 'original' });
    a.seq!.insert({ path: 'tasks.t1.status', value: 'pending' });

    const entries: SnapshotEntry[] = captureSnapshot(a.seq!);

    await a.stop();

    const b = new ContextGraphServer({
      port: 0,
      workspaceRoot: tempDir('standby-b'),
      priorSnapshot: { kind: 'entries', entries },
    });
    await b.start();

    // State carried over
    expect(b.seq!.get('tasks.t1.input')).toBe('original');
    expect(b.seq!.get('tasks.t1.status')).toBe('pending');

    // New writes on B are visible on B.
    b.seq!.insert({ path: 'tasks.t1.status', value: 'active' });
    b.seq!.insert({ path: 'tasks.t2.input', value: 'born on B' });
    b.seq!.insert({ path: 'tasks.t2.status', value: 'pending' });
    expect(b.seq!.get('tasks.t1.status')).toBe('active');
    expect(b.seq!.get('tasks.t2.input')).toBe('born on B');

    await b.stop();
  });
});
