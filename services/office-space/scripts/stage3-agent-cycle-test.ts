/**
 * scripts/stage3-agent-cycle-test.ts — Cut A: minimum agent cycle.
 *
 *   browser-A (alice)  ─►  user-A  ─►  org  ◄─  agent-node
 *
 * Alice mounts a unit of work. An agent process on a separate
 * Sequence node detects the work arriving, computes an answer, and
 * commits it back. Alice sees the answer. Three cycles landed:
 *
 *   1. Single task — alice mounts {a, b}; agent produces sum.
 *   2. Concurrent burst — alice mounts three tasks at once;
 *      agent processes all of them; alice sees every output.
 *   3. Agent restart — agent process is shut down after a task is
 *      mounted but before it runs; a fresh agent boots against the
 *      same topology and picks up the work.
 *
 * Task shape (deliberately append-only — no status-field mutation):
 *
 *   work.{id}.a   = <number>    ─ mounted by alice
 *   work.{id}.b   = <number>    ─ mounted by alice
 *   work.{id}.sum = <number>    ─ mounted by the agent
 *
 * Presence of `sum` = done. No `status` field transitions, so no
 * literal-schema lock issue, no `__MUT__\n` wire wrap needed.
 *
 * Agent brain: `processTasks()` polls `keys('work')`, picks any
 * entry with both `a` and `b` bound and `sum` missing, mounts the
 * answer. Fires on every local `changes`/`delta` event. Same
 * dispatch shape phase-rules.ts runs as an indexSpec — this
 * version is a client-side polled callback so we can land the
 * cycle without pulling in the full index-class machinery.
 * Swapping for indexSpec is a follow-up.
 *
 * Lambda runtime (runLambdaEnv with priorSnapshot + per-
 * invocation budget) is intentionally out of scope for THIS
 * script — the cycle is what's being proven; the Lambda
 * lifecycle is a deployment shape on top of the same agent code.
 * Test 3 (agent restart) is the stand-in: it proves the agent
 * can leave mid-cycle and a fresh one picks up where the old
 * one stopped, which is exactly Lambda's cold-start shape.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { JSDOM } from 'jsdom';
import NodeWebSocket from 'ws';
import { OfficeSpaceClient } from '../src/client';
import type { Sequence } from '@ft/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

interface Event { t: number; kind: string; [k: string]: unknown; }

class ServerProcess {
  readonly name: string;
  private proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private events: Event[] = [];
  private listeners: ((ev: Event) => void)[] = [];

  constructor(name: string, args: string[]) {
    this.name = name;
    this.proc = spawn('npx', ['tsx', join(__dirname, 'run-node.ts'), ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf-8');
    this.proc.stderr.setEncoding('utf-8');
    this.proc.stdout.on('data', (c: string) => this.onStdout(c));
    this.proc.stderr.on('data', (c: string) => process.stderr.write(`[${name}:stderr] ${c}`));
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        this.events.push(ev);
        for (const l of this.listeners) l(ev);
      } catch {}
    }
  }

  wait(p: (ev: Event) => boolean, timeoutMs: number, label: string): Promise<Event> {
    const hit = this.events.find(p);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`[${this.name}] timeout: ${label}`)), timeoutMs);
      this.listeners.push((ev) => { if (p(ev)) { clearTimeout(t); res(ev); } });
    });
  }
  kill(): void { try { this.proc.kill('SIGTERM'); } catch {} }
}

class JsdomBrowser {
  readonly name: string;
  readonly dom: JSDOM;
  readonly officeSpace: any;
  private listeners: (() => void)[] = [];

  constructor(name: string, bundleSrc: string) {
    this.name = name;
    this.dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'http://localhost/',
      runScripts: 'outside-only',
    });
    const w = this.dom.window as any;
    w.WebSocket = NodeWebSocket;
    this.dom.window.eval(bundleSrc);
    this.officeSpace = w.officeSpace;
    if (!this.officeSpace) throw new Error(`[${name}] bundle failed to register officeSpace`);
    this.officeSpace.on((ev: any) => {
      if (ev.kind === 'render' || ev.kind === 'delta' || ev.kind === 'changes') {
        for (const l of this.listeners) l();
      }
    });
  }

  async boot(user: string, serverUrl: string): Promise<void> {
    await this.officeSpace.boot({ user, serverUrl });
  }

  waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`[${this.name}] timeout: ${label}`)), timeoutMs);
      this.listeners.push(() => { if (predicate()) { clearTimeout(t); resolve(); } });
    });
  }

  close(): void { this.dom.window.close(); }
}

// ─── Agent worker ──────────────────────────────────────────────
// A plain OfficeSpaceClient with a capability: pick up any
// work.{id} that has `a` + `b` but no `sum`, compute the sum,
// mount it. This is the minimum viable "agent" — the shape
// extends to LLM-backed caps without changing the loop.
class AgentWorker {
  readonly name: string;
  readonly client: OfficeSpaceClient;
  private dataDir: string;
  private completedIds = new Set<string>();

  constructor(name: string, serverUrl: string) {
    this.name = name;
    this.dataDir = mkdtempSync(join(tmpdir(), `office-space-${name}-`));
    this.client = new OfficeSpaceClient({
      dataDir: this.dataDir,
      serverUrl,
      user: name,
      env: 'agent',
      heartbeatMs: 15_000,
      reconnectMs: 500,
    });
    this.client.on((ev: any) => {
      if (ev.kind === 'render' || ev.kind === 'delta' || ev.kind === 'changes') {
        this.processTasks();
      }
    });
  }

  async boot(): Promise<void> {
    await this.client.boot();
    // Give the initial hoist snapshot time to land. client.boot()
    // resolves on ws 'open' but the snapshot `ws.send(hoist(...))`
    // from the server happens just after — there's no built-in
    // signal the snapshot has been fully received. 500ms is safe
    // enough for a localhost round trip plus receive() walk.
    await new Promise(r => setTimeout(r, 500));
    // Scan for pre-existing work (from the initial snapshot) that
    // still needs an answer. This is the agent-restart shape: a
    // fresh agent picks up unfinished work without explicit re-
    // dispatch.
    this.processTasks();
  }

  private processTasks(): void {
    const seq = (this.client as any).seq as Sequence;
    const ids = seq.keys('work');
    for (const id of ids) {
      if (this.completedIds.has(id)) continue;
      const a = seq.get(`work.${id}.a`);
      const b = seq.get(`work.${id}.b`);
      const existing = seq.get(`work.${id}.sum`);
      if (existing !== undefined) {
        this.completedIds.add(id);
        continue;
      }
      if (typeof a !== 'number' || typeof b !== 'number') continue;
      // Deterministic, side-effect-free capability invocation.
      // In a real agent this would route through capability.ts
      // (quota/reliability/trace enforcement) and select() the
      // right cap via type-driven dispatch. Bypassed here to
      // keep the cycle proof minimal.
      const answer = a + b;
      try {
        this.client.mount(`work.${id}.sum = ${answer}`);
        this.completedIds.add(id);
      } catch (e: any) {
        process.stderr.write(`[${this.name}] mount failed for work.${id}: ${e.message}\n`);
      }
    }
  }

  shutdown(): void {
    try { this.client.shutdown(); } catch {}
    try { rmSync(this.dataDir, { recursive: true, force: true }); } catch {}
  }
}

async function main(): Promise<number> {
  const log = (s: string) => process.stderr.write(`[harness] ${s}\n`);

  const bundlePath = join(REPO_ROOT, 'dist-web', 'bundle.js');
  let bundleSrc: string;
  try { bundleSrc = readFileSync(bundlePath, 'utf-8'); }
  catch { log(`ERROR: ${bundlePath} missing. Run \`node scripts/build-web.cjs\``); return 1; }

  const orgPort = 29165, userAPort = 29166;

  log('spawning server tier (org + userA)...');
  const org = new ServerProcess('org', ['--identity', 'org', '--listen', String(orgPort)]);
  await org.wait(ev => ev.kind === 'ready', 10_000, 'org');
  const userA = new ServerProcess('user-A',
    ['--identity', 'userA', '--listen', String(userAPort),
     '--upstream', `ws://localhost:${orgPort}`]);
  await userA.wait(ev => ev.kind === 'ready', 10_000, 'user-A');
  await userA.wait(ev => ev.kind === 'upstream-connected', 10_000, 'user-A↔org');

  log('booting browser-A (alice) + agent...');
  const browserA = new JsdomBrowser('browser-A', bundleSrc);
  await browserA.boot('alice', `ws://localhost:${userAPort}`);
  // Agent dials org directly. It could equally dial a dedicated
  // user session; for the minimum cycle any connected peer works.
  const agent = new AgentWorker('agent_1', `ws://localhost:${orgPort}`);
  await agent.boot();
  await new Promise(r => setTimeout(r, 500));

  let currentAgent: AgentWorker | null = agent;
  const cleanup = () => {
    try { browserA.close(); } catch {}
    try { currentAgent?.shutdown(); } catch {}
    for (const n of [userA, org]) n.kill();
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    // ─── Test 1: single task end-to-end ─────────────────────────
    log('\n[test 1] single task — alice mounts {a=3, b=5}; agent returns sum=8');
    browserA.officeSpace.mount('work.j1.a = 3');
    browserA.officeSpace.mount('work.j1.b = 5');
    await browserA.waitFor(
      () => browserA.officeSpace.get('work.j1.sum') === 8,
      12_000,
      'alice sees work.j1.sum',
    );
    log('  ✓ alice observes work.j1.sum = 8');

    // ─── Test 2: concurrent burst — three tasks at once ─────────
    log('\n[test 2] concurrent burst — alice mounts j2, j3, j4 rapidly');
    const burst: Array<[string, number, number, number]> = [
      ['j2', 10, 20, 30],
      ['j3', 7,  7,  14],
      ['j4', 100, 1, 101],
    ];
    for (const [id, a, b] of burst) {
      browserA.officeSpace.mount(`work.${id}.a = ${a}`);
      browserA.officeSpace.mount(`work.${id}.b = ${b}`);
    }
    for (const [id, , , expected] of burst) {
      await browserA.waitFor(
        () => browserA.officeSpace.get(`work.${id}.sum`) === expected,
        15_000,
        `alice sees work.${id}.sum = ${expected}`,
      );
    }
    log(`  ✓ alice observes all three sums (j2=30, j3=14, j4=101)`);

    // ─── Test 3: agent restart ──────────────────────────────────
    // Shut the agent down. Alice mounts a new task. No agent
    // exists → work.j5.sum stays undefined. Boot a fresh agent
    // (same identity; fresh dataDir so boot is a cold start).
    // The fresh agent's initial hoist snapshot contains j5.a and
    // j5.b; its boot-time processTasks() picks it up.
    log('\n[test 3] agent restart — task mounted while agent is down, fresh agent completes it');
    currentAgent?.shutdown();
    currentAgent = null;
    await new Promise(r => setTimeout(r, 300));  // let shutdown land

    browserA.officeSpace.mount('work.j5.a = 42');
    browserA.officeSpace.mount('work.j5.b = 58');
    // Give propagation a moment; confirm no agent means no answer.
    await new Promise(r => setTimeout(r, 800));
    if (browserA.officeSpace.get('work.j5.sum') !== undefined) {
      throw new Error('work.j5.sum appeared without an agent running — test setup broken');
    }
    log('  ✓ work.j5.sum is undefined while no agent is connected');


    currentAgent = new AgentWorker('agent_2', `ws://localhost:${orgPort}`);
    await currentAgent.boot();
    await browserA.waitFor(
      () => browserA.officeSpace.get('work.j5.sum') === 100,
      15_000,
      'alice sees work.j5.sum after fresh agent boots',
    );
    log('  ✓ fresh agent picked up pending work.j5 and produced sum = 100');

    log('\nSTAGE 3 AGENT CYCLE PASS — Cut A: gap → agent → cap → result verified');
    cleanup();
    return 0;
  } catch (e: any) {
    log(`\nFAIL — ${e.message}`);
    cleanup();
    return 1;
  }
}

main().then(
  (code) => setTimeout(() => process.exit(code), 300),
  (e) => { process.stderr.write(`harness crashed: ${e.stack}\n`); process.exit(2); },
);
