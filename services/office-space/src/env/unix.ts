/**
 * env/unix.ts — Unix/macOS local install env.
 *
 * A thin adapter that wraps `OfficeSpaceClient` with Unix-specific
 * platform concerns: data directory under ~/.office-space (or a
 * config-specified path), POSIX signal handling, PID file for
 * process tracking, and a heartbeat loop that uses the underlying
 * client's existing reconnect + offline buffer.
 *
 * The env itself is a class instance — its facts (user, server URL,
 * data dir, heartbeat interval, storage policy) get mounted as type
 * state when the env boots. A follow-up iteration will extract the
 * class declaration into `env/unix.ft` so the env's identity and
 * constraints live in the kernel's type-state layer, with this TS
 * file as the adapter that attaches platform impls to the class's
 * invocation surfaces.
 */

import { OfficeSpaceClient } from '@console-one/sequenceutils/transport';
import type { ClientEvent } from '@console-one/sequenceutils/transport';
import { NodeStorage } from '@console-one/sequenceutils/transport';
import type { IStorage } from '@console-one/sequenceutils/transport';
import { join } from 'path';
import { homedir } from 'os';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';

export interface UnixEnvConfig {
  /** Logical user identity this env is holding a session for. */
  user: string;
  /** WebSocket URL of the Office Space server. */
  serverUrl: string;
  /** Local state directory. Defaults to `~/.office-space/{user}`. */
  dataDir?: string;
  /** Heartbeat interval ms. Kept shorter than server's 30s active
   *  window so the session stays in `status = active`. */
  heartbeatMs?: number;
  /** Reconnect backoff ms on disconnect. */
  reconnectMs?: number;
  /** Where to write the PID file. Defaults to `{dataDir}/unix.pid`. */
  pidFile?: string;
  /** Quiet mode: suppress stderr lifecycle logs. For tests. */
  silent?: boolean;
}

export interface UnixEnvHandle {
  /** The underlying offline-capable client. */
  client: OfficeSpaceClient;
  /** Policy-bounded filesystem utility for this env's workspace.
   *  Rooted under `{dataDir}/workspace` with path-traversal guards
   *  and a read cache. Wired into bootstrap-tools so session tool
   *  invocations delegate here automatically. Exposed on the
   *  handle so the CLI layer and tests can also use it directly. */
  storage: IStorage;
  /** Shut down gracefully: flush snapshot, close ws, remove PID. */
  shutdown: () => Promise<void>;
  /** Subscribe to lifecycle events (connect, delta, render, error). */
  on: (cb: (ev: ClientEvent) => void) => () => void;
}

/**
 * Start a Unix env: construct the client, wire signals, boot.
 * Returns a handle for programmatic control. When run from the
 * CLI, `registerSignalHandlers` is called separately so the
 * process shuts down on SIGINT/SIGTERM; when run from a test,
 * the caller drives shutdown directly.
 */
export async function runUnixEnv(config: UnixEnvConfig): Promise<UnixEnvHandle> {
  const dataDir = config.dataDir ?? defaultDataDir(config.user);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // Policy-bounded storage. Workspace lives inside the env's data
  // dir (not alongside it) so the PID file and offline-buffer meta
  // stay segregated from user-visible files. Path-traversal guards
  // keep tool callers from escaping the workspace subtree.
  const workspaceRoot = join(dataDir, 'workspace');
  const storage = new NodeStorage(workspaceRoot);

  const client = new OfficeSpaceClient({
    dataDir,
    serverUrl: config.serverUrl,
    user: config.user,
    env: 'unix',
    heartbeatMs: config.heartbeatMs ?? 15_000,
    reconnectMs: config.reconnectMs ?? 5_000,
  });

  const pidFile = config.pidFile ?? join(dataDir, 'unix.pid');
  try { writeFileSync(pidFile, String(process.pid)); } catch {}

  if (!config.silent) {
    const log = (msg: string) => { try { process.stderr.write(`[unix-env] ${msg}\n`); } catch {} };
    client.on((ev) => {
      switch (ev.kind) {
        case 'connected':   log(`connected ${config.serverUrl} as ${config.user}`); break;
        case 'disconnected': log('disconnected — buffering locally, will retry'); break;
        case 'error':       log(`error: ${ev.message}`); break;
      }
    });
  }

  await client.boot();

  const shutdown = async (): Promise<void> => {
    try { client.shutdown(); } catch {}
    try { if (existsSync(pidFile)) unlinkSync(pidFile); } catch {}
  };

  return { client, storage, shutdown, on: client.on.bind(client) };
}

/**
 * Register SIGINT/SIGTERM handlers that invoke `handle.shutdown()`
 * then exit the process. Kept separate from `runUnixEnv` so the
 * test path can construct a handle without installing signal
 * handlers in the Jest worker. CLI entry point calls both.
 */
export function registerSignalHandlers(handle: UnixEnvHandle): void {
  const stop = async () => {
    await handle.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/**
 * Default data directory: `~/.office-space/{user}`. Keeps each user
 * on a machine isolated — distinct snapshots, distinct PID files,
 * distinct buffered offline writes. One machine can run multiple
 * Unix envs concurrently (a user and an agent, say) without
 * stepping on each other.
 */
function defaultDataDir(user: string): string {
  return join(homedir(), '.office-space', user);
}
