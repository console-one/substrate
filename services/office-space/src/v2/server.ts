/**
 * v2/server.ts — the Office Space server ON THE v2 KERNEL.
 *
 * Deletion-ledger STAGE 4: this replaces consumption of
 * `@console-one/sequenceutils/transport`'s ContextGraphServer (v1
 * kernel, ~994 lines whose own header prescribed this exact shape:
 * "the server should be a WebSocket-to-kernel ROUTER … transport
 * plumbing, not 700 lines of lifecycle").
 *
 * Everything lifecycle-shaped lives in the KERNEL as rules-as-data,
 * installed at boot from `@console-one/sequence/v2` — nothing here is
 * a scheduling loop:
 *
 *   · writer authority   → installWriterAuthority('sessions', 1)
 *   · session lifecycle  → installSessionLifecycle (active/idle/expired
 *                          re-projected on `_rt` advance — the tick
 *                          only mounts the clock)
 *   · holder release     → installHolderRelease (disconnectedAt fact →
 *                          holder cleared, pure event calculus)
 *   · auth tokens        → installAuthCaps (HMAC mint/validate tools,
 *                          secret at id.server.token_secret)
 *   · broadcast          → installCrossSequence (observation rule:
 *                          every local non-`_` value delta → one ft
 *                          line to every connected client, author
 *                          preserved)
 *
 * What REMAINS here is genuinely transport (the faculty an office may
 * add without augmenting the kernel — MAP-ELECTED-FRAME §5): socket
 * accept/close, connection identity (`id.sessions.{clientId}`), the
 * welcome hoist, session-holder/token STAMPING (pure translation: the
 * kernel cannot know which socket carried a message), the ft journal
 * (persistence), and two HTTP routes for the browser shell.
 *
 * THE WIRE IS FT TEXT — the one language, both directions. Inbound
 * documents apply through receiveDocument with the connection's
 * identity as AUTHOR (writer authority judges the real author).
 * Errors return as `-- error: …` courtesy lines, never load-bearing.
 * The v1 `__MUT__` sentinel is accepted and stripped for wire compat;
 * v2 value binds are last-write-wins, so it carries no meaning here.
 */

import { createServer, type Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import {
  Sequence, receiveDocument, hoist,
  installStdLib, registerBaseTools, installAuthCaps,
  installWriterAuthority, installSessionLifecycle, installHolderRelease,
  installCrossSequence, advanceClock, mintSessionToken,
  restoreSnapshot, NodeStorage, renderFactValue,
  partitionOf, PARTITION_PERSISTENCE,
} from '@console-one/sequence/v2';
import type { IStorage, SnapshotEntry } from '@console-one/sequence/v2';

/** Externally-supplied boot state (same three shapes as v1):
 *  ft text (canonical, round-trippable), a file path to ft text, or a
 *  SnapshotEntry[] replay log (skips the DSL, fastest cold start). */
export type PriorSnapshot =
  | { kind: 'ft'; text: string }
  | { kind: 'ftPath'; path: string }
  | { kind: 'entries'; entries: SnapshotEntry[] };

export interface ServerConfig {
  /** Listen port. 0 = ephemeral (tests); start() resolves the real one. */
  port: number;
  /** Base path for the ft journal (`{dbPath}.ft`). Omit for in-memory. */
  dbPath?: string;
  /** Trusted filesystem root for the fs.* tool family. */
  workspaceRoot?: string;
  /** Preconstructed IStorage — takes precedence over workspaceRoot. */
  storage?: IStorage;
  /** Session token secret; omitted → fresh random per boot (tokens
   *  then don't survive restart — pass explicitly for stable tokens). */
  tokenSecret?: string;
  /** Default session token lifetime (ms). Default 24h. */
  sessionTokenTtlMs?: number;
  /** Optional pre-constructed kernel (composition primitive — caller
   *  owns its state; journal replay is skipped). */
  seq?: Sequence;
  priorSnapshot?: PriorSnapshot;
  /** Called after boot installs + state replay, before the socket
   *  starts accepting. Register product rules/tools here. */
  register?: (seq: Sequence) => void;
  /** Called once per tick, after the clock advance. */
  onTick?: (seq: Sequence) => void;
  /** Session lifecycle windows (ms) — see installSessionLifecycle. */
  activeWindowMs?: number;
  expiryWindowMs?: number;
}

/** One ft-text delta line. Values only — types travel in full documents
 *  (vend/hoist), not the delta stream, same as the v1 emission tool.
 *  Rendered with the kernel's own fact grammar so every line is
 *  receivable (JSON's quoted keys are not). */
function ftLine(path: string, value: unknown): string {
  return `${path} = ${renderFactValue(value)}`;
}

let clientCounter = 0;

export class ContextGraphServer {
  private config: ServerConfig;
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private clients = new Map<string, WebSocket>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private journalPath: string | null = null;
  /** The kernel. Public read; null after stop(). */
  seq: Sequence | null = null;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  async start(): Promise<number> {
    const config = this.config;
    const storage = config.storage ?? new NodeStorage(
      config.workspaceRoot ?? `${process.cwd()}/workspace`,
    );

    // ── resolve external boot state FIRST — an unreadable ftPath must
    //    reject before any socket opens (v1 contract) ────────────────
    let external: PriorSnapshot | undefined = config.priorSnapshot;
    if (external?.kind === 'ftPath') {
      const ftPath = external.path;
      try {
        external = { kind: 'ft', text: readFileSync(ftPath, 'utf-8') };
      } catch {
        throw new Error(`priorSnapshot ftPath '${ftPath}' unreadable`);
      }
    }

    // ── the kernel + its constitution (rules as data, no bootstrap.ft
    //    parsing — the v2 boot INSTALLS what v1 parsed) ───────────────
    const injected = config.seq !== undefined;
    const seq = config.seq ?? new Sequence(() => Date.now());
    this.seq = seq;
    installStdLib(seq);
    installWriterAuthority(seq, { scope: 'sessions', ownerSegmentIndex: 1 });
    installSessionLifecycle(seq, {
      activeWindowMs: config.activeWindowMs,
      expiryWindowMs: config.expiryWindowMs,
    });
    installHolderRelease(seq);
    installAuthCaps(seq, config.tokenSecret !== undefined ? { secret: config.tokenSecret } : {});
    registerBaseTools(seq, { storage });
    advanceClock(seq, seq.now());
    config.register?.(seq);

    // ── state recovery: external snapshot WINS over the local journal
    //    (v1 contract); both replay on top of the installed boot ─────
    this.journalPath = !injected && config.dbPath ? `${config.dbPath}.ft` : null;
    if (external) {
      if (external.kind === 'ft') await receiveDocument(seq, external.text);
      else restoreSnapshot(seq, external);
    } else if (this.journalPath && existsSync(this.journalPath)) {
      await receiveDocument(seq, readFileSync(this.journalPath, 'utf-8'));
    }

    // ── the persistence posture, READABLE: what kind of store, where,
    //    whether it's live, and which partitions owe persistence — all
    //    facts, same contract the v1 server exposed ───────────────────
    seq.insert({ path: '_storage.tool.type', value: this.journalPath ? 'ft-journal' : 'memory' });
    if (this.journalPath) seq.insert({ path: '_storage.tool.path', value: this.journalPath });
    seq.insert({ path: '_storage.tool.status', value: 'available' });
    for (const [partition, persistence] of Object.entries(PARTITION_PERSISTENCE)) {
      seq.insert({ path: `_partitions.${partition}.persistence`, value: persistence });
    }

    // ── broadcast + journal: ONE observation rule (installCrossSequence)
    //    carries both — every local non-`_` value delta becomes an ft
    //    line sent to every client and appended to the journal when its
    //    partition persists. Degradation is LOUD: an owed write that
    //    cannot land becomes a `_storage.gaps.*` fact, never a silent
    //    drop (v1 contract, kept) ───────────────────────────────────────
    installCrossSequence(seq, 'id.server', (delta) => {
      if (delta.value === undefined && delta.type !== undefined) return; // types travel in documents
      const line = ftLine(delta.path, delta.value);
      for (const ws of this.clients.values()) {
        if (ws.readyState === WebSocket.OPEN) ws.send(line);
      }
      if (this.journalPath && !delta.path.startsWith('sessions.')) {
        // sessions.* is connection-lived: the lifecycle classes re-derive
        // status/holder from live heartbeats, and replaying a dead boot's
        // holder would lock the next client out until expiry. Everything
        // else journals per its partition's declared persistence.
        const partition = partitionOf(delta.path, seq.rawTypeAt(delta.path));
        if (PARTITION_PERSISTENCE[partition] !== 'never') {
          const gap = (reason: string): void => {
            seq.insert({
              path: `_storage.gaps.${seq.nextSequence()}`,
              value: { paths: [delta.path], reason, time: seq.now() },
            });
          };
          if (seq.getCell('_storage.tool.status')?.value !== 'available') {
            gap('storage unavailable');
          } else {
            try {
              appendFileSync(this.journalPath, line + '\n');
            } catch (e) {
              seq.insert({ path: '_storage.tool.status', value: 'degraded' });
              gap((e as Error).message);
            }
          }
        }
      }
    });
    if (this.journalPath && !existsSync(dirname(this.journalPath))) {
      mkdirSync(dirname(this.journalPath), { recursive: true });
    }

    // ── HTTP shell (browser UI) + the WebSocket wire ─────────────────
    this.httpServer = createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        for (const candidate of [
          join(process.cwd(), 'src', 'ui.html'),
          join(process.cwd(), 'ui.html'),
        ]) {
          try {
            const html = readFileSync(candidate, 'utf-8');
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(html);
            return;
          } catch { /* next candidate */ }
        }
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws) => {
      // Underscores, not hyphens: the ft DSL reads `-` as subtraction.
      const clientId = `c_${Date.now()}_${(clientCounter++).toString(36)}`;
      const identityPath = `id.sessions.${clientId}`;
      this.clients.set(clientId, ws);
      seq.insert({ path: `${identityPath}.connectedAt`, value: seq.now(), author: identityPath });
      seq.insert({ path: `${identityPath}.transport`, value: 'websocket', author: identityPath });

      // The welcome hoist: full current state as ft, immediately.
      ws.send(hoist(seq, { depth: 10 }).text);

      ws.on('message', (data) => {
        void (async () => {
          let body = data.toString();
          if (body.startsWith('__MUT__\n')) body = body.slice('__MUT__\n'.length);
          try {
            const r = await receiveDocument(seq, body, { author: identityPath });
            this.stampSessions(seq, body, identityPath);
            for (const err of r.errors) ws.send(`-- error: ${err}`);
          } catch (e) {
            ws.send(`-- error: ${(e as Error).message}`);
          }
        })();
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
        // The FACT is the disconnect; holder release is the kernel's
        // holderRelease class reacting to it — no imperative cleanup.
        seq.insert({ path: `${identityPath}.disconnectedAt`, value: seq.now(), author: identityPath });
      });
    });

    this.tickTimer = setInterval(() => {
      if (!this.seq) return;
      advanceClock(this.seq, this.seq.now());
      config.onTick?.(this.seq);
    }, 1000);

    return new Promise((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(config.port, () => {
        const addr = this.httpServer!.address();
        resolve(typeof addr === 'object' && addr ? addr.port : config.port);
      });
    });
  }

  /**
   * Session stamping — PURE TRANSLATION (v1's own doc words): the
   * kernel cannot know which socket carried a message, so the server
   * writes that fact down. For each `sessions.{user}` the document
   * touched: stamp the holder (first claim / rightful writer / expired
   * takeover — the same conditions writer-authority enforces on the
   * insert itself, so a wrongful stamp simply never applies) and mint
   * a session token when identity-bearing fields were written.
   */
  private stampSessions(seq: Sequence, body: string, identityPath: string): void {
    const users = new Set<string>();
    const tokenUsers = new Set<string>();
    for (const line of body.split('\n')) {
      const m = /^sessions\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\s*=/.exec(line.trim());
      if (!m) continue;
      users.add(m[1]);
      if (m[2] === 'user' || m[2] === 'tokenExpiry') tokenUsers.add(m[1]);
    }
    for (const user of users) {
      const holder = seq.getCell(`sessions.${user}.holder`)?.value;
      const status = seq.getCell(`sessions.${user}.status`)?.value;
      if (holder === undefined || holder === identityPath || status === 'expired') {
        seq.insert({ path: `sessions.${user}.holder`, value: identityPath, author: identityPath });
      }
    }
    for (const user of tokenUsers) {
      if (seq.getCell(`sessions.${user}.holder`)?.value !== identityPath) continue;
      const secret = seq.getCell('id.server.token_secret')?.value as string | undefined;
      if (secret === undefined) continue;
      const declared = seq.getCell(`sessions.${user}.tokenExpiry`)?.value;
      const expiresAt = typeof declared === 'number' && declared > seq.now()
        ? declared
        : seq.now() + (this.config.sessionTokenTtlMs ?? 86_400_000);
      seq.insert({
        path: `sessions.${user}.token`,
        value: mintSessionToken(user, expiresAt, secret),
        author: identityPath,
      });
    }
  }

  async stop(): Promise<void> {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    for (const ws of this.clients.values()) ws.terminate();
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
      // Terminated sockets can hold close() open briefly; the server
      // is already unreachable, so don't wait on stragglers.
      setTimeout(resolve, 250).unref?.();
    });
    this.wss = null;
    this.httpServer = null;
    this.seq = null;
  }
}
