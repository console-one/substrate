/**
 * scripts/stage3-dual-editor-test.ts — Cut C:
 *
 *   Alice edits `tasks.ft` from a browser tab; Bob edits the same
 *   file from a Node client ("console"). Both see each other's
 *   edits in real time, both converge on the same content, and the
 *   Sequence's append-only log preserves "value at seq#x with
 *   these edits" structurally.
 *
 * The file is modeled as a single string at
 * `files.tasks.ft.content`. Each edit is a full overwrite at that
 * path (last-write-wins). This is NOT a merge/CRDT design — two
 * clients typing at once will clobber each other. That's a
 * deliberate first cut: prove the shared-mutable-state primitive
 * works end-to-end before designing a conflict model.
 *
 * Topology is the same five-Sequence shape used by the other
 * Stage-3 scripts:
 *
 *   browser-A  ─►  user-A session  ─►  org  ─►  user-B session  ─►  node-B
 *
 * Wire protocol: mutable payloads carry a `__MUT__\n` prefix both
 * uplink (client.mount with {mutable: true}) and downlink (server
 * emission cap wraps anything emitted under `files.*`). The
 * prefix strips the walker's literal-schema emission so successive
 * overwrites at the same path don't fail schema composition.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { JSDOM } from 'jsdom';
import NodeWebSocket from 'ws';
import { OfficeSpaceClient } from '../src/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const EDITOR_PATH = 'files.tasks.ft.content';

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

// Browser tab — loads the bundled browser entry in jsdom. The SAME
// binary runs in real Chrome (see stage3-browser-test.ts); jsdom is
// just a stand-in for CI.
class JsdomBrowser {
  readonly name: string;
  readonly dom: JSDOM;
  readonly officeSpace: any;
  private renderListeners: ((text: string) => void)[] = [];
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
        for (const l of this.renderListeners) l(this.latest);
      }
    });
  }

  async boot(user: string, serverUrl: string): Promise<void> {
    await this.officeSpace.boot({ user, serverUrl });
  }

  /** Write the editor's full content — mutable overwrite. */
  setContent(text: string): void {
    this.officeSpace.mount(`${EDITOR_PATH} = "${escapeForFt(text)}"`, { mutable: true });
  }

  /** Current editor content as the local Sequence sees it. Extracted
   *  from the hoist render — keeps the test closed over the same
   *  public surface a real UI uses. */
  readContent(): string | undefined {
    const re = new RegExp(`^${EDITOR_PATH.replace(/\./g, '\\.')}\\s*=\\s*"([^"]*)"`, 'm');
    const m = this.latest.match(re);
    return m ? m[1] : undefined;
  }

  waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(
        `[${this.name}] timeout: ${label} — current content: ${JSON.stringify(this.readContent())}`,
      )), timeoutMs);
      this.renderListeners.push(() => { if (predicate()) { clearTimeout(t); resolve(); } });
    });
  }

  close(): void { this.dom.window.close(); }
}

// "Console" — same OfficeSpaceClient the real CLI uses (console.ts),
// but without readline. Drives writes + reads through the public
// client API. Proves the dual-editor primitive doesn't depend on
// the browser bundle — any Sequence-node client can participate.
class NodeClient {
  readonly name: string;
  readonly client: OfficeSpaceClient;
  private dataDir: string;
  private latest: string | undefined;
  private listeners: (() => void)[] = [];

  constructor(name: string, user: string, serverUrl: string) {
    this.name = name;
    this.dataDir = mkdtempSync(join(tmpdir(), `office-space-${name}-`));
    this.client = new OfficeSpaceClient({
      dataDir: this.dataDir,
      serverUrl,
      user,
      env: 'console',
      heartbeatMs: 15_000,
      // Short reconnect window so the offline-replay test doesn't
      // spend 5s waiting for the default. In production this would
      // be 5s+ to avoid hammering a flapping server.
      reconnectMs: 500,
    });
    // Surface every Sequence change that touches the editor path.
    // Consumers poll via readContent() / waitFor() — listeners fire
    // when a new value lands (from server delta OR local mount).
    this.client.on((ev: any) => {
      if (ev.kind === 'render' || ev.kind === 'delta' || ev.kind === 'changes') {
        const next = this.client.get(EDITOR_PATH);
        if (typeof next === 'string') {
          this.latest = next;
          for (const l of this.listeners) l();
        }
      }
    });
  }

  async boot(): Promise<void> { await this.client.boot(); }

  setContent(text: string): void {
    this.client.mount(`${EDITOR_PATH} = "${escapeForFt(text)}"`, { mutable: true });
    // Local-write path doesn't fire handleServerMessage, so we
    // update latest ourselves.
    this.latest = text;
  }

  readContent(): string | undefined {
    const local = this.client.get(EDITOR_PATH);
    return typeof local === 'string' ? local : this.latest;
  }

  waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(
        `[${this.name}] timeout: ${label} — current content: ${JSON.stringify(this.readContent())}`,
      )), timeoutMs);
      this.listeners.push(() => { if (predicate()) { clearTimeout(t); resolve(); } });
    });
  }

  shutdown(): void {
    try { this.client.shutdown(); } catch {}
    try { rmSync(this.dataDir, { recursive: true, force: true }); } catch {}
  }

  /** Historical read — proves `getAt(path, seq)` returns the value
   *  as it was at that block seq. This is what "value at seq#x with
   *  these edits" means structurally: the Sequence preserves every
   *  overwrite in the append-only log even though projection-level
   *  reads see only the latest. */
  historyAt(seq: number): unknown {
    return (this.client as any).seq.getAt(EDITOR_PATH, seq);
  }
  currentSeq(): number {
    return (this.client as any).seq.head;
  }

  // ═══ OFFLINE-REPLAY TEST HOOKS ═════════════════════════════════
  // The client already handles disconnect+reconnect+buffer replay
  // as part of normal operation. These helpers just make the state
  // observable from the harness so we can assert the full loop.

  /** Force the ws to close without shutting down the client. This
   *  triggers the 'disconnected' event, clears heartbeat, and
   *  schedules an auto-reconnect after `reconnectMs`. Subsequent
   *  mounts queue in `pendingBuffer` with the __MUT__ prefix
   *  preserved — they replay on the next successful connect. */
  forceDisconnect(): void {
    const ws = (this.client as any).ws;
    if (ws) ws.close();
  }
  isConnected(): boolean {
    return !!(this.client as any).connected;
  }
  /** Number of buffered-but-unsent edits. Zero once connect()
   *  flushes them. */
  pendingCount(): number {
    return ((this.client as any).pendingBuffer ?? []).length;
  }
}

function escapeForFt(s: string): string {
  // ft text string literals: simple escape for " and \ and newlines.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

async function main(): Promise<number> {
  const log = (s: string) => process.stderr.write(`[harness] ${s}\n`);

  const bundlePath = join(REPO_ROOT, 'dist-web', 'bundle.js');
  let bundleSrc: string;
  try { bundleSrc = readFileSync(bundlePath, 'utf-8'); }
  catch { log(`ERROR: ${bundlePath} missing. Run \`node scripts/build-web.cjs\``); return 1; }

  const orgPort = 28965, userAPort = 28966, userBPort = 28967;

  log('spawning server tier (org + userA + userB)...');
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

  log('booting browser-A (alice) + node-B (bob)...');
  const browserA = new JsdomBrowser('browser-A', bundleSrc);
  await browserA.boot('alice', `ws://localhost:${userAPort}`);
  const nodeB = new NodeClient('node-B', 'bob', `ws://localhost:${userBPort}`);
  await nodeB.boot();
  // Give initial connection exchanges a moment to settle.
  await new Promise(r => setTimeout(r, 500));

  const cleanup = () => {
    try { browserA.close(); } catch {}
    try { nodeB.shutdown(); } catch {}
    for (const n of [userB, userA, org]) n.kill();
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    // ─── Test 1: alice → bob ────────────────────────────────────
    log('\n[test 1] alice writes, bob reads');
    browserA.setContent('first draft from alice');
    await nodeB.waitFor(() => nodeB.readContent() === 'first draft from alice', 8_000, 'bob sees alice v1');
    log('  ✓ bob received alice\'s edit');

    // ─── Test 2: bob → alice ────────────────────────────────────
    log('\n[test 2] bob writes, alice reads');
    nodeB.setContent('bob\'s revision');
    await browserA.waitFor(() => browserA.readContent() === 'bob\'s revision', 8_000, 'alice sees bob v1');
    log('  ✓ alice received bob\'s edit');

    // ─── Test 3: alternating edits ──────────────────────────────
    // Three round-trips with small waits so each full delta cycle
    // completes. Each iteration overwrites the shared path; both
    // sides must converge on the latest value.
    log('\n[test 3] alternating edits — three round-trips');
    for (let i = 1; i <= 3; i++) {
      const alice = `alice turn ${i}: lorem ipsum ${i}`;
      browserA.setContent(alice);
      await nodeB.waitFor(() => nodeB.readContent() === alice, 8_000, `bob sees alice turn ${i}`);
      await browserA.waitFor(() => browserA.readContent() === alice, 2_000, `alice echo turn ${i}`);

      const bob = `bob turn ${i}: dolor sit amet ${i}`;
      nodeB.setContent(bob);
      await browserA.waitFor(() => browserA.readContent() === bob, 8_000, `alice sees bob turn ${i}`);
      await nodeB.waitFor(() => nodeB.readContent() === bob, 2_000, `bob echo turn ${i}`);
    }
    log('  ✓ three full round-trips converged');

    // ─── Test 4: rapid fire (no waits between) ──────────────────
    // Last-write-wins: two rapid edits from the same side end with
    // BOTH sides reading the final value. No merge, no CRDT — the
    // guarantee is *convergence on the final state*, not no-loss
    // of intermediate values. Intermediate values ARE preserved in
    // the append-only log (see test 5).
    log('\n[test 4] rapid-fire edits from alice (LWW convergence)');
    browserA.setContent('rapid 1');
    browserA.setContent('rapid 2');
    browserA.setContent('rapid 3');
    browserA.setContent('rapid 4 — final');
    await nodeB.waitFor(() => nodeB.readContent() === 'rapid 4 — final', 10_000, 'bob sees rapid final');
    log('  ✓ bob sees final value after 4 rapid edits');

    // ─── Test 5: historical read via getAt ──────────────────────
    // "value at seq#x with these edits" — the spec phrasing. Bob's
    // local Sequence preserves every overwrite. Walking `getAt`
    // across seqs gives the content timeline.
    log('\n[test 5] historical read — getAt(path, seq) returns value at that seq');
    const headNow = nodeB.currentSeq();
    let historyHits = 0;
    let lastSeen: unknown = undefined;
    for (let s = headNow; s >= 1; s--) {
      const v = nodeB.historyAt(s);
      if (v !== undefined && v !== lastSeen) {
        historyHits += 1;
        lastSeen = v;
      }
    }
    // We've made at least 6 distinct edits at the path — 2 in test
    // 1-2, 6 in test 3, 4 in test 4 — some may coalesce via the
    // cascade, but we expect several distinct historical values.
    if (historyHits < 3) {
      throw new Error(`expected at least 3 distinct historical values at path; got ${historyHits}`);
    }
    log(`  ✓ ${historyHits} distinct historical values retrievable via getAt`);

    // ─── Test 6: disconnect + offline edit + reconnect ──────────
    // The brief: "On load of the user session, all offline changes
    // made to their file system (where sync is enabled with the
    // server), are immediately re-syncronized." This proves the
    // same shape at the ws level — client-side `pendingBuffer`
    // holds mutable-prefixed wire payloads while the ws is down,
    // then flushes on reconnect. Bob disconnects, makes edits
    // locally, reconnects, and Alice sees the catch-up.
    log('\n[test 6] offline edit + reconnect');
    // Baseline: both sides agree on the last value.
    const baseline = 'pre-disconnect: bob editing while online';
    nodeB.setContent(baseline);
    await browserA.waitFor(() => browserA.readContent() === baseline, 8_000, 'alice sees pre-disconnect');

    // Drop Bob's ws. pendingBuffer starts queuing any edit while
    // the scheduled reconnect timer is pending.
    nodeB.forceDisconnect();
    // Wait until the close event has propagated; `connected` flips
    // false on the event-loop tick after ws.close().
    for (let i = 0; i < 20 && nodeB.isConnected(); i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    if (nodeB.isConnected()) throw new Error('bob did not register disconnected state');
    log('  ✓ bob disconnected (ws closed; reconnect timer scheduled)');

    // Offline edits — three in a row. These land in bob's local
    // Sequence immediately and buffer for the server.
    nodeB.setContent('offline 1: scribbling while disconnected');
    nodeB.setContent('offline 2: overwriting my own draft');
    const finalOfflineValue = 'offline 3: this is the one alice should eventually see';
    nodeB.setContent(finalOfflineValue);

    if (nodeB.readContent() !== finalOfflineValue) {
      throw new Error(`bob's local state should reflect his own offline edit; got ${JSON.stringify(nodeB.readContent())}`);
    }
    if (nodeB.pendingCount() < 3) {
      throw new Error(`expected at least 3 buffered edits while offline; got ${nodeB.pendingCount()}`);
    }
    log(`  ✓ bob made ${nodeB.pendingCount()} offline edits (local state = "${nodeB.readContent()}")`);

    // Alice should not have seen the offline edits yet — they're
    // stuck in bob's pendingBuffer. Brief sanity wait to let any
    // in-flight delta settle before checking.
    await new Promise(r => setTimeout(r, 300));
    if (browserA.readContent() === finalOfflineValue) {
      throw new Error(`alice should not see bob's offline edit before bob reconnects; she has "${browserA.readContent()}"`);
    }
    log(`  ✓ alice's view is still "${browserA.readContent()}" (offline edits not propagated yet)`);

    // Wait for the auto-reconnect to land and flush. reconnectMs is
    // 500ms in the test config; bilateral handshake adds a little.
    for (let i = 0; i < 100 && !nodeB.isConnected(); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (!nodeB.isConnected()) throw new Error('bob failed to auto-reconnect');
    log('  ✓ bob reconnected');

    // After reconnect, pendingBuffer flushes in order. Alice sees
    // the FINAL offline value (intermediate values may coalesce
    // through the cascade but LWW guarantees the last wins).
    await browserA.waitFor(() => browserA.readContent() === finalOfflineValue, 10_000, 'alice sees offline final');
    if (nodeB.pendingCount() !== 0) {
      throw new Error(`pendingBuffer should be empty after reconnect flush; has ${nodeB.pendingCount()}`);
    }
    log('  ✓ alice received bob\'s final offline edit after reconnect');
    log('  ✓ pendingBuffer drained to zero');

    log('\nSTAGE 3 DUAL EDITOR PASS — Cut C + offline replay verified end-to-end');
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
