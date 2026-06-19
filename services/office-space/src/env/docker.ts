/**
 * env/docker.ts — Docker server env.
 *
 * Docker is not a client env; it's how the SERVER ships. The env's
 * purpose is to run `ContextGraphServer` inside a container with:
 *   - trusted filesystem root under a Docker-volume mount point,
 *   - sqlite database file under the same mount,
 *   - config via environment variables (standard container pattern),
 *   - signal-driven shutdown so `docker stop` cleans up gracefully.
 *
 * Same NodeStorage class as the Unix env, different trusted root.
 * The IStorage interface is uniform across envs; only the root
 * (plus whatever platform-glue concerns — PID file for Unix, /tmp
 * for Lambda, IndexedDB for Browser) differs per env.
 *
 * Env vars honoured:
 *   PORT             TCP port (default 3100)
 *   DB_PATH          SQLite file (default /var/lib/office-space/contextgraph.db)
 *   WORKSPACE_ROOT   fs.* trusted root (default /var/lib/office-space/workspace)
 *   HEARTBEAT_MS     heartbeat budget passed through to server tick
 *
 * The defaults assume a `/var/lib/office-space` Docker-volume mount
 * — both the sqlite file and the workspace live on the volume so
 * state persists across `docker run` invocations. The Dockerfile
 * declares this as a VOLUME; Kubernetes / compose pin it to a
 * persistent claim / bind mount.
 */

import { ContextGraphServer } from '../office-space-server.js';
import type { ServerConfig, PriorSnapshot } from '../office-space-server.js';
import { NodeStorage } from '@console-one/sequenceutils/transport';
import type { IStorage } from '@console-one/sequenceutils/transport';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface DockerEnvConfig {
  /** TCP port (default 3100). */
  port?: number;
  /** SQLite file path (default /var/lib/office-space/contextgraph.db). */
  dbPath?: string;
  /** Trusted filesystem root for fs.* tools. */
  workspaceRoot?: string;
  /** Bootstrap .ft path override. */
  bootstrapPath?: string;
  /** External snapshot to recover state from at boot. When both
   *  this and SNAPSHOT_FT_PATH are set, the programmatic config
   *  wins. Useful for tests and library consumers that construct
   *  snapshots in memory. */
  priorSnapshot?: PriorSnapshot;
  /** Quiet mode: suppress stderr lifecycle logs. For tests. */
  silent?: boolean;
}

export interface DockerEnvHandle {
  /** The running server. */
  server: ContextGraphServer;
  /** Bound port (useful when port=0 in tests). */
  port: number;
  /** Policy-bounded filesystem utility rooted at the workspace. */
  storage: IStorage;
  /** Graceful shutdown: drain ws clients, snapshot, close http. */
  shutdown: () => Promise<void>;
}

export async function runDockerEnv(config: DockerEnvConfig = {}): Promise<DockerEnvHandle> {
  const port = config.port ?? parseInt(process.env.PORT ?? '3100', 10);
  const dbPath = config.dbPath ?? process.env.DB_PATH ?? '/var/lib/office-space/contextgraph.db';
  const workspaceRoot =
    config.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? '/var/lib/office-space/workspace';

  // Ensure the workspace root and the sqlite file's parent exist
  // before the server touches them. Inside a container these are
  // usually volume-mounted empty directories on first boot.
  if (!existsSync(workspaceRoot)) mkdirSync(workspaceRoot, { recursive: true });
  if (dbPath !== ':memory:') {
    const dbDir = dirname(dbPath);
    if (dbDir && !existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  }

  const storage = new NodeStorage(workspaceRoot);

  // Snapshot recovery at boot. Programmatic config wins; the env
  // var is the operator-facing convenience for `docker run` style
  // invocations where mounting a snapshot file on the volume and
  // setting `SNAPSHOT_FT_PATH=/var/lib/office-space/restore.ft` is
  // cleaner than embedding text in an env var.
  const priorSnapshot: PriorSnapshot | undefined =
    config.priorSnapshot
    ?? (process.env.SNAPSHOT_FT_PATH
        ? { kind: 'ftPath', path: process.env.SNAPSHOT_FT_PATH }
        : undefined);

  const serverConfig: ServerConfig = {
    port,
    dbPath,
    bootstrapPath: config.bootstrapPath,
    storage,
    priorSnapshot,
  };

  const server = new ContextGraphServer(serverConfig);
  const boundPort = await server.start();

  if (!config.silent) {
    const log = (msg: string) => { try { process.stderr.write(`[docker-env] ${msg}\n`); } catch {} };
    log(`listening on port ${boundPort}`);
    log(`workspace root ${workspaceRoot}`);
    log(`db path ${dbPath}`);
  }

  const shutdown = async (): Promise<void> => {
    try { await server.stop(); } catch {}
  };

  return { server, port: boundPort, storage, shutdown };
}

/**
 * Register SIGINT/SIGTERM handlers that invoke `handle.shutdown()`
 * then exit the process. Docker sends SIGTERM on `docker stop` and
 * SIGKILL after the grace period, so the graceful path only has
 * a few seconds to drain — shutdown does a single snapshot save
 * and closes the ws server.
 */
export function registerSignalHandlers(handle: DockerEnvHandle): void {
  const stop = async () => {
    await handle.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
