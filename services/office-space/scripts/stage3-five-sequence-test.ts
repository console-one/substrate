/**
 * scripts/stage3-five-sequence-test.ts — Stage 3 coherence test.
 *
 * Five real processes, four bilateral links, the full Sequence Nodes
 * topology the v1 deliverable targets. Per SEQUENCE_NODES.md, this
 * is what "done" looks like before the browsers become real:
 *
 *   Browser A  ─►  User A Session  ─►  Org Scheduler  ─►  User B Session  ─►  Browser B
 *       (1)            (2)                 (3)                 (4)              (5)
 *
 *   dial-only     listen + dial         listen-only         listen + dial      dial-only
 *   port: -       18766 / →org          18765 / -           18767 / →org       port: -
 *
 * Browsers here are `run-node` processes with no listen port — same
 * bilateral link shape a real browser uses. The final step (real
 * browser via runBrowserEnv + esbuild bundle) layers on top without
 * changing the topology.
 *
 * Propagation tests:
 *
 *   1. Browser A mounts `chat.general.line1 = "hi from alice"`.
 *      Expect the value to appear on Browser B — a traversal through
 *      ALL FIVE Sequences via FOUR bilateral links.
 *
 *   2. Browser B mounts `chat.general.line2 = "hi back from bob"`.
 *      Expect the value to appear on Browser A — the reverse
 *      direction through the same four hops.
 *
 *   3. Both browsers see BOTH mounts (convergence). The final
 *      projection at every tier contains both keys with correct
 *      values.
 *
 *   4. No unbounded loop. Snapshot counts; wait; re-snapshot;
 *      assert no growth.
 *
 * Exit code:
 *   0 — full-topology propagation verified in both directions
 *   1 — timeout, mismatch, or suspected unbounded loop
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
      // Surface child stderr for debugging but don't couple the test
      // flow to it — propagation is checked via stdout events.
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
      try { ev = JSON.parse(trimmed); }
      catch { process.stderr.write(`[${this.name}] non-JSON: ${trimmed}\n`); continue; }
      this.events.push(ev);
      for (const l of this.listeners) l(ev);
    }
  }

  on(listener: (ev: Event) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  wait(predicate: (ev: Event) => boolean, timeoutMs: number, label: string): Promise<Event> {
    const already = this.events.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        unsub();
        const kinds = this.events.map(e => e.kind).join(',');
        reject(new Error(`[${this.name}] timeout waiting for ${label}; kinds seen: ${kinds}`));
      }, timeoutMs);
      const unsub = this.on((ev) => {
        if (predicate(ev)) { clearTimeout(t); unsub(); resolve(ev); }
      });
    });
  }

  countMatching(predicate: (ev: Event) => boolean): number {
    return this.events.filter(predicate).length;
  }

  send(ftText: string): void { this.proc.stdin.write(ftText + '\n'); }
  kill(): void { try { this.proc.kill('SIGTERM'); } catch {} }
}

async function main(): Promise<number> {
  const log = (s: string) => process.stderr.write(`[harness] ${s}\n`);

  // Ports high enough to avoid colliding with anything typical.
  const orgPort = 18765;
  const userAPort = 18766;
  const userBPort = 18767;

  // ─── Spawn five processes ─────────────────────────────────────
  log('spawning org (terminal, listen-only)...');
  const org = new Node('org', ['--identity', 'org', '--listen', String(orgPort)]);
  await org.wait(ev => ev.kind === 'ready', 10_000, 'org ready');

  log('spawning user-A session (middle: listen + dial)...');
  const userA = new Node('user-A', [
    '--identity', 'userA',
    '--listen', String(userAPort),
    '--upstream', `ws://localhost:${orgPort}`,
  ]);
  await userA.wait(ev => ev.kind === 'ready', 10_000, 'user-A ready');
  await userA.wait(ev => ev.kind === 'upstream-connected', 10_000, 'user-A↔org');

  log('spawning user-B session (middle: listen + dial)...');
  const userB = new Node('user-B', [
    '--identity', 'userB',
    '--listen', String(userBPort),
    '--upstream', `ws://localhost:${orgPort}`,
  ]);
  await userB.wait(ev => ev.kind === 'ready', 10_000, 'user-B ready');
  await userB.wait(ev => ev.kind === 'upstream-connected', 10_000, 'user-B↔org');

  log('spawning browser-A (dial-only, talks to user-A)...');
  const browserA = new Node('browser-A', [
    '--identity', 'browserA',
    '--upstream', `ws://localhost:${userAPort}`,
  ]);
  await browserA.wait(ev => ev.kind === 'ready', 10_000, 'browser-A ready');
  await browserA.wait(ev => ev.kind === 'upstream-connected', 10_000, 'browser-A↔user-A');

  log('spawning browser-B (dial-only, talks to user-B)...');
  const browserB = new Node('browser-B', [
    '--identity', 'browserB',
    '--upstream', `ws://localhost:${userBPort}`,
  ]);
  await browserB.wait(ev => ev.kind === 'ready', 10_000, 'browser-B ready');
  await browserB.wait(ev => ev.kind === 'upstream-connected', 10_000, 'browser-B↔user-B');

  log('\ntopology up:');
  log('  browser-A → user-A → org ← user-B ← browser-B');
  log('  five Sequences, four bilateral links');

  const cleanup = () => {
    for (const n of [browserB, browserA, userB, userA, org]) n.kill();
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    // ─── Test 1: A → B across all five Sequences ────────────────
    log('\n[test 1] browser-A mounts; wait for browser-B to see it');
    browserA.send('chat.general.line1 = "hi from alice"');
    await browserB.wait(
      ev => ev.kind === 'local-change' && ev.path === 'chat.general.line1' && ev.value === 'hi from alice',
      8_000,
      'chat.general.line1 on browser-B',
    );
    log('  ✓ traversed browser-A → user-A → org → user-B → browser-B');

    // Verify intermediate tiers saw it too (integrity, not just
    // endpoint correctness).
    const expect1 = (n: Node) => n.wait(
      ev => ev.kind === 'local-change' && ev.path === 'chat.general.line1' && ev.value === 'hi from alice',
      1_000,
      `chat.general.line1 on ${n.name}`,
    );
    await Promise.all([expect1(userA), expect1(org), expect1(userB)]);
    log('  ✓ every tier (user-A, org, user-B) has the value');

    // ─── Test 2: B → A reverse direction ────────────────────────
    log('\n[test 2] browser-B mounts; wait for browser-A to see it');
    browserB.send('chat.general.line2 = "hi back from bob"');
    await browserA.wait(
      ev => ev.kind === 'local-change' && ev.path === 'chat.general.line2' && ev.value === 'hi back from bob',
      8_000,
      'chat.general.line2 on browser-A',
    );
    log('  ✓ traversed browser-B → user-B → org → user-A → browser-A');

    const expect2 = (n: Node) => n.wait(
      ev => ev.kind === 'local-change' && ev.path === 'chat.general.line2' && ev.value === 'hi back from bob',
      1_000,
      `chat.general.line2 on ${n.name}`,
    );
    await Promise.all([expect2(userA), expect2(org), expect2(userB)]);
    log('  ✓ every tier has it');

    // ─── Test 3: convergence ────────────────────────────────────
    log('\n[test 3] both browsers see BOTH chat lines');
    // By this point both tests above have the expected events already,
    // but an explicit double-check documents the convergence condition.
    const hasLine1 = (n: Node) => n.countMatching(
      ev => ev.kind === 'local-change' && ev.path === 'chat.general.line1' && ev.value === 'hi from alice') > 0;
    const hasLine2 = (n: Node) => n.countMatching(
      ev => ev.kind === 'local-change' && ev.path === 'chat.general.line2' && ev.value === 'hi back from bob') > 0;
    for (const n of [browserA, browserB, userA, userB, org]) {
      if (!hasLine1(n)) throw new Error(`${n.name} missing line1`);
      if (!hasLine2(n)) throw new Error(`${n.name} missing line2`);
    }
    log('  ✓ all five Sequences contain both values');

    // ─── Test 4: no unbounded loop ──────────────────────────────
    log('\n[test 4] no unbounded loop after a new mount');
    browserA.send('chat.general.line3 = "third"');
    const allNodes = [org, userA, userB, browserA, browserB];
    const match3 = (ev: Event) =>
      ev.kind === 'local-change' && ev.path === 'chat.general.line3' && ev.cause === 'direct';

    // Snapshot three times with gaps — if the system is in a true
    // loop, counts grow linearly with time. Bounded redundancy
    // stabilizes to a plateau. Three samples let us tell them apart.
    const sample = async (label: string) => {
      const s = allNodes.map(n => ({ name: n.name, count: n.countMatching(match3) }));
      log(`  ${label}: ${s.map(x => `${x.name}=${x.count}`).join(' ')}`);
      return s;
    };

    await new Promise(r => setTimeout(r, 500));
    const snap1 = await sample('t=0.5s');
    await new Promise(r => setTimeout(r, 3_000));
    const snap2 = await sample('t=3.5s');
    await new Promise(r => setTimeout(r, 3_000));
    const snap3 = await sample('t=6.5s');

    for (let i = 0; i < snap1.length; i++) {
      const d12 = snap2[i].count - snap1[i].count;
      const d23 = snap3[i].count - snap2[i].count;
      // True loop: counts grow in BOTH intervals.
      if (d12 > 0 && d23 > 0) {
        throw new Error(
          `UNBOUNDED LOOP on ${snap1[i].name}: counts grew in both intervals (${snap1[i].count} → ${snap2[i].count} → ${snap3[i].count})`,
        );
      }
    }
    log('  ✓ system quiesced; no unbounded loop');

    log('\nSTAGE 3 PASS — five-Sequence coherence verified across real processes.');
    log('The v1 topology is LIVE. Browser bundling is the remaining piece.');
    cleanup();
    return 0;
  } catch (e: any) {
    log(`\nSTAGE 3 FAIL — ${e.message}`);
    cleanup();
    return 1;
  }
}

main().then(
  (code) => setTimeout(() => process.exit(code), 200),
  (e) => { process.stderr.write(`harness crashed: ${e.stack}\n`); process.exit(2); },
);
