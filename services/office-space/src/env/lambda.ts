/**
 * env/lambda.ts — AWS Lambda agent env.
 *
 * Unlike the Unix and Docker envs (which wrap long-running
 * processes), the Lambda env is ephemeral: each invocation is a
 * cold start, runs one PermanentAgent execution cycle, and returns.
 * The Lambda-specific concerns are:
 *
 *   1. No persistent filesystem. /tmp is the only writable scratch
 *      and is wiped between cold starts. NodeStorage rooted at
 *      /tmp/office-space/{agentId} is fine within an invocation
 *      but irrelevant across them.
 *
 *   2. State must come from object storage. The Lambda's event
 *      payload carries an `agentId` + optional `priorSnapshot`
 *      (the last-known agent view, fetched by the caller from S3
 *      / DynamoDB / wherever). The env seeds the local
 *      `snapshot.ft` from that before PermanentAgent boots, so
 *      the agent's client loadSnapshot picks it up transparently.
 *
 *   3. Execution budget is bounded by Lambda's remaining time.
 *      `context.getRemainingTimeInMillis()` minus a 2s safety
 *      margin becomes the agent's maxExecutionMs. The agent's
 *      inner loop checks every iteration and stops with
 *      `stopReason: 'timeout'` when exceeded, so Lambda never
 *      force-kills mid-mount.
 *
 *   4. Return value is the updated snapshot for push-back. After
 *      `agent.run()` completes and the client has written
 *      `snapshot.ft` during its shutdown, the env reads it and
 *      includes it in the Lambda response body. The caller
 *      persists it (S3 write) and the next invocation pulls it
 *      back as `priorSnapshot`.
 *
 * Agents are NOT servers. The Lambda env wraps `PermanentAgent`
 * (which is a client wrapping `OfficeSpaceClient`), so the
 * priorSnapshot shape here is ft-only — the `entries` shape from
 * ServerConfig.priorSnapshot is a server-side primitive that
 * carries schemas + tools + policies, which don't round-trip
 * through a client that only persists hoisted ft text.
 */

import { PermanentAgent } from '../agent';
import type { AgentRunResult } from '../agent';
import type { PriorSnapshot } from '@console-one/sequenceutils/transport';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface LambdaEvent {
  /** Agent identity — stable across invocations. Used as the key
   *  under `/tmp/office-space/{agentId}` for this invocation's
   *  scratch dir. */
  agentId: string;
  /** WebSocket URL of the Office Space server this agent syncs to. */
  serverUrl: string;
  /** Prior agent view, seeded into the agent's local snapshot
   *  before boot. Accepts `{kind:'ft', text}` (inline) or
   *  `{kind:'ftPath', path}` (file already on /tmp or bundled).
   *  The `{kind:'entries'}` shape is server-only — passing it
   *  here throws with a clear message.
   *
   *  When omitted, the agent starts with an empty local view and
   *  relies entirely on server-side sync to populate state. Useful
   *  for the very first invocation of a new agent, or for stateless
   *  agents whose work is fully server-driven. */
  priorSnapshot?: PriorSnapshot;
  /** Tool impls this invocation provides. Each key is a tool
   *  path, each value an impl function. Registered on the agent's
   *  local Sequence before the execution loop runs. */
  tools?: Record<string, Function>;
  /** Minimum delay before the next scheduled invocation (ms).
   *  Reported in the result body. Default 60000. */
  minDelayMs?: number;
}

/**
 * Subset of AWS Lambda's context object we care about. Real Lambda
 * Context has many more fields (awsRequestId, functionName, etc.);
 * the env only needs the time budget.
 */
export interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

export interface LambdaResultBody {
  agentId: string;
  stopReason: AgentRunResult['stopReason'];
  gapsFilled: number;
  remainingGaps: number;
  reschedule: boolean;
  nextRunAt?: number;
  /** Updated snapshot (ft text) from the agent's local view after
   *  this cycle. The handler's caller is responsible for pushing
   *  this to object storage. */
  snapshotFt: string;
}

export interface LambdaResult {
  statusCode: number;
  body: LambdaResultBody;
}

/**
 * Programmatic entry point — used by `lambdaHandler` and by tests
 * that need to override the tmp root or silent mode without
 * constructing a fake Lambda context.
 */
export interface RunLambdaEnvConfig extends LambdaEvent {
  /** Remaining execution budget in ms. Used to compute
   *  maxExecutionMs for the agent. Default 30000. */
  remainingTimeMs?: number;
  /** Override for the `/tmp/office-space` scratch root. Tests
   *  point this at a tmpdir under os.tmpdir() so the test suite
   *  runs on systems where `/tmp` isn't writable or readable
   *  across parallel workers. */
  tmpRoot?: string;
  /** Suppress stderr logging. Defaults true in the handler path. */
  silent?: boolean;
}

const DEFAULT_TMP_ROOT = '/tmp/office-space';
const SAFETY_MARGIN_MS = 2000;

export async function runLambdaEnv(config: RunLambdaEnvConfig): Promise<LambdaResult> {
  const tmpRoot = config.tmpRoot ?? DEFAULT_TMP_ROOT;
  const agentDataDir = join(tmpRoot, config.agentId);
  if (!existsSync(agentDataDir)) mkdirSync(agentDataDir, { recursive: true });

  // Seed the agent's local snapshot file from priorSnapshot, BEFORE
  // constructing PermanentAgent — its OfficeSpaceClient constructor
  // synchronously reads `{dataDir}/snapshot.ft` during loadSnapshot,
  // so the file must exist on disk by the time PermanentAgent
  // hits `new OfficeSpaceClient(...)`.
  if (config.priorSnapshot) {
    const ft = resolveSnapshotToFt(config.priorSnapshot);
    writeFileSync(join(agentDataDir, 'snapshot.ft'), ft);
  }

  // Bound the agent's execution to Lambda's remaining budget minus
  // a safety margin. The 2s cushion covers snapshot serialisation,
  // ws shutdown, and the return-trip network flush.
  const remaining = config.remainingTimeMs ?? 30000;
  const maxExecutionMs = Math.max(1000, remaining - SAFETY_MARGIN_MS);

  if (!config.silent) {
    try { process.stderr.write(`[lambda-env] agent=${config.agentId} budget=${maxExecutionMs}ms\n`); } catch {}
  }

  const agent = new PermanentAgent({
    agentId: config.agentId,
    serverUrl: config.serverUrl,
    dataDir: tmpRoot,
    tools: config.tools,
    maxExecutionMs,
    schedule: { minDelayMs: config.minDelayMs ?? 60000 },
  });

  const result = await agent.run();

  // After `agent.run()` completes, the underlying client has
  // already shut down and persisted the updated local view to
  // `snapshot.ft`. Read it for the push-back handoff.
  let snapshotFt = '';
  try {
    snapshotFt = readFileSync(join(agentDataDir, 'snapshot.ft'), 'utf-8');
  } catch {
    // No file — the client may have errored before its first save.
    // Return empty and let the caller decide whether that's a
    // cold-start anomaly or a failed invocation.
  }

  return {
    statusCode: result.stopReason === 'error' ? 500 : 200,
    body: {
      agentId: config.agentId,
      stopReason: result.stopReason,
      gapsFilled: result.gapsFilled,
      remainingGaps: result.remainingGaps,
      reschedule: result.reschedule,
      nextRunAt: result.nextRunAt,
      snapshotFt,
    },
  };
}

/**
 * Resolve a PriorSnapshot (server-side discriminated union) to ft
 * text — the agent's local persistence format. Only `ft` and
 * `ftPath` are valid here. The `entries` shape carries server-side
 * primitives (schemas, tools, policies) that don't round-trip
 * through a client, so passing it throws.
 */
function resolveSnapshotToFt(s: PriorSnapshot): string {
  if (s.kind === 'ft') return s.text;
  if (s.kind === 'ftPath') return readFileSync(s.path, 'utf-8');
  throw new Error(
    'lambda env priorSnapshot: entries shape is server-only — use ft or ftPath for agent-local recovery'
  );
}

/**
 * The AWS Lambda handler entry point. Real deployments re-export
 * this from `lambdas/office-space-agent/handler.ts` as
 * `export const handler = lambdaHandler;`.
 */
export async function lambdaHandler(event: LambdaEvent, context: LambdaContext): Promise<LambdaResult> {
  return runLambdaEnv({
    ...event,
    remainingTimeMs: context.getRemainingTimeInMillis(),
    silent: true,
  });
}
