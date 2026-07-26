/**
 * v2/client.ts — the offline-capable Office Space client ON THE v2
 * KERNEL (deletion-ledger stage 4; replaces sequenceutils/transport's
 * OfficeSpaceClient for every office-space consumer).
 *
 * Same product contract as v1, new carrier:
 *   · local kernel mirror, usable offline — mount() applies locally
 *     FIRST, then sends or buffers;
 *   · the buffer survives restarts (meta.json), flushes on connect;
 *   · local persistence is FT TEXT (snapshot.ft via the shared hoist)
 *     + meta.json for connection bookkeeping ONLY — no kernel state
 *     in JSON, ever (the snapshot-fttext contract);
 *   · reconnect on a fixed timer; heartbeat keeps the session active;
 *   · scheduled facts are SUSPENDED BLOCKS (where: gt('_rt', T)) —
 *     planned() reads the kernel's own suspension log, no `.fireAt`
 *     sidecar convention (the planned-from-suspended contract).
 *
 * The wire is ft text both ways. Server deltas apply through
 * receiveDocument; `-- error:` lines surface as error events.
 */

import {
  Sequence, receiveDocument, hoist, advanceClock,
} from '@console-one/sequence/v2';
import type { IStorage } from '@console-one/sequence/v2';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

/** Minimal WebSocket shape — intersection of browser WebSocket and the
 *  Node `ws` package's DOM-compat surface. */
export interface IWebSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown; message?: string }) => void,
  ): void;
}

export type WebSocketCtor = new (url: string) => IWebSocket;

export type ClientEvent =
  | { kind: 'connected' }
  | { kind: 'disconnected' }
  | { kind: 'render'; text: string }
  | { kind: 'delta'; text: string }
  | { kind: 'changes'; changes: unknown[] }
  | { kind: 'error'; message: string };

export interface ClientConfig {
  /** Local state directory (Node persistence). Ignored when
   *  `persistence` is injected. */
  dataDir: string;
  serverUrl: string;
  user: string;
  env: string;
  heartbeatMs?: number;
  reconnectMs?: number;
  /** WebSocket constructor. Default: the Node `ws` package. */
  transport?: WebSocketCtor;
  /** Snapshot/meta persistence backend (browser: BrowserStorage). */
  persistence?: IStorage;
  /** Pre-constructed kernel (composition mode) — snapshot loading and
   *  saving are skipped unless `persistence` is also given. */
  seq?: Sequence;
}

type Meta = { lastServerSeq: number; pendingBuffer: string[]; savedAt: number };

type WhereConstraint = { op: string; args: unknown[] };

export class OfficeSpaceClient {
  readonly seq: Sequence;
  private config: ClientConfig;
  private transportCtor: WebSocketCtor | null;
  private persistence: IStorage | undefined;
  private ws: IWebSocket | null = null;
  private connected = false;
  private booted = false;
  private ownsPersistence: boolean;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastServerSeq = 0;
  private pendingBuffer: string[] = [];
  private handlers: Array<(event: ClientEvent) => void> = [];
  private shuttingDown = false;

  get isConnected(): boolean { return this.connected; }

  constructor(config: ClientConfig) {
    this.config = config;
    this.seq = config.seq ?? new Sequence(() => Date.now());
    this.persistence = config.persistence;
    // Composition mode without explicit persistence: the caller owns
    // the kernel's state — never write it into a client-shaped
    // snapshot (v1 rule, kept).
    this.ownsPersistence = config.seq === undefined || config.persistence !== undefined;
    this.transportCtor = config.transport ?? null;
  }

  on(cb: (event: ClientEvent) => void): () => void {
    this.handlers.push(cb);
    return () => { this.handlers = this.handlers.filter((h) => h !== cb); };
  }

  private emit(event: ClientEvent): void {
    for (const h of [...this.handlers]) h(event);
  }

  // ── persistence: snapshot.ft (state) + meta.json (bookkeeping) ────

  private async readKey(key: string): Promise<string | null> {
    if (this.persistence) {
      try { return (await this.persistence.has(key)) ? await this.persistence.read(key) : null; }
      catch { return null; }
    }
    const p = join(this.config.dataDir, key);
    try { return existsSync(p) ? readFileSync(p, 'utf-8') : null; } catch { return null; }
  }

  private writeKey(key: string, data: string): void {
    if (this.persistence) {
      void this.persistence.write(key, data).catch(() => { /* offline-tolerant */ });
      return;
    }
    try {
      mkdirSync(this.config.dataDir, { recursive: true });
      writeFileSync(join(this.config.dataDir, key), data);
    } catch { /* offline-tolerant */ }
  }

  private saveState(): void {
    if (!this.ownsPersistence) return;
    this.writeKey('snapshot.ft', hoist(this.seq, { depth: 10 }).text);
    const meta: Meta = {
      lastServerSeq: this.lastServerSeq,
      pendingBuffer: this.pendingBuffer,
      savedAt: Date.now(),
    };
    this.writeKey('meta.json', JSON.stringify(meta));
  }

  private async loadState(): Promise<void> {
    if (!this.ownsPersistence || this.config.seq !== undefined) {
      // Injected kernel: caller owns state; only bookkeeping loads.
    } else {
      const snapshot = await this.readKey('snapshot.ft');
      if (snapshot) await receiveDocument(this.seq, snapshot);
    }
    const metaRaw = await this.readKey('meta.json');
    if (metaRaw) {
      try {
        const meta = JSON.parse(metaRaw) as Partial<Meta>;
        if (typeof meta.lastServerSeq === 'number') this.lastServerSeq = meta.lastServerSeq;
        if (Array.isArray(meta.pendingBuffer)) this.pendingBuffer = meta.pendingBuffer as string[];
      } catch { /* corrupt meta is bookkeeping only — start clean */ }
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    await this.loadState();
    if (!this.transportCtor) {
      // Dynamic import keeps this module browser-loadable when a
      // transport is injected (browser env passes window.WebSocket) —
      // and works under ESM, where require() does not exist.
      const mod = await import('ws') as { default?: WebSocketCtor };
      this.transportCtor = (mod.default ?? mod) as WebSocketCtor;
    }
    this.emit({ kind: 'render', text: hoist(this.seq, { depth: 10 }).text });
    this.connect();
  }

  private connect(): void {
    if (this.shuttingDown || !this.transportCtor) return;
    let ws: IWebSocket;
    try {
      ws = new this.transportCtor(this.config.serverUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this.emit({ kind: 'connected' });
      const u = this.config.user;
      this.sendRaw([
        `sessions.${u}.user = ${JSON.stringify(u)}`,
        `sessions.${u}.env = ${JSON.stringify(this.config.env)}`,
        `sessions.${u}.heartbeat = ${Date.now()}`,
      ].join('\n'));
      const buffered = [...this.pendingBuffer];
      this.pendingBuffer = [];
      for (const payload of buffered) this.sendRaw(payload);
      this.saveState();
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        this.sendRaw(`sessions.${u}.heartbeat = ${Date.now()}`);
      }, this.config.heartbeatMs ?? 15_000);
    });

    ws.addEventListener('message', (event) => {
      void (async () => {
        const text = String(event.data ?? '');
        try {
          await this.applyServerText(text);
        } catch (e) {
          this.emit({ kind: 'error', message: (e as Error).message });
        }
      })();
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
      this.emit({ kind: 'disconnected' });
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => { /* close follows; reconnect there */ });
  }

  private async applyServerText(text: string): Promise<void> {
    let body = text;
    if (body.startsWith('__MUT__\n')) body = body.slice('__MUT__\n'.length);
    const loadBearing = body.split('\n').some((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('--');
    });
    if (loadBearing) {
      await receiveDocument(this.seq, body);
      this.emit({ kind: 'delta', text: body });
      this.emit({ kind: 'render', text: hoist(this.seq, { depth: 10 }).text });
      this.saveState();
    } else {
      const err = body.split('\n').find((l) => l.trim().startsWith('-- error:'));
      if (err) this.emit({ kind: 'error', message: err.trim().slice('-- error:'.length).trim() });
    }
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.config.reconnectMs ?? 5_000);
  }

  private sendRaw(payload: string): void {
    if (this.connected && this.ws && this.ws.readyState === 1) {
      this.ws.send(payload);
    } else {
      this.pendingBuffer.push(payload);
      this.saveState();
    }
  }

  // ── the write surface ─────────────────────────────────────────────

  /** Apply ft text locally, then send upstream (or buffer offline). */
  async mount(ftText: string): Promise<{ applied: number; errors: string[] }> {
    const r = await receiveDocument(this.seq, ftText, { author: this.config.user });
    this.emit({ kind: 'changes', changes: [{ applied: r.applied, errors: r.errors }] });
    this.sendRaw(ftText);
    this.saveState();
    return { applied: r.applied, errors: r.errors };
  }

  /** Send upstream WITHOUT applying locally (peer-propagation path —
   *  the caller already holds the state in a shared kernel). */
  forward(ftText: string): void {
    this.sendRaw(ftText);
  }

  /**
   * Mount a structured block, optionally gated on `where` constraints.
   * A future-gated block (`where: [{op:'gt', args:['_rt', T]}]`)
   * SUSPENDS in the kernel until the clock passes T — the substrate's
   * own scheduled-fact primitive; planned() reads exactly these.
   */
  mountBlock(opts: {
    entries: Array<{ path: string; value: unknown }>;
    where?: WhereConstraint[];
  }): { ok: boolean; suspended: boolean } {
    let suspended = false;
    for (const entry of opts.entries) {
      const r = this.seq.insert({
        path: entry.path,
        value: entry.value,
        where: opts.where as never,
        author: this.config.user,
      });
      suspended = suspended || r.suspended;
    }
    this.saveState();
    return { ok: true, suspended };
  }

  /** Advance the local clock (`_rt`) — resumes any due suspended
   *  blocks. Hosts call this on their tick; tests call it directly. */
  advanceClock(t: number): void {
    advanceClock(this.seq, t);
  }

  // ── the read surface ──────────────────────────────────────────────

  get(path: string): unknown { return this.seq.get(path); }
  keys(prefix?: string): string[] { return this.seq.keys(prefix); }

  /** Scheduled facts: suspended blocks whose `where` carries a future
   *  `gt('_rt', T)` bound, sorted by fire time. No sidecar field is
   *  consulted — the kernel's suspension log IS the schedule. */
  planned(opts: { scopePrefix?: string } = {}): Array<{ path: string; fireAt: number; msUntil: number }> {
    // The kernel's own clock decides what is still pending: a fired
    // retry leaves the ORIGINAL block suspended in the append-only log,
    // so "planned" = suspended schedule entries whose bound is still
    // ahead of `_rt` (falling back to wall time when no clock mounted).
    const rt = this.seq.getCell('_rt')?.value;
    const now = typeof rt === 'number' ? rt : Date.now();
    const out: Array<{ path: string; fireAt: number; msUntil: number }> = [];
    for (const cell of this.seq.cells()) {
      for (const block of cell.blocks) {
        if (block.status !== 'suspended') continue;
        for (const w of block.where ?? []) {
          if (w.op !== 'gt') continue;
          const [lhs, rhs] = w.args as [unknown, unknown];
          if (lhs !== '_rt' || typeof rhs !== 'number') continue;
          if (rhs <= now) continue; // bound passed — fired or forfeit
          const path = block.coord.path;
          if (opts.scopePrefix && path !== opts.scopePrefix && !path.startsWith(opts.scopePrefix + '.')) continue;
          out.push({ path, fireAt: rhs, msUntil: rhs - now });
        }
      }
    }
    out.sort((a, b) => a.fireAt - b.fireAt);
    return out;
  }

  // ── shutdown ──────────────────────────────────────────────────────

  shutdown(): void {
    this.shuttingDown = true;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.saveState();
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
    this.connected = false;
  }
}
