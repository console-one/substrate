/**
 * scripts/stage3-browser-test.ts — Stage 3 five-Sequence coherence
 * with REAL browser bundles at the leaves.
 *
 * Identical topology to stage3-five-sequence-test.ts, but the two
 * "browsers" are now jsdom-hosted instances of the esbuild-bundled
 * `src/browser-entry.ts`. jsdom gives us `window`, `WebSocket`,
 * `indexedDB`, and DOM; the bundle registers `window.officeSpace`
 * exactly as it would in a real tab; we drive it through that API.
 *
 *   Browser A  ─►  User A Session  ─►  Org  ─►  User B Session  ─►  Browser B
 *   (jsdom+bundle)  (run-node)         (run-node)    (run-node)     (jsdom+bundle)
 *
 * This closes the loop on the v1 deliverable: the Node stand-ins in
 * the earlier stage3 test become the actual runtime artifact that
 * ships in a browser. If this passes, a real Chrome tab loading the
 * same bundle will behave identically.
 *
 * What jsdom does NOT give us: a real JS engine sandbox, real
 * storage persistence (BrowserStorage uses its MemoryBackend when
 * `indexedDB` isn't available — we feed it one via jsdom), or HTTP/WS
 * hosts. For WebSocket we inject the `ws` Node package as
 * `global.WebSocket` inside the jsdom window.
 *
 * Exit code:
 *   0 — mounts originating in one jsdom-hosted browser propagate to
 *       the other through four bilateral links
 *   1 — timeout / mismatch / loop
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
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk: string) => {
      process.stderr.write(`[${name}:stderr] ${chunk}`);
    });
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

  on(cb: (ev: Event) => void): void { this.listeners.push(cb); }
  wait(p: (ev: Event) => boolean, timeoutMs: number, label: string): Promise<Event> {
    const hit = this.events.find(p);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`[${this.name}] timeout: ${label}`)), timeoutMs);
      this.listeners.push(function handler(ev) {
        if (p(ev)) { clearTimeout(t); resolve(ev); }
      });
    });
  }
  kill(): void { try { this.proc.kill('SIGTERM'); } catch {} }
}

// ─── jsdom-hosted browser ────────────────────────────────────────
// Loads the esbuild bundle into a fresh jsdom window, wires up
// WebSocket (Node ws) and exposes window.officeSpace to the test.

class JsdomBrowser {
  readonly name: string;
  readonly dom: JSDOM;
  readonly officeSpace: any;
  private renderListeners: ((text: string) => void)[] = [];
  private latestRender = '';

  constructor(name: string, bundleSrc: string) {
    this.name = name;
    this.dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'http://localhost/',
      runScripts: 'outside-only',
    });
    const w = this.dom.window as any;
    // Inject a WebSocket impl — jsdom doesn't ship one.
    w.WebSocket = NodeWebSocket;
    // Execute the bundle INSIDE the jsdom VM context, so `window`
    // resolves to the jsdom window and the bundle's IIFE registers
    // `window.officeSpace` on that window.
    this.dom.window.eval(bundleSrc);
    this.officeSpace = w.officeSpace;
    if (!this.officeSpace) {
      throw new Error(`[${name}] bundle did not register window.officeSpace`);
    }
    this.officeSpace.on((ev: any) => {
      if (ev.kind === 'render' || ev.kind === 'delta') {
        this.latestRender = this.officeSpace.render();
        for (const l of this.renderListeners) l(this.latestRender);
      }
    });
  }

  async boot(user: string, serverUrl: string): Promise<void> {
    await this.officeSpace.boot({ user, serverUrl });
  }

  mount(ftText: string): void {
    this.officeSpace.mount(ftText);
  }

  render(): string {
    return this.officeSpace.render();
  }

  waitForValue(path: string, value: string, timeoutMs: number): Promise<void> {
    const check = (text: string) => {
      // Exact-substring check on the hoist output. ft-text format:
      //   path = "string"   or   path = number.
      const needle = `${path} = ${JSON.stringify(value)}`;
      return text.includes(needle);
    };
    if (check(this.latestRender)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(
          `[${this.name}] timeout waiting for ${path}=${value}\n` +
          `latest render was:\n${this.latestRender}`,
        ));
      }, timeoutMs);
      this.renderListeners.push((text) => {
        if (check(text)) { clearTimeout(t); resolve(); }
      });
    });
  }

  close(): void { this.dom.window.close(); }
}

async function main(): Promise<number> {
  const log = (s: string) => process.stderr.write(`[harness] ${s}\n`);

  const bundlePath = join(REPO_ROOT, 'dist-web', 'bundle.js');
  let bundleSrc: string;
  try {
    bundleSrc = readFileSync(bundlePath, 'utf-8');
  } catch {
    log(`ERROR: ${bundlePath} not found. Run \`npm run build:web\` first.`);
    return 1;
  }
  log(`loaded bundle (${bundleSrc.length} bytes)`);

  const orgPort = 28765, userAPort = 28766, userBPort = 28767;

  log('spawning org...');
  const org = new ServerProcess('org', ['--identity', 'org', '--listen', String(orgPort)]);
  await org.wait(ev => ev.kind === 'ready', 10_000, 'org');

  log('spawning user-A...');
  const userA = new ServerProcess('user-A',
    ['--identity', 'userA', '--listen', String(userAPort),
     '--upstream', `ws://localhost:${orgPort}`]);
  await userA.wait(ev => ev.kind === 'ready', 10_000, 'user-A');
  await userA.wait(ev => ev.kind === 'upstream-connected', 10_000, 'user-A↔org');

  log('spawning user-B...');
  const userB = new ServerProcess('user-B',
    ['--identity', 'userB', '--listen', String(userBPort),
     '--upstream', `ws://localhost:${orgPort}`]);
  await userB.wait(ev => ev.kind === 'ready', 10_000, 'user-B');
  await userB.wait(ev => ev.kind === 'upstream-connected', 10_000, 'user-B↔org');

  log('booting jsdom browser-A (bundle → window.officeSpace)...');
  const browserA = new JsdomBrowser('browser-A', bundleSrc);
  await browserA.boot('alice', `ws://localhost:${userAPort}`);
  log('  ✓ browser-A.officeSpace.boot resolved');

  log('booting jsdom browser-B...');
  const browserB = new JsdomBrowser('browser-B', bundleSrc);
  await browserB.boot('bob', `ws://localhost:${userBPort}`);
  log('  ✓ browser-B.officeSpace.boot resolved');

  // Give the clients a moment to complete connect handshake + initial
  // hoist exchange before driving mounts.
  await new Promise(r => setTimeout(r, 500));

  const cleanup = () => {
    try { browserA.close(); } catch {}
    try { browserB.close(); } catch {}
    for (const n of [userB, userA, org]) n.kill();
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    log('\n[test] real browser bundle: A mounts → B sees it');
    browserA.mount('chat.room1.msg = "hi from alice (bundle)"');
    await browserB.waitForValue('chat.room1.msg', 'hi from alice (bundle)', 8_000);
    log('  ✓ chat.room1.msg reached browser-B through four bilateral links');

    log('\n[test] reverse: B mounts → A sees it');
    browserB.mount('chat.room1.reply = "hi back from bob (bundle)"');
    await browserA.waitForValue('chat.room1.reply', 'hi back from bob (bundle)', 8_000);
    log('  ✓ chat.room1.reply reached browser-A through four bilateral links');

    log('\nSTAGE 3 (real browsers) PASS — v1 deliverable is live end-to-end');
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
