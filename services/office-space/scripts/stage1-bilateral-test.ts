/**
 * scripts/stage1-bilateral-test.ts — Stage 1 coherence test.
 *
 * Spawns two REAL processes via `tsx run-node.ts` and proves the
 * bilateral link works across a real WebSocket. Per
 * SEQUENCE_NODES.md, same-process simulation does NOT count — each
 * node must own its process, clock, and blast radius.
 *
 * Topology:
 *
 *   Process 1 (org)    listen 8765   — no upstream
 *   Process 2 (alice)  listen 8766   — upstream ws://localhost:8765
 *
 * Propagation tests:
 *
 *   1. alice mounts `task.t1.status = "pending"`. Expect it to appear
 *      on org within a short timeout.
 *   2. org mounts `org.broadcast = "hello"`. Expect it to appear on
 *      alice within a short timeout.
 *
 * Both directions exercise the same bilateral-gap-exchange wire
 * protocol — the recursion invariant in the Sequence Nodes doc.
 *
 * Exit code:
 *   0 — both propagations observed
 *   1 — timeout or mismatch (details on stderr)
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ═══════════════════════════════════════════════════════════════════
// Process wrapper — spawns `tsx run-node.ts` and parses the event
// stream out of stdout. Each line is one JSON event.
// ═══════════════════════════════════════════════════════════════════

interface Event {
  t: number;
  kind: string;
  [k: string]: unknown;
}

class Node {
  readonly name: string;
  private proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private events: Event[] = [];
  private listeners: ((ev: Event) => void)[] = [];

  constructor(name: string, args: string[]) {
    this.name = name;
    const runner = join(__dirname, 'run-node.ts');
    this.proc = spawn('npx', ['tsx', runner, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf-8');
    this.proc.stderr.setEncoding('utf-8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk: string) => {
      // Surface child stderr to help debugging, but don't crash.
      process.stderr.write(`[${name}:stderr] ${chunk}`);
    });
    this.proc.on('exit', (code) => {
      process.stderr.write(`[${name}] exited code=${code}\n`);
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev: Event;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        process.stderr.write(`[${this.name}] non-JSON line: ${trimmed}\n`);
        continue;
      }
      this.events.push(ev);
      for (const l of this.listeners) l(ev);
    }
  }

  on(listener: (ev: Event) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  /** Wait for an event matching predicate. Checks already-seen
   *  events first, then subscribes. Rejects on timeout. */
  wait(predicate: (ev: Event) => boolean, timeoutMs: number, label: string): Promise<Event> {
    const already = this.events.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        unsub();
        const seen = this.events.map(e => e.kind).join(',');
        reject(new Error(`[${this.name}] timeout waiting for ${label}; saw: ${seen}`));
      }, timeoutMs);
      const unsub = this.on((ev) => {
        if (predicate(ev)) { clearTimeout(t); unsub(); resolve(ev); }
      });
    });
  }

  send(ftText: string): void {
    this.proc.stdin.write(ftText + '\n');
  }

  kill(): void {
    try { this.proc.kill('SIGTERM'); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════
// Test flow
// ═══════════════════════════════════════════════════════════════════

async function main(): Promise<number> {
  const log = (s: string) => process.stderr.write(`[harness] ${s}\n`);

  // Pick high ports to avoid colliding with a running dev server.
  const orgPort = 18765;
  const alicePort = 18766;

  log('spawning org...');
  const org = new Node('org', ['--identity', 'org', '--listen', String(orgPort)]);
  await org.wait(ev => ev.kind === 'ready', 10_000, 'org ready');
  log(`org ready on :${orgPort}`);

  log('spawning alice (dials org)...');
  const alice = new Node('alice', [
    '--identity', 'alice',
    '--listen', String(alicePort),
    '--upstream', `ws://localhost:${orgPort}`,
  ]);

  const cleanup = () => { alice.kill(); org.kill(); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    await alice.wait(ev => ev.kind === 'ready', 10_000, 'alice ready');
    log(`alice ready on :${alicePort}`);

    await alice.wait(ev => ev.kind === 'upstream-connected', 10_000, 'alice upstream-connected');
    log('alice connected to org');

    // Propagation 1: alice → org
    log('mounting on alice: tasks.t1.status = "pending"');
    alice.send('tasks.t1.status = "pending"');
    const seenOnOrg = await org.wait(
      ev => ev.kind === 'local-change' && ev.path === 'tasks.t1.status' && ev.value === 'pending',
      5_000,
      'tasks.t1.status on org',
    );
    log(`✓ alice → org: ${JSON.stringify(seenOnOrg)}`);

    // Propagation 2: org → alice
    log('mounting on org: org.broadcast = "hello"');
    org.send('org.broadcast = "hello"');
    const seenOnAlice = await alice.wait(
      ev => ev.kind === 'local-change' && ev.path === 'org.broadcast' && ev.value === 'hello',
      5_000,
      'org.broadcast on alice',
    );
    log(`✓ org → alice: ${JSON.stringify(seenOnAlice)}`);

    log('\nSTAGE 1 PASS — bilateral link verified across real processes.');
    cleanup();
    return 0;
  } catch (e: any) {
    log(`\nSTAGE 1 FAIL — ${e.message}`);
    cleanup();
    return 1;
  }
}

main().then(
  (code) => setTimeout(() => process.exit(code), 200),
  (e) => { process.stderr.write(`harness crashed: ${e.stack}\n`); process.exit(2); },
);
