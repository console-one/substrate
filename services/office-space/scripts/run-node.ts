/**
 * scripts/run-node.ts — CLI wrapper that boots a single Sequence node.
 *
 * Runs one process that hosts one Sequence, with an optional
 * server-half (listen port for downstream peers) and an optional
 * client-half (upstream URL). This is the deployable binary for
 * every server-side process in the Sequence Nodes topology — the
 * same binary runs as Org Scheduler (listen-only), User A Session
 * (both halves), User B Session (both halves), just with different
 * CLI flags.
 *
 * The test harness spawns this binary under `tsx` to get real
 * process boundaries (one Sequence per process, its own clock, its
 * own blast radius) rather than simulating the topology in-process.
 * SEQUENCE_NODES.md invariants require this.
 *
 * Protocol (stdin/stdout):
 *
 *   stdin  — one ft-text command per line. Blank lines ignored.
 *            Trailing line-continuation via `\` is not supported;
 *            use `receive()`-style semicolons or one mount per line.
 *   stdout — one JSON line per event, shape:
 *            { t: <timestamp>, kind: <...>, ... }
 *            Events:
 *              { kind: 'ready', identity, listenPort }
 *              { kind: 'listening', port }
 *              { kind: 'upstream-connected', url }
 *              { kind: 'upstream-disconnected' }
 *              { kind: 'upstream-delta', text }
 *              { kind: 'local-change', path, value }
 *              { kind: 'error', message }
 *
 * Usage:
 *   tsx run-node.ts --identity org   --listen 8765
 *   tsx run-node.ts --identity alice --listen 8766 --upstream ws://localhost:8765
 */

import { runSequenceNode, type SequenceNodeEvent } from '../src/sequence-node';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        out[key] = 'true';
      } else {
        out[key] = val;
        i++;
      }
    }
  }
  return out;
}

function emit(obj: object): void {
  process.stdout.write(JSON.stringify({ t: Date.now(), ...obj }) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const identity = args.identity;
  if (!identity) {
    emit({ kind: 'error', message: 'missing --identity' });
    process.exit(2);
  }
  const listenPort = args.listen ? parseInt(args.listen, 10) : undefined;
  const upstreamUrl = args.upstream;

  const handle = await runSequenceNode({
    identity,
    listenPort,
    upstreamUrl,
    dbPath: ':memory:',
    onEvent: (ev: SequenceNodeEvent) => emit(ev),
  });

  // Subscribe to every direct mount on the shared Sequence so the
  // harness can verify propagation. Uses the kernel's post-block
  // hook, which fires once per outermost mount (not per cascaded
  // sub-entry), so this is a clean source of "what just committed."
  handle.seq.onBlockApplied((result) => {
    for (const change of result.changes ?? []) {
      // Don't flood stdout with internal kernel bookkeeping —
      // _deps/_rdeps/_exec/_blocks/_readers churn on every mount.
      if (change.path.startsWith('_')) continue;
      emit({
        kind: 'local-change',
        path: change.path,
        value: change.newValue,
        cause: change.cause,
      });
    }
  });

  emit({ kind: 'ready', identity, listenPort: handle.listenPort });

  // Read ft-text from stdin, one mount per non-blank line.
  let buffer = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handle.mount(trimmed);
      } catch (e: any) {
        emit({ kind: 'error', message: `mount failed: ${e.message}` });
      }
    }
  });

  const gracefulShutdown = async () => {
    await handle.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  // Keep the process alive. The WebSocket server and client timers
  // also keep it alive, so this is belt-and-suspenders — but it
  // makes the "nothing to do" state explicit rather than leaving
  // liveness dependent on runSequenceNode internals.
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  emit({ kind: 'error', message: `boot failed: ${e.message}` });
  process.exit(1);
});
