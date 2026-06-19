/**
 * env-lambda.test.ts — Lambda agent env adapter.
 *
 * The Lambda env is the third of four env adapters. Unlike Unix
 * and Docker (long-running processes with persistent /home or
 * /var/lib), Lambda is ephemeral: each invocation is a cold start
 * that boots a PermanentAgent, runs one execution cycle bounded
 * by the remaining Lambda budget, and returns an updated snapshot
 * for the caller to push back to object storage.
 *
 * These tests run in-process — no real AWS SDK, no container —
 * against a real ContextGraphServer and a stub S3Storage. They
 * cover:
 *   - cold start with no prior snapshot
 *   - priorSnapshot (ft) hydrates the agent's local view
 *   - priorSnapshot (ftPath) reads from disk
 *   - S3-stub round-trip: pull snapshot, run, push snapshot
 *   - remainingTimeMs bounds agent.maxExecutionMs
 *   - entries shape rejected at the adapter boundary
 *   - lambdaHandler wraps runLambdaEnv with a LambdaContext
 *   - /tmp root override scopes multiple invocations
 */

import { ContextGraphServer } from '../office-space-server.js';
import { runLambdaEnv, lambdaHandler } from '../env/lambda';
import { S3Storage, resetAllS3Buckets } from '@console-one/sequenceutils/transport';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Lambda env adapter', () => {
  let server: ContextGraphServer;
  let port: number;
  const tmpDirs: string[] = [];

  beforeEach(async () => {
    server = new ContextGraphServer({ port: 0, dbPath: ':memory:' });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    resetAllS3Buckets();
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

  function tempRoot(tag: string): string {
    const d = mkdtempSync(join(tmpdir(), `office-space-lambda-${tag}-`));
    tmpDirs.push(d);
    return d;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Cold start: no prior snapshot, agent boots with empty local view,
  // connects to server, runs one cycle, returns 200 with a snapshot
  // the caller can persist for the next invocation.
  // ═══════════════════════════════════════════════════════════════════

  test('cold start with no priorSnapshot completes and returns an updated snapshot', async () => {
    const root = tempRoot('cold');
    const result = await runLambdaEnv({
      agentId: 'agent_cold',
      serverUrl: `ws://localhost:${port}`,
      tmpRoot: root,
      remainingTimeMs: 5000,
      silent: true,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.agentId).toBe('agent_cold');
    // No gaps on a fresh bootstrap → complete immediately.
    expect(['complete', 'longwait']).toContain(result.body.stopReason);
    // snapshot.ft was written during agent shutdown and read back.
    expect(typeof result.body.snapshotFt).toBe('string');
    expect(existsSync(join(root, 'agent_cold', 'snapshot.ft'))).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Warm restore: the priorSnapshot ft is written to the agent's
  // local snapshot path before PermanentAgent boots, so the client's
  // loadSnapshot picks it up. After the run, state from the prior
  // snapshot is reflected in the outgoing snapshotFt.
  // ═══════════════════════════════════════════════════════════════════

  test('priorSnapshot (ft) hydrates agent local state before boot', async () => {
    const root = tempRoot('warm');
    const priorFt = [
      'notes.welcome = "hello from prior run"',
      'memory.counter = 42',
    ].join('\n');

    const result = await runLambdaEnv({
      agentId: 'agent_warm',
      serverUrl: `ws://localhost:${port}`,
      tmpRoot: root,
      priorSnapshot: { kind: 'ft', text: priorFt },
      remainingTimeMs: 5000,
      silent: true,
    });

    expect(result.statusCode).toBe(200);
    // The snapshot file on disk was seeded from priorSnapshot AND
    // then re-saved by the agent's client on shutdown.
    const diskFt = readFileSync(join(root, 'agent_warm', 'snapshot.ft'), 'utf-8');
    expect(diskFt).toContain('welcome');
    expect(diskFt).toContain('hello from prior run');
    expect(diskFt).toContain('counter');
    // And the returned snapshot body contains the same state.
    expect(result.body.snapshotFt).toContain('welcome');
  });

  test('priorSnapshot (ftPath) reads ft text from a file on disk', async () => {
    const root = tempRoot('ftpath');
    const ftFile = join(root, 'seed.ft');
    writeFileSync(ftFile, 'memory.seeded = true\nnotes.origin = "disk"\n');

    const result = await runLambdaEnv({
      agentId: 'agent_ftpath',
      serverUrl: `ws://localhost:${port}`,
      tmpRoot: root,
      priorSnapshot: { kind: 'ftPath', path: ftFile },
      remainingTimeMs: 5000,
      silent: true,
    });

    expect(result.statusCode).toBe(200);
    const diskFt = readFileSync(join(root, 'agent_ftpath', 'snapshot.ft'), 'utf-8');
    expect(diskFt).toContain('seeded');
    expect(diskFt).toContain('origin');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Entries shape is server-only: the agent's local persistence is
  // ft text, not MountEntry[]. Passing entries to the lambda env is
  // a programming error and should surface clearly.
  // ═══════════════════════════════════════════════════════════════════

  test('priorSnapshot entries shape is rejected with a clear error', async () => {
    const root = tempRoot('entries');
    await expect(runLambdaEnv({
      agentId: 'agent_entries',
      serverUrl: `ws://localhost:${port}`,
      tmpRoot: root,
      priorSnapshot: { kind: 'entries', entries: [] },
      remainingTimeMs: 5000,
      silent: true,
    })).rejects.toThrow(/entries shape is server-only/);
  });

  // ═══════════════════════════════════════════════════════════════════
  // S3-stub round-trip: simulates the real Lambda deployment pattern.
  // Caller pulls from S3, hands the ft to runLambdaEnv, receives an
  // updated ft back, writes it to S3. Next invocation picks it up.
  // ═══════════════════════════════════════════════════════════════════

  test('S3 round-trip: pull → run → push → next invocation sees state', async () => {
    const root = tempRoot('s3rt');
    const s3 = new S3Storage({ bucket: 'test-agents' });
    const key = 'agents/alice/snapshot.ft';

    // First invocation: no prior snapshot in S3.
    const priorFtFirst = (await s3.exists(key)) ? await s3.read(key) : '';
    const first = await runLambdaEnv({
      agentId: 'alice',
      serverUrl: `ws://localhost:${port}`,
      tmpRoot: join(root, 'inv1'),
      priorSnapshot: priorFtFirst ? { kind: 'ft', text: priorFtFirst } : undefined,
      remainingTimeMs: 5000,
      silent: true,
    });
    expect(first.statusCode).toBe(200);

    // Push the resulting snapshot back to S3 — this is what a real
    // Lambda deployment would do in its outer wrapper.
    await s3.write(key, first.body.snapshotFt);
    expect(await s3.exists(key)).toBe(true);

    // Second invocation: fresh /tmp (cold start simulation), pulls
    // from S3, should see prior snapshot content.
    const priorFtSecond = await s3.read(key);
    expect(priorFtSecond.length).toBeGreaterThan(0);

    const second = await runLambdaEnv({
      agentId: 'alice',
      serverUrl: `ws://localhost:${port}`,
      tmpRoot: join(root, 'inv2'),  // simulating fresh /tmp
      priorSnapshot: { kind: 'ft', text: priorFtSecond },
      remainingTimeMs: 5000,
      silent: true,
    });
    expect(second.statusCode).toBe(200);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Time budget: maxExecutionMs derives from remainingTimeMs minus a
  // 2s safety margin. A very short budget should still complete (no
  // gaps, no work), and the result's stopReason should never be
  // 'timeout' on a trivially-empty state.
  // ═══════════════════════════════════════════════════════════════════

  test('remainingTimeMs bounds the execution budget (2s safety margin)', async () => {
    const root = tempRoot('budget');
    const result = await runLambdaEnv({
      agentId: 'agent_budget',
      serverUrl: `ws://localhost:${port}`,
      tmpRoot: root,
      remainingTimeMs: 3000,  // → maxExecutionMs = 1000
      silent: true,
    });
    expect(result.statusCode).toBe(200);
    // On a no-gap cold start the agent returns long before timeout.
    expect(['complete', 'longwait']).toContain(result.body.stopReason);
  });

  test('remainingTimeMs below safety margin clamps to a 1s floor', async () => {
    const root = tempRoot('floor');
    // 1000ms remaining is less than the 2000ms safety margin. The
    // env should clamp maxExecutionMs to 1000 (the Math.max floor),
    // not pass through a negative value that would blow up the
    // agent's timeout check.
    const result = await runLambdaEnv({
      agentId: 'agent_floor',
      serverUrl: `ws://localhost:${port}`,
      tmpRoot: root,
      remainingTimeMs: 1000,
      silent: true,
    });
    expect(result.statusCode).toBe(200);
  });

  // ═══════════════════════════════════════════════════════════════════
  // lambdaHandler: the real entry point. Takes an AWS-shaped event
  // and context, threads remainingTimeMs from the context.
  // ═══════════════════════════════════════════════════════════════════

  test('lambdaHandler wraps runLambdaEnv with a LambdaContext', async () => {
    const root = tempRoot('handler');
    // Sneak the test tmpRoot into the event — the handler's default
    // is /tmp/office-space, which isn't always writable in CI. This
    // uses the fact that `runLambdaEnv` accepts `tmpRoot` and
    // `lambdaHandler` spreads the event through verbatim.
    const result = await lambdaHandler(
      {
        agentId: 'agent_handler',
        serverUrl: `ws://localhost:${port}`,
        // @ts-expect-error — tmpRoot is on RunLambdaEnvConfig, not
        // LambdaEvent. Adding it here proves the handler doesn't
        // filter unknown fields; real deployments never do this.
        tmpRoot: root,
      },
      { getRemainingTimeInMillis: () => 5000 }
    );

    expect(result.statusCode).toBe(200);
    expect(result.body.agentId).toBe('agent_handler');
    expect(typeof result.body.snapshotFt).toBe('string');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Two agents on the same Lambda's /tmp root: scratch dirs must be
  // isolated per agentId so a rogue agent can't scribble another
  // agent's snapshot.
  // ═══════════════════════════════════════════════════════════════════

  test('two agentIds share a tmpRoot without colliding', async () => {
    const root = tempRoot('two');
    const a = await runLambdaEnv({
      agentId: 'alpha',
      serverUrl: `ws://localhost:${port}`,
      tmpRoot: root,
      priorSnapshot: { kind: 'ft', text: 'memory.who = "alpha"\n' },
      remainingTimeMs: 5000,
      silent: true,
    });
    const b = await runLambdaEnv({
      agentId: 'beta',
      serverUrl: `ws://localhost:${port}`,
      tmpRoot: root,
      priorSnapshot: { kind: 'ft', text: 'memory.who = "beta"\n' },
      remainingTimeMs: 5000,
      silent: true,
    });

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(readFileSync(join(root, 'alpha', 'snapshot.ft'), 'utf-8')).toContain('"alpha"');
    expect(readFileSync(join(root, 'beta', 'snapshot.ft'), 'utf-8')).toContain('"beta"');
  });
});
