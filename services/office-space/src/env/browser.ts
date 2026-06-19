/**
 * env/browser.ts — Browser env adapter.
 *
 * Mirrors the Unix env shape but runs inside a browser page
 * instead of a Node process. Two things differ:
 *
 *   1. **Storage** is `BrowserStorage` (IndexedDB or in-memory stub)
 *      instead of `NodeStorage` (filesystem). Same IStorage contract,
 *      same trusted-prefix policy, same read-cache semantics —
 *      everything above the backend is identical.
 *
 *   2. **Transport** is the native browser `WebSocket` global
 *      instead of Node's `ws` package. Wired through the
 *      `transport?: WebSocketCtor` injection point on
 *      `OfficeSpaceClient.ClientConfig`, so the client itself
 *      doesn't branch on environment — it just accepts whatever
 *      ws constructor is passed.
 *
 * The env exposes a `BrowserEnvHandle` matching the Unix / Docker
 * / Lambda shape: `{ client, storage, shutdown, on }`. Callers
 * (a React hook, a vanilla page, a test harness) drive it
 * uniformly.
 *
 * There's no PID file (browsers have no process concept) and no
 * signal handlers. Shutdown is driven by page lifecycle:
 * `beforeunload` in real deployments, explicit `handle.shutdown()`
 * in tests.
 *
 * The default behavior is to let `OfficeSpaceClient` auto-detect
 * its transport. For real browser use, pass `transport: WebSocket`
 * from the caller (because this module itself doesn't import a
 * browser global — it needs to stay Node-loadable for tests).
 */

import { OfficeSpaceClient } from '@console-one/sequenceutils/transport';
import type { ClientEvent, WebSocketCtor } from '@console-one/sequenceutils/transport';
import { BrowserStorage } from '@console-one/sequenceutils/transport';
import type { BrowserStorageConfig } from '@console-one/sequenceutils/transport';
import { registerStdlibPanels } from '@console-one/sequenceutils/transport';

export interface BrowserEnvConfig {
  /** Logical user identity this env holds a session for. */
  user: string;
  /** WebSocket URL of the Office Space server. */
  serverUrl: string;
  /** IndexedDB database name. Defaults to `office-space-{user}`
   *  so concurrent envs for different users don't collide. */
  dbName?: string;
  /** Trusted-prefix root for workspace keys. Defaults to
   *  `workspace` so app data is segregated from any client
   *  metadata the env might store later under a sibling prefix. */
  workspaceRoot?: string;
  /** Heartbeat interval ms. Defaults to 15000 — shorter than the
   *  server's 30s active-session window so the session stays
   *  `status = active`. */
  heartbeatMs?: number;
  /** Reconnect backoff ms on disconnect. */
  reconnectMs?: number;
  /** WebSocket constructor. Production callers pass `WebSocket`
   *  (the browser global). Tests pass an in-process stub that
   *  pipes to a real server without touching the network. If
   *  omitted, `OfficeSpaceClient` falls back to Node `ws` — which
   *  is usually not what a browser env wants, hence the explicit
   *  injection. */
  transport?: WebSocketCtor;
  /** Force the MemoryBackend inside BrowserStorage. Tests running
   *  under Jest pass `true` so they don't depend on `indexedDB`
   *  being present in the worker global. */
  forceMemoryStorage?: boolean;
  /** Event handler attached to the client BEFORE boot. Necessary
   *  because boot fires 'connected' synchronously when the WS opens;
   *  attaching after boot misses that first event and the UI sits
   *  on `connecting…` forever even though the connection is up.
   *  Browser-entry passes its dispatch fn here so the global
   *  `connected` flag tracks the actual ws state. */
  onEvent?: (ev: ClientEvent) => void;
}

export interface BrowserEnvHandle {
  client: OfficeSpaceClient;
  storage: BrowserStorage;
  shutdown: () => Promise<void>;
  on: (cb: (ev: ClientEvent) => void) => () => void;
}

export async function runBrowserEnv(config: BrowserEnvConfig): Promise<BrowserEnvHandle> {
  const storageConfig: BrowserStorageConfig = {
    dbName: config.dbName ?? `office-space-${config.user}`,
    rootPrefix: config.workspaceRoot ?? 'workspace',
    forceMemory: config.forceMemoryStorage === true,
  };
  const storage = new BrowserStorage(storageConfig);

  // Client-private persistence lives in a sibling prefix so it
  // doesn't collide with the workspace storage the caller writes
  // into via `handle.storage`. Same database, different trusted
  // root — IndexedDB sees all keys as flat but the BrowserStorage
  // layer enforces the scoping.
  const persistence = new BrowserStorage({
    dbName: storageConfig.dbName,
    rootPrefix: '_client',
    forceMemory: config.forceMemoryStorage === true,
  });

  const client = new OfficeSpaceClient({
    // dataDir is required by the ClientConfig type but ignored
    // when `persistence` is injected. A synthetic string keeps
    // the type happy without touching any filesystem.
    dataDir: `browser:${config.user}`,
    serverUrl: config.serverUrl,
    user: config.user,
    env: 'browser',
    heartbeatMs: config.heartbeatMs ?? 15_000,
    reconnectMs: config.reconnectMs ?? 5_000,
    transport: config.transport,
    persistence,
  });

  // Attach the event handler BEFORE boot so it sees the 'connected'
  // event boot emits when the WS opens. Attaching after returns from
  // a successful boot misses the first 'connected' and downstream
  // state (the global `connected` flag, the UI status text) never
  // updates.
  if (config.onEvent) client.on(config.onEvent);

  await client.boot();

  // Browser-tier UI plugin configs. Mounted AFTER boot so the snapshot
  // restore (if any) doesn't clobber them; if a snapshot had stale
  // panel mounts, this re-mount overwrites with the current stdlib
  // values. See specs/docs/READER_DOCUMENTS.md and panels.ts.
  registerStdlibPanels((client as unknown as { seq: import('@console-one/sequence').Sequence }).seq);

  const shutdown = async (): Promise<void> => {
    try { client.shutdown(); } catch {}
  };

  return {
    client,
    storage,
    shutdown,
    on: client.on.bind(client),
  };
}
