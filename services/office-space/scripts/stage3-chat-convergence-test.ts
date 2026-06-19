/**
 * scripts/stage3-chat-convergence-test.ts — v1 coherence with real
 * collaborative shape: a chat room as an append-only Sequence of
 * messages, both browsers writing concurrently, assert convergence.
 *
 * This replaces the earlier field-assignment test (room.msg = X,
 * room.reply = X) with the correct model. In a Sequence-based system
 * "room" is a COLLECTION; each message is a unique path under it.
 * Key-derived glob schemas (`key('id')` on `chat.room.messages.*`)
 * would be the sugar; here we skip that since propagating a schema
 * mount across tiers requires setup on every process. Authors pick
 * unique keys (`{author}-{n}`) and converge on the same set.
 *
 * Topology is the same five-Sequence shape:
 *
 *   browser-A  ─►  user-A session  ─►  org  ─►  user-B session  ─►  browser-B
 *
 * All five run as real processes (run-node) except the two browsers,
 * which load the esbuild bundle into jsdom. The bundle is the exact
 * binary a Chrome tab would execute.
 *
 * Tests:
 *
 *   1. Single message end-to-end:
 *      A mounts `chat.room1.messages.alice_1 = { text, author, ts }`.
 *      B sees it as a child of `chat.room1.messages`.
 *
 *   2. Convergence on set: A and B each post a few messages. Each
 *      side eventually has the FULL set of children — same `keys`,
 *      same values. No lost messages.
 *
 *   3. Concurrent burst: A and B both post rapidly AT THE SAME TIME
 *      (no delay between sends). The final set is still complete on
 *      both sides. This stresses the ordering machinery: deltas
 *      arrive interleaved at org, propagate to both middles, land at
 *      both browsers in potentially different orders, but the final
 *      SET matches.
 *
 * Ordering is NOT asserted to be identical across browsers —
 * without a kernel-level total-order guarantee across peer-sourced
 * mutations, each browser may see the interleave in its own order.
 * Convergence of the set is the v1 property. Total order would be a
 * separate layer (logical clocks, scheduler-mediated ordering).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';
import NodeWebSocket from 'ws';

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

// jsdom-hosted browser with query helpers over the local Sequence.
class JsdomBrowser {
  readonly name: string;
  readonly dom: JSDOM;
  readonly officeSpace: any;
  private listeners: ((text: string) => void)[] = [];
  private latest = '';

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
      if (ev.kind === 'render' || ev.kind === 'delta') {
        this.latest = this.officeSpace.render();
        for (const l of this.listeners) l(this.latest);
      }
    });
  }

  async boot(user: string, serverUrl: string): Promise<void> {
    await this.officeSpace.boot({ user, serverUrl });
  }

  mount(ftText: string): void { this.officeSpace.mount(ftText); }
  render(): string { return this.officeSpace.render(); }

  /** Extract the set of keys under `chat.room1.messages`. Each
   *  message is a string value at a unique path, rendered by hoist
   *  as one leaf line `chat.room1.messages.{key} = "..."`. (Objects
   *  would create `_provenance` sidecars that hoist treats as
   *  children, suppressing the parent value line — string values
   *  avoid that by having no sidecars.) */
  messageKeys(): Set<string> {
    const text = this.latest;
    const re = /chat\.room1\.messages\.([a-zA-Z0-9_]+)\s*=\s*"/g;
    const keys = new Set<string>();
    for (const m of text.matchAll(re)) keys.add(m[1]);
    return keys;
  }

  /** Read a specific message's string value. */
  messageText(key: string): string | undefined {
    const re = new RegExp(`chat\\.room1\\.messages\\.${key}\\s*=\\s*"([^"]*)"`);
    const m = this.latest.match(re);
    return m ? m[1] : undefined;
  }

  /** Wait until the browser's hoist contains ALL expected keys (as a
   *  subset check). Resolves on the first render where the predicate
   *  holds. */
  waitForKeys(expected: string[], timeoutMs: number): Promise<void> {
    const has = () => expected.every(k => this.messageKeys().has(k));
    if (has()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const chatLines = this.latest
          .split('\n')
          .filter(l => l.includes('chat.'))
          .join('\n');
        reject(new Error(
          `[${this.name}] timeout waiting for keys ${expected.join(',')}\n` +
          `had: ${[...this.messageKeys()].join(',') || '(none)'}\n` +
          `chat.* lines in render:\n${chatLines || '(none)'}`,
        ));
      }, timeoutMs);
      this.listeners.push(() => { if (has()) { clearTimeout(t); resolve(); } });
    });
  }

  close(): void { this.dom.window.close(); }
}

async function main(): Promise<number> {
  const log = (s: string) => process.stderr.write(`[harness] ${s}\n`);

  const bundlePath = join(REPO_ROOT, 'dist-web', 'bundle.js');
  let bundleSrc: string;
  try { bundleSrc = readFileSync(bundlePath, 'utf-8'); }
  catch { log(`ERROR: ${bundlePath} missing. Run \`npm run build:web\``); return 1; }

  const orgPort = 28865, userAPort = 28866, userBPort = 28867;

  log('spawning server tier...');
  const org = new ServerProcess('org', ['--identity', 'org', '--listen', String(orgPort)]);
  await org.wait(ev => ev.kind === 'ready', 10_000, 'org');
  const userA = new ServerProcess('user-A',
    ['--identity', 'userA', '--listen', String(userAPort),
     '--upstream', `ws://localhost:${orgPort}`]);
  await userA.wait(ev => ev.kind === 'ready', 10_000, 'user-A');
  await userA.wait(ev => ev.kind === 'upstream-connected', 10_000, 'user-A↔org');
  const userB = new ServerProcess('user-B',
    ['--identity', 'userB', '--listen', String(userBPort),
     '--upstream', `ws://localhost:${orgPort}`]);
  await userB.wait(ev => ev.kind === 'ready', 10_000, 'user-B');
  await userB.wait(ev => ev.kind === 'upstream-connected', 10_000, 'user-B↔org');

  log('booting jsdom browsers...');
  const browserA = new JsdomBrowser('browser-A', bundleSrc);
  await browserA.boot('alice', `ws://localhost:${userAPort}`);
  const browserB = new JsdomBrowser('browser-B', bundleSrc);
  await browserB.boot('bob', `ws://localhost:${userBPort}`);
  await new Promise(r => setTimeout(r, 500));

  const cleanup = () => {
    try { browserA.close(); } catch {}
    try { browserB.close(); } catch {}
    for (const n of [userB, userA, org]) n.kill();
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Helper: build a message-mount ft line. Multi-field objects spread
  // into sub-paths, which is what the walker does for `x = {a, b, c}`
  // — each field ends up as its own bind at `x.a`, `x.b`, `x.c`. The
  // hoist output has one line per field, which is what our parser
  // (messageKeys / messageText) matches against.
  const msg = (author: string, n: number, text: string): string => {
    // Each message is a string at a unique path. Underscore separator
    // because the DSL parser treats `-` as minus. Author is encoded in
    // the key — `alice_1` is both "alice's message #1" and a unique
    // path under `chat.room1.messages`. String values keep the hoist
    // rendering clean (object values get `_provenance` sidecars that
    // confuse the parser / test).
    const key = `${author}_${n}`;
    return `chat.room1.messages.${key} = "${text}"`;
  };

  try {
    // ─── Test 1: single message each direction ──────────────────
    log('\n[test 1] single messages each direction');
    browserA.mount(msg('alice', 1, 'first message'));
    await browserB.waitForKeys(['alice_1'], 8_000);
    if (browserB.messageText('alice_1') !== 'first message') {
      throw new Error(`browser-B has alice_1 but text mismatch: ${browserB.messageText('alice_1')}`);
    }
    log('  ✓ browser-B sees alice_1 with correct text');

    browserB.mount(msg('bob', 1, 'second message'));
    await browserA.waitForKeys(['bob_1'], 8_000);
    if (browserA.messageText('bob_1') !== 'second message') {
      throw new Error(`browser-A has bob_1 but text mismatch: ${browserA.messageText('bob_1')}`);
    }
    log('  ✓ browser-A sees bob_1 with correct text');

    // ─── Test 2: convergence on a set (sequential, with small waits) ──
    // Verify basic multi-message convergence first with waits between
    // mounts so each delta has time to round-trip. Test 3 stresses
    // the no-wait concurrent burst case.
    log('\n[test 2] convergence on the full message set (sequential)');
    const seqMounts = [
      () => browserA.mount(msg('alice', 2, 'another from alice')),
      () => browserB.mount(msg('bob', 2, 'another from bob')),
      () => browserA.mount(msg('alice', 3, 'alice again')),
      () => browserB.mount(msg('bob', 3, 'bob again')),
    ];
    for (const m of seqMounts) {
      m();
      await new Promise(r => setTimeout(r, 200));
    }

    const expected = ['alice_1', 'alice_2', 'alice_3', 'bob_1', 'bob_2', 'bob_3'];
    await browserA.waitForKeys(expected, 10_000);
    await browserB.waitForKeys(expected, 10_000);
    log(`  ✓ both browsers see all ${expected.length} messages`);

    for (const k of expected) {
      if (browserA.messageText(k) !== browserB.messageText(k)) {
        throw new Error(
          `value mismatch at ${k}: A="${browserA.messageText(k)}" B="${browserB.messageText(k)}"`,
        );
      }
    }
    log('  ✓ message texts agree across both browsers');

    // ─── Test 3: concurrent burst ──────────────────────────────
    log('\n[test 3] concurrent burst from both browsers simultaneously');
    const burstSize = 5;
    const aKeys: string[] = [];
    const bKeys: string[] = [];
    for (let i = 4; i < 4 + burstSize; i++) {
      aKeys.push(`alice_${i}`);
      bKeys.push(`bob_${i}`);
    }

    // Timing diagnostic: record wall time from first mount call until
    // every expected key is seen on both browsers. 20s is way too
    // slow for 10 localhost mounts across 4 hops; this number tells
    // us where to aim the optimization.
    const t0 = Date.now();
    for (let i = 4; i < 4 + burstSize; i++) {
      browserA.mount(msg('alice', i, `A burst ${i}`));
      browserB.mount(msg('bob', i, `B burst ${i}`));
    }
    const tMountsDone = Date.now();
    log(`  (mount calls returned in ${tMountsDone - t0}ms)`);

    const allBurst = [...aKeys, ...bKeys];

    // Give both browsers a generous window for the full topology to
    // propagate all 10 bursts through four bilateral links in both
    // directions. If either times out we dump every tier's chat.*
    // lines to diagnose where messages stop.
    try {
      await Promise.all([
        browserA.waitForKeys(allBurst, 20_000),
        browserB.waitForKeys(allBurst, 20_000),
      ]);
      log(`  (full convergence at ${Date.now() - t0}ms after first mount)`);
    } catch (e: any) {
      log(`\n  diagnostic dump on burst timeout:`);
      const dumpKeys = (n: JsdomBrowser | ServerProcess, name: string) => {
        if ('render' in n) {
          const lines = n.render().split('\n').filter(l => l.includes('chat.room1.messages.'));
          log(`    ${name}: ${lines.length} chat lines — ${lines.join(' | ')}`);
        }
      };
      dumpKeys(browserA, 'browser-A');
      dumpKeys(browserB, 'browser-B');
      throw e;
    }
    log(`  ✓ both browsers received all ${allBurst.length} concurrent messages`);

    // Combined final set check across ALL messages so far.
    const allKeys = [...expected, ...allBurst];
    const aSet = browserA.messageKeys();
    const bSet = browserB.messageKeys();
    for (const k of allKeys) {
      if (!aSet.has(k)) throw new Error(`browser-A missing ${k}`);
      if (!bSet.has(k)) throw new Error(`browser-B missing ${k}`);
      if (browserA.messageText(k) !== browserB.messageText(k)) {
        throw new Error(`final divergence at ${k}`);
      }
    }
    log(`  ✓ final set matches on both sides (${allKeys.length} messages)`);

    log('\nSTAGE 3 CHAT CONVERGENCE PASS — v1 delivers usable multi-user collaborative state');
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
