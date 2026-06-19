/**
 * scripts/stage3-workspace-primitives-test.ts — Cut B: UI-layer
 * primitives proven end-to-end.
 *
 * The workspace UI (ui.html) drives its three panels — file list,
 * selected-file editor, gaps — through three new browser-entry
 * exposures:
 *
 *   window.officeSpace.keys(prefix)  → string[]   (file list)
 *   window.officeSpace.get(path)      → unknown    (editor content)
 *   window.officeSpace.gaps()         → Gap[]      (obligations panel)
 *
 * This script proves those exposures see the shared state correctly
 * across the 5-Sequence topology, same shape as Cut C / offline-
 * replay tests. The CSS layer is separate — this is the API
 * contract the UI depends on.
 *
 * Topology:  browser-A  ─►  user-A  ─►  org  ◄─  user-B  ◄─  node-B
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

function escapeForFt(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

async function main(): Promise<number> {
  const log = (s: string) => process.stderr.write(`[harness] ${s}\n`);

  const bundlePath = join(REPO_ROOT, 'dist-web', 'bundle.js');
  let bundleSrc: string;
  try { bundleSrc = readFileSync(bundlePath, 'utf-8'); }
  catch { log(`ERROR: ${bundlePath} missing. Run \`node scripts/build-web.cjs\``); return 1; }

  const orgPort = 29065, userAPort = 29066, userBPort = 29067;

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
  const bobDir = mkdtempSync(join(tmpdir(), 'office-space-bob-'));
  const bob = new OfficeSpaceClient({
    dataDir: bobDir,
    serverUrl: `ws://localhost:${userBPort}`,
    user: 'bob',
    env: 'console',
    heartbeatMs: 15_000,
    reconnectMs: 500,
  });
  await bob.boot();
  await new Promise(r => setTimeout(r, 500));

  const cleanup = () => {
    try { browserA.close(); } catch {}
    try { bob.shutdown(); } catch {}
    try { rmSync(bobDir, { recursive: true, force: true }); } catch {}
    for (const n of [userB, userA, org]) n.kill();
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    // ─── Test 1: keys('files') sees multiple files ──────────────
    log('\n[test 1] officeSpace.keys("files") enumerates workspace files');
    // Bob mounts three files. Mutable mounts — the existing wire
    // wraps `files.*` emissions with __MUT__\n so alice's browser
    // receives without locking a literal schema.
    const files = ['notes', 'ideas', 'todo'];
    for (const f of files) {
      bob.mount(`files.${f}.content = "content of ${f}"`, { mutable: true });
    }
    await browserA.waitFor(() => {
      const keys = browserA.officeSpace.keys('files') as string[];
      return files.every(f => keys.includes(f));
    }, 8_000, 'alice sees all three files');
    const aliceKeys = (browserA.officeSpace.keys('files') as string[]).sort();
    log(`  ✓ alice.keys("files") = [${aliceKeys.join(', ')}]`);

    // ─── Test 2: get(path) returns the file contents ────────────
    log('\n[test 2] officeSpace.get returns current file content');
    for (const f of files) {
      const val = browserA.officeSpace.get(`files.${f}.content`);
      if (val !== `content of ${f}`) {
        throw new Error(`alice.get("files.${f}.content") = ${JSON.stringify(val)}; expected "content of ${f}"`);
      }
    }
    log(`  ✓ alice.get("files.{id}.content") returns bob's text for all three files`);

    // ─── Test 3: alice's edit round-trips through the topology ──
    log('\n[test 3] alice edits files.notes via the primitive API; bob sees it');
    const aliceEdit = 'alice adding a note at ' + new Date().toISOString();
    browserA.officeSpace.mount(
      `files.notes.content = "${escapeForFt(aliceEdit)}"`,
      { mutable: true },
    );
    // Poll bob's local Sequence. bob.get() reads the local
    // projection; wait until the delta arrives via downstream.
    const t0 = Date.now();
    while (Date.now() - t0 < 8_000) {
      if (bob.get('files.notes.content') === aliceEdit) break;
      await new Promise(r => setTimeout(r, 50));
    }
    if (bob.get('files.notes.content') !== aliceEdit) {
      throw new Error(`bob never saw alice's edit to files.notes.content`);
    }
    log(`  ✓ bob.get("files.notes.content") matches alice's edit`);

    // ─── Test 4: new file created at runtime shows up via keys ──
    log('\n[test 4] alice creates a new file; bob sees it in keys("files")');
    const newName = 'drafts';
    browserA.officeSpace.mount(
      `files.${newName}.content = "fresh"`,
      { mutable: true },
    );
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (bob.get(`files.${newName}.content`) === 'fresh') break;
      await new Promise(r => setTimeout(r, 50));
    }
    const bobSeq = (bob as any).seq;
    const bobFileKeys = bobSeq.keys('files') as string[];
    if (!bobFileKeys.includes(newName)) {
      throw new Error(`bob.keys("files") does not include new file "${newName}"; has: [${bobFileKeys.join(', ')}]`);
    }
    log(`  ✓ bob.keys("files") now includes "${newName}"`);

    // ─── Test 5: gaps() returns a well-typed array ──────────────
    // The UI calls officeSpace.gaps() on every render to populate
    // the right-hand panel. Verify the call returns an array of
    // {path, type, capabilities} — the shape the UI depends on —
    // without throwing. Proving actual gap surfacing through the
    // topology is a separate test (schema propagation policy is
    // NOT the same as value emission, so gaps declared on bob's
    // side don't automatically appear on alice's side; reader
    // contracts would be the right abstraction there, not a
    // primitives test).
    log('\n[test 5] officeSpace.gaps() returns a well-typed array');
    const aliceGaps = browserA.officeSpace.gaps();
    if (!Array.isArray(aliceGaps)) {
      throw new Error(`gaps() did not return an array; got ${typeof aliceGaps}`);
    }
    for (const g of aliceGaps) {
      if (typeof g.path !== 'string' || typeof g.type !== 'string' || !Array.isArray(g.capabilities)) {
        throw new Error(`malformed gap entry: ${JSON.stringify(g)}`);
      }
    }
    log(`  ✓ alice.gaps() is Array<{path, type, capabilities}> (${aliceGaps.length} entries)`);

    log('\nSTAGE 3 WORKSPACE PRIMITIVES PASS — Cut B: UI-layer API verified');
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
