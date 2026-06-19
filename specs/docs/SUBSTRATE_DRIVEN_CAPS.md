# Substrate-Driven Tools: Command Coupled to Startup Conditions

## The pattern

> **A tool declared on the substrate fires automatically when its declared startup conditions hold. No external orchestration. No TS bridge. The cascade IS the orchestration.**

This is the canonical recipe for "when these substrate conditions are true, run this command." It composes three primitives the kernel already provides:

1. **Tool auto-wire**: a fn-typed schema with a registered impl fires when a non-fn value lands at its path. Async impls work — return a Promise; the kernel mounts the resolved value at `{capPath}.result`.
2. **`indexSpec` body mounts**: an index class's body can mount a value to ANY path, including a fn-typed tool path. That mount IS the invocation.
3. **Cascade routing**: an additional `indexSpec` rule reads the tool's result and routes it to the path the substrate cares about.

If you find yourself writing a TypeScript loop that polls substrate state, calls something async, then writes the result back — you're recreating this pattern by hand. Don't. Use the substrate.

## The four-class recipe

For any "fire X when Y holds, then route the result to Z" pattern:

| Class | Where condition | Body |
|---|---|---|
| **PRECONDITION** (optional) | shape Z is in some "ready" state | mark Z as ready (or skip; many use cases just pre-position state) |
| **INVOKE** | Z is ready + tool idle | mount input to fn-typed tool path |
| **ROUTE** | tool result exists | mount the routed value to Z's output position; clear tool state |
| **COMPLETE** (optional) | output exists | transition Z to a terminal state |

The tool itself is a fn-typed schema with a registered impl (sync or async). The schema's `param` is the input type; `returns` is the output type. The impl is the only place I/O lives.

## Status: working end-to-end

The pattern is fully implemented and tested. See:
- `services/contextgraph/src/agent-rules.ts` — claim, invoke, complete rules
- `services/contextgraph/src/test/agent-rules.test.ts` — 13 tests (lifecycle transitions)
- `services/contextgraph/src/test/agent-tick-substrate.test.ts` — 3 tests (end-to-end: pending → claim → invoke fires async impl → impl mounts output → complete → done, with single-flight serialization across multiple pending tasks)

### Two kernel fixes landed en route

Getting the pattern to work surfaced two real kernel bugs:

1. **`mutationCount` wasn't bumped when a fn-bind mount set `{capPath}.input`.** The fn-invocation path in `applyEntry` mounted `.input` via `proj.values.set` directly, bypassing the default bind path that bumps `mutationCount`. This silently broke idempotency filters like `notExists(capPath.input)` in downstream index classes — the filter's state change was invisible to the fixpoint's convergence signal. Fix: bump `mutationCount` on the `.input` mount when the value differs from the prior.

2. **`runIndexConstraints` didn't re-evaluate tuples between body firings within a single pass.** The evaluator materialized all matching tuples once, then iterated — so if tuple A's body mutated state that would invalidate tuple B's filter, tuple B still fired because its tuple was already in the list. Fix: re-evaluate the class's `where` after each body firing that produced a real mutation, with a `seen` set to avoid re-firing already-processed tuples in the same pass.

Both fixes preserve existing behavior for idempotent classes (bodies that don't produce mutations skip the re-eval and take the same O(tuples) cost as before). The 677-test core baseline is unchanged.

### Result routing note

The kernel doesn't decompose object values into sub-paths on mount. If an impl returns `{ taskPath, output }`, the kernel mounts it at `.result` as an object — `seq.get('.result.taskPath')` returns undefined. Two options:

- **Impl mounts its own routing**: the TickImpl signature is `(seq, invocation) => Promise<void>`. The impl closes over `seq` and mounts directly at `{taskPath}.output`. The tool's wrapper then deletes `{capPath}.input` so the INVOKE rule can re-fire for the next task. This is what `agent-rules.ts` does.
- **Kernel-side object decomposition on mount**: would let a separate ROUTE rule read `.result.output` natively. Not implemented today — queued as a future kernel feature.

## Worked example: agent task tick

The agent-tick is exactly this pattern. See `services/contextgraph/src/agent-rules.ts`:

**TICK CAP** — fn-typed schema + async impl at `agents.{id}.tick`. Impl returns `Promise<{taskPath, output}>`. The kernel mounts the resolved value at `agents.{id}.tick.result`.

**CLAIM** — pending + input + unclaimed → status=active, assignee=me.

**INVOKE** — task is active+assigned-to-me + no output yet + tool is idle (no input mounted, OR result already sitting unrouted) → mount `{taskPath, input}` to the tool. The kernel sees a non-fn value land on a fn-typed schema; calls impl; mounts the resolved value at `.result` when the Promise settles.

**ROUTE** — tool.result exists → match the task by `result.taskPath`; bind `result.output` to `tasks.{task}.output`; delete `tick.input` and `tick.result`. Tool is idle again; INVOKE fires for the next task.

**COMPLETE** — active + output → status=done.

The whole agent loop runs through cascade. The TS surface is `registerAgentRules(seq, agentId, tickImpl)` — registration only.

## What this replaces

The bad pattern (caught and rejected this session):

```ts
// DO NOT WRITE THIS
async function runAgent(seq, llm, agentId, opts) {
  for (let t = 0; t < opts.maxTasks; t++) {
    const queue = pendingTasks(seq);     // TS sort
    if (queue.length === 0) return;
    const next = queue[0];
    seq.mount(/* claim */);              // TS lifecycle
    const result = await agentLoop(seq, llm, ...);  // TS dispatch
    seq.mount(/* mark done */);          // TS lifecycle
  }
}
```

Every line is something the substrate could express:
- Priority sort → index class iteration order (or where-clause filters)
- Claim mount → CLAIM rule body
- Dispatch → INVOKE rule body mounting to a tool path
- Mark done → COMPLETE rule body fired by output existence

When you find yourself writing a TS outer loop with substrate-shaped logic, the right move is to translate the logic into rule classes, not to keep extending the TS.

## Concurrency

Single-flight per tool is automatic: the tool path is one path; only one input can be mounted at a time. The INVOKE rule's idle-filter (`notExists(input) OR exists(result)`) plus the ROUTE rule's clear-on-route gives you serialized execution per tool.

For parallel execution, use multiple tool paths (one per worker; one per shard; whatever your concurrency unit is). The substrate's iteration over the binding space gives you the dispatch.

## Async-tool kernel mechanics

When the impl returns a Promise, the kernel's fn-invocation path:

```ts
if (output !== undefined && typeof (output as any)?.then === 'function') {
  (output as Promise<unknown>).then((resolved) => {
    if (resolved !== undefined) {
      this.mount('bind', resultPath, resolved);
    }
  })
}
```

The result mount happens in a separate block. The cascade fires on that mount, picking up your ROUTE rule. So async I/O composes naturally into the cascade as a delayed-but-still-substrate-native event.

## Where this works in the deployment grid

Because the entire loop is substrate-driven and the only TS code is the tool impl (a function), the same shape runs anywhere a process can host the impl:

- **Browser**: tool impl is a function in the page; can call `fetch` directly.
- **Node daemon**: tool impl runs in a long-lived process.
- **AWS Lambda**: tool impl runs per-invocation. The substrate state is loaded from a snapshot (S3 / DB), the tool fires once or a few times during the invocation, the snapshot is saved back, the process exits. Next invocation picks up where the last left off because the substrate state IS the only memory.
- **Cron worker**: same as Lambda but on a schedule.

The shape doesn't change. The tool impl changes only at the network/resource boundary (where to fetch from, what credentials, etc.).

## Anti-patterns

- **TS for-loop polling substrate state.** If you're iterating in TS to decide what to do next, you're rebuilding the cascade by hand. Express the iteration as an `indexSpec` `where`.
- **Sidecar fields for "in flight" / "claimed" / "next to fire".** The substrate already names these via mount existence, status enums, and tool path occupancy. Don't add `.inFlight = true` fields where `exists(capPath.input)` already says it.
- **External "tick driver" that pulls from the substrate and pushes back.** That's exactly what the cascade does. The driver IS the tool impl, and the impl is fired by the substrate.
- **Privileged kernel paths for application logic.** The agent rules use only existing primitives. If you find yourself reaching for a new kernel feature, first check whether composing existing primitives gets you there — the answer is usually yes.

## Memory

This pattern was documented after the same architectural debt was caught in three places this session: `enforceContract` (separate runtime for type-declared constraints), the `kind:'fn'` shortcut in `applyEntry` (bind triggers special invocation rather than cascade narrowing), and the imperative `runAgent` outer loop (TS scheduling instead of `indexSpec` lifecycle). Each was the same shape: a TS layer doing what the substrate's primitives already express. Each fix moved the work into kernel-evaluator dispatch.

When in doubt: read this doc, read `services/contextgraph/src/phase-rules.ts`, read `services/contextgraph/src/agent-rules.ts`. The pattern is reusable.
