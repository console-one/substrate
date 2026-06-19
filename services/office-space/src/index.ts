/**
 * Office Space — entry point for the `office-space` CLI.
 *
 * Subcommands:
 *   office-space start                     Boot the server (default if no subcommand)
 *   office-space env unix [options]        Run a Unix install env
 *   office-space env docker                Run the server in Docker-env mode
 *   office-space env lambda --event <path> Run the Lambda agent in-process
 *   office-space console [options]         Interactive ft client console
 *   office-space help                      Print usage
 *
 * Server environment variables:
 *   PORT       — TCP port to listen on (default 3100)
 *   DB_PATH    — sqlite file (default ./contextgraph.db)
 *
 * Unix env options:
 *   --user <name>     Session user identity (required)
 *   --server <url>    Server WebSocket URL (default ws://localhost:3100)
 *   --data <dir>      Local state directory (default ~/.office-space/{user})
 *   --heartbeat <ms>  Heartbeat interval (default 15000)
 */

import { ContextGraphServer } from './office-space-server';
import { runUnixEnv, registerSignalHandlers } from './env/unix';
import { runDockerEnv, registerSignalHandlers as registerDockerSignalHandlers } from './env/docker';
import { lambdaHandler, type LambdaEvent } from './env/lambda';
import { runConsole } from './console';

// Public API re-exports. Transport primitives live in
// @console-one/sequenceutils/transport; this package is the product
// composition surface.
export {
  OfficeSpaceClient,
  wrapClient,
} from '@console-one/sequenceutils/transport';
export type {
  OfficeSpaceAPI,
  ClientEvent,
  IWebSocket,
  WebSocketCtor,
  IStorage,
} from '@console-one/sequenceutils/transport';
export { ContextGraphServer } from './office-space-server';
export type { ServerConfig, PriorSnapshot } from './office-space-server';
import { readFileSync } from 'fs';

const argv = process.argv.slice(2);
const subcommand = argv[0] ?? 'start';

function help(): void {
  console.log(`Office Space — typed-state coordination server
Usage:
  office-space start                         Boot the server (default)
  office-space env unix [options]            Run a Unix install env
  office-space env docker                    Run the server in Docker mode
  office-space env lambda --event <path>     Run the Lambda agent in-process
  office-space console [options]             Interactive ft client console
  office-space help                          Print this help

Console options:
  --user <name>     User identity (default: operator)
  --server <url>    Server URL (default: ws://localhost:3100)
  --data <dir>      Data directory (default: ~/.office-space/{user}/console)
  --local           Start in local-only mode (no push)

Server environment vars:
  PORT             Listen port        (default 3100)
  DB_PATH          SQLite file        (default ./contextgraph.db)
  SNAPSHOT_FT_PATH Optional ft file to recover state from at boot

Docker env environment vars:
  PORT             Listen port        (default 3100)
  DB_PATH          SQLite file        (default /var/lib/office-space/contextgraph.db)
  WORKSPACE_ROOT   fs.* trusted root  (default /var/lib/office-space/workspace)
  SNAPSHOT_FT_PATH Optional ft file to recover state from at boot

Unix env options:
  --user <name>     Session user identity (required)
  --server <url>    Server WebSocket URL (default ws://localhost:3100)
  --data <dir>      Local state directory (default ~/.office-space/{user})
  --heartbeat <ms>  Heartbeat interval (default 15000)

Once the server is running:
  http://localhost:\${PORT}/         Browser task board UI
  ws://localhost:\${PORT}            Raw WebSocket for ft-text clients
`);
}

async function start(): Promise<void> {
  const config: import('./office-space-server').ServerConfig = {
    port: parseInt(process.env.PORT ?? '3100'),
    dbPath: process.env.DB_PATH ?? './contextgraph.db',
    // Operator-facing snapshot restore: point SNAPSHOT_FT_PATH at a
    // hoisted ft file on disk and the server replays it in place of
    // the local sqlite snapshot (if any). Same contract as the
    // Docker env. Programmatic callers that want in-memory ft or
    // entries[] should construct ContextGraphServer directly and
    // pass ServerConfig.priorSnapshot themselves.
    priorSnapshot: process.env.SNAPSHOT_FT_PATH
      ? { kind: 'ftPath', path: process.env.SNAPSHOT_FT_PATH }
      : undefined,
  };
  const server = new ContextGraphServer(config);
  const port = await server.start();
  console.log(`Office Space server running.`);
  console.log(`  Open   http://localhost:${port}/`);
  console.log(`  WS     ws://localhost:${port}`);
  console.log(`  DB     ${config.dbPath}`);
  console.log(`  Stop with Ctrl-C.`);

  const shutdown = async () => {
    console.log('\nShutting down…');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function parseUnixArgs(args: string[]): {
  user: string;
  serverUrl: string;
  dataDir?: string;
  heartbeatMs?: number;
} {
  const out: { user?: string; serverUrl: string; dataDir?: string; heartbeatMs?: number } = {
    serverUrl: 'ws://localhost:3100',
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    switch (a) {
      case '--user':       out.user = v; i++; break;
      case '--server':     out.serverUrl = v; i++; break;
      case '--data':       out.dataDir = v; i++; break;
      case '--heartbeat':  out.heartbeatMs = parseInt(v); i++; break;
    }
  }
  if (!out.user) throw new Error('office-space env unix: --user is required');
  return { user: out.user, serverUrl: out.serverUrl, dataDir: out.dataDir, heartbeatMs: out.heartbeatMs };
}

async function startUnixEnv(args: string[]): Promise<void> {
  const config = parseUnixArgs(args);
  const handle = await runUnixEnv(config);
  registerSignalHandlers(handle);
  // Keep the process alive — the client's ws loop and reconnect
  // timer hold the event loop, so we don't need a manual spin here.
  // The signal handlers will exit(0) cleanly on SIGINT/SIGTERM.
}

async function startDockerEnv(): Promise<void> {
  // Docker env reads all its config from environment variables —
  // the container runtime (docker-compose, k8s) injects them via
  // env stanzas or secrets. No CLI flags here on purpose: every
  // config knob has a single canonical source, and it's the one
  // Docker's own tooling manages.
  const handle = await runDockerEnv({});
  registerDockerSignalHandlers(handle);
  console.log(`Office Space server (docker env) running on port ${handle.port}.`);
}

function parseLambdaArgs(args: string[]): { eventPath: string; remainingMs?: number } {
  const out: { eventPath?: string; remainingMs?: number } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    switch (a) {
      case '--event':      out.eventPath = v; i++; break;
      case '--remaining':  out.remainingMs = parseInt(v); i++; break;
    }
  }
  if (!out.eventPath) throw new Error('office-space env lambda: --event <json-file> is required');
  return { eventPath: out.eventPath, remainingMs: out.remainingMs };
}

async function startLambdaEnv(args: string[]): Promise<void> {
  // Local smoke test for the Lambda handler. Reads an event payload
  // from a JSON file on disk, fabricates a LambdaContext with a
  // fixed (or flag-provided) remaining-time budget, invokes the
  // handler in-process, and prints the result. Deployment path
  // uses `lambdas/office-space-agent/handler.ts` re-export — real
  // AWS Lambda invokes that directly.
  const { eventPath, remainingMs } = parseLambdaArgs(args);
  const event = JSON.parse(readFileSync(eventPath, 'utf-8')) as LambdaEvent;
  const remaining = remainingMs ?? 30000;
  const result = await lambdaHandler(event, {
    getRemainingTimeInMillis: () => remaining,
  });
  console.log(JSON.stringify(result, null, 2));
}

// No parseConsoleArgs. Console config is type state in the
// session, not imperative CLI flags. Defaults are mounted at
// boot; the user narrows them by typing ft text.

switch (subcommand) {
  case 'start':
    start().catch((e) => {
      console.error('Failed to start:', e?.message ?? e);
      process.exit(1);
    });
    break;
  case 'console': {
    // No imperative arg parsing. Defaults boot the console;
    // the user configures everything via ft text in the session.
    runConsole({}).catch((e) => {
      console.error('Failed to start console:', e?.message ?? e);
      process.exit(1);
    });
    break;
  }
  case 'env': {
    const envKind = argv[1];
    if (envKind === 'unix') {
      startUnixEnv(argv.slice(2)).catch((e) => {
        console.error('Failed to start Unix env:', e?.message ?? e);
        process.exit(1);
      });
    } else if (envKind === 'docker') {
      startDockerEnv().catch((e) => {
        console.error('Failed to start Docker env:', e?.message ?? e);
        process.exit(1);
      });
    } else if (envKind === 'lambda') {
      startLambdaEnv(argv.slice(2)).catch((e) => {
        console.error('Failed to start Lambda env:', e?.message ?? e);
        process.exit(1);
      });
    } else {
      console.error(`Unknown env: ${envKind}. Supported: unix, docker, lambda.`);
      help();
      process.exit(1);
    }
    break;
  }
  case 'help':
  case '-h':
  case '--help':
    help();
    break;
  default:
    console.error(`Unknown subcommand: ${subcommand}`);
    help();
    process.exit(1);
}
