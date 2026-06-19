# Lens-Desktop Workspace Migration Map (2026-04-24)

The goal is to delete `Workspace` from lens-desktop entirely. It's v1 substrate
— predates v2 Sequence and embeds v1 architectural choices (FieldType,
fork-as-isolated-workspace, write-wins replaceProps, suspension as separate
type) that v2 expresses differently. Every `createWorkspace()` callsite and
every `: Workspace` parameter is a thing that has to be rewritten against v2
Sequence directly. No bridge, no adapter — those preserve the v1 mistakes.

This doc inventories what needs to move and proposes an order.

## Substrate: Workspace API → v2 Sequence idiom

| Workspace method | v2 Sequence equivalent | Notes |
|---|---|---|
| `createWorkspace(rootFT)` | `new Sequence()` + `installCommitment` + `installAuthCaps` + (optional) `restoreSnapshot` | v2 has no FieldType; rootFT becomes restored cells |
| `ws.tell(items)` | `seq.insert({path,value,type,rules,where,author,op})` per item | v2 has one op; v1's Statement[] decomposes into N inserts |
| `ws.write(path, v)` | `seq.insert({ path, value: v })` | direct equivalent |
| `ws.delete(path)` | `seq.insert({ path, op: 'invalidate' })` | block ops carry `op` |
| `ws.read(path)` | `seq.get(path)` | direct equivalent |
| `ws.type(path)` | `seq.typeAt(path)` | shape differs — v2 Type, not FieldType |
| `ws.entries(path?)` | `seq.childSegments(path ?? '')` | direct equivalent |
| `ws.query(label)` | reader contract on labeled cells | reader-as-document; see `READER_DOCUMENTS.md` |
| `ws.subscribe(path, fn)` | observation rule scoped to path | `phase:'observation'` rule that calls back |
| `ws.fork()` (in-process) | scoped-prefix convention OR fork primitive | path-prefix scoping covers most cases without kernel change |
| `ws.fork()` (cross-process) | `installCrossSequence` + transport | bilateral gap exchange; preserves author across the wire |
| `ws.merge(fork)` | scoped writes propagate at insert time | with cross-sequence: peer-shaped destination forwarding |
| `ws.discard(fork)` | drop the scope reference; cells GC via temporal cascade | no explicit discard primitive needed |
| `ws.pendingSuspensions` | walk type-only cells with unresolved ref constraints | suspension is type state in v2, not a separate query |
| `ws.REAL_TIME` | `seq` has internal clock injected at construction | v2 takes `clock` in constructor |
| FieldType ↔ value | v2 Type IS the value continuum (kind + constraints + literal) | round-trip-preserved by `identity()` constraints |

The mismatch points:

- v1 `tell` returns suspensions as a separate type. v2 has no separate
  Suspension type — failed inserts surface as block-log entries on the
  cell, retried on temporal cascade. The v1 `TellResult.suspended` array
  becomes "scan recent block log for this insert's failure entries."
- v1 `fork` returns an isolated mutable workspace. v2 fork is either (a)
  scoped-prefix convention with no isolation (everything is one Sequence
  with a path prefix), or (b) a separate Sequence connected via
  `installCrossSequence` (truly isolated, message-passing).
- v1 `merge` is "diff fork → parent." v2 cross-sequence forwarding is
  "every write on either side propagates immediately under scope rules."
  Merge becomes a non-event because there's nothing to merge.

## Tier A: createWorkspace callsites (5 source files)

### `src/core/kernel.ts` (Electron root)
- **Role**: top-level boot for the Electron app. Mounts infrastructure,
  services, session bindings via `ws.write`. Returns a ready Workspace
  the rest of the app talks to.
- **v2 target**: `new Sequence()` constructed at boot. `installCommitment`,
  `installAuthCaps`, `installSessionLifecycle`, `installWriterAuthority`,
  `installCrossSequence` to forward to renderer. Same writes as today but
  via `seq.insert`.
- **Order**: LAST. Touching kernel.ts breaks every downstream consumer
  that's still on Workspace. Migrate after all tier-B consumers and most
  tier-C tests.

### `src/lambda/boot.ts` (Lambda root)
- **Role**: per-invocation root → session → client workspace stack.
  fork+hydrate from S3 FieldType snapshots. Snapshot back to S3 on persist.
- **v2 target**: per-invocation Sequence + `restoreSnapshot` from S3.
  Session/client become scoped sub-trees OR connected via
  `installCrossSequence` (depending on whether they need isolation).
  v2 already has `runLambdaEnv` in the office-space service that does
  this exact pattern — ported from v1 in earlier session.
- **Order**: independent cluster. Lambda is a separate process; its
  migration doesn't touch other clusters. Can land any time.

### `src/core/cli/console.ts` (CLI root)
- **Role**: interactive console session. createWorkspace + interpreters
  + load packages + client callables + render suspension → accept input
  → write → re-render.
- **v2 target**: root Sequence + `installAgentPrompt` (already half-done
  this session via `mountPromptDerivation`) + reader contract for the
  suspension view. Console renders from the reader, accepts input as
  inserts.
- **Order**: FIRST proposed cluster. Already half-migrated (`mountPromptDerivation`
  lands a Sequence beside the Workspace; finishing means making the
  Sequence the source of truth and removing the Workspace).

### `src/core/workflows/agentRunner.ts`
- **Role**: per-agent-turn isolated scope. `createWorkspace` per turn,
  compilePackage writes tools into it, executeTool reads from it.
- **v2 target**: scoped-prefix on a parent Sequence (in-process speculative
  agent run, no isolation needed because the agent's writes are scoped to
  e.g. `agents.{turnId}.*`). If isolation is required, separate Sequence
  with no transport.
- **Order**: tier-B consumer cluster (workspaceCompilation, chat, etc.)
  must migrate alongside.

### `src/shared/type/workspace.ts`
- **Role**: the definition of `createWorkspace`, Workspace type, fork/merge
  semantics. Built on FieldType + replaceProps.
- **v2 target**: DELETE. No replacement file — consumers use v2 Sequence
  directly.
- **Order**: LAST. Delete after all callsites migrated.

## Tier B: Workspace consumers (13 source files)

These take `Workspace` as a parameter or import the type but don't call
`createWorkspace`. Their migration is "change the parameter type from
`Workspace` to `Sequence` and rewrite the body against v2 API."

| File | What it does | v2 idiom |
|---|---|---|
| `src/shared/procedure/workspaceClient.ts` | writeClientCallables — installs `packages`, `packageDetail`, `gaps`, `tools`, `metrics` callables | each callable becomes a fn-kind cell mounted via `installTool`, reads via reader contract |
| `src/shared/procedure/workspaceCompilation.ts` | compilePackage, executeTool, definitionPlane | compilePackage writes tools into a scoped sub-tree; executeTool dispatches via fn-kind cells |
| `src/shared/procedure/workspaceAcceptance.ts` | deriveAcceptanceType, callableSignatures | reader contract over fn-kind cells |
| `src/shared/procedure/workspacePrompt.ts` | detectGaps | gaps are type-only cells with unresolved refs; reader walks them |
| `src/shared/procedure/schematics/llmAgent.ts` | LLM-as-tool schematic | fn-kind cell with `http.fetch` impl; covered by `feedback_capability_composition_pattern` memory |
| `src/core/workflows/chat.ts` | chat workflow registry; takes workspace as parameter | accepts a Sequence; per-chat scope is `chats.{id}.*` prefix or installCrossSequence |
| `src/core/workflows/draftProjection.ts` | draft computation over a fork | scoped-prefix sub-tree under chat scope |
| `src/core/workflows/llmInterpret.ts` | one LLM turn against workspace | takes Sequence; reads context from reader; mounts response via `agent-loop.ts` pattern (already proven) |
| `src/core/workflows/workflowTypes.ts` | WorkflowEnv types | swap Workspace for Sequence in type definitions |
| `src/core/services/toolsetService.ts` | toolset enumeration | reader contract over `_tools.*` partition |
| `src/lambda/handler.ts` | Lambda handler shim | thin: just delegates to boot.ts |
| `src/main/headBridge.ts` | IPC bridge between renderer and main | THE cross-sequence transport candidate; replace with installCrossSequence |
| `src/shared/type/scope.ts` | createScope helper | scoped-prefix convention helper, or delete if scope-by-prefix is direct enough |

## Tier C: Tests (27 files)

Classify three ways:

**Delete WITH workspace.ts at end of migration** (tests that pin v1
substrate semantics — load-bearing while workspace.ts is still in use,
then dead with it):
- `src/shared/type/test/workspace.test.ts` (1285 lines) — tests workspace.ts itself
- `src/shared/type/test/scope.test.ts` (237) — tests scope.ts
- `src/shared/type/test/ref.test.ts` (148) — tests v1 ref semantics
- `src/shared/type/test/expr.test.ts` (121) — tests v1 expression substrate
- `src/shared/type/test/whereClause.test.ts` (167) — v1 query language
- `src/shared/type/test/reactiveFieldType.test.ts` (316) — v1 FieldType reactivity
- `src/shared/type/test/reactiveCascadeVisibility.test.ts` (200) — v1 cascade
- `src/shared/type/test/promptAsConstraints.test.ts` (216) — v1 prompt-as-constraint
- `src/shared/type/test/promptDynamicObject.test.ts` (447) — v1 dynamic objects
- `src/shared/type/test/agentOptimizer.test.ts` (233) — v1 optimizer
- `src/shared/type/test/agentSelfSchedule.test.ts` (248) — v1 scheduling
- `src/shared/type/test/endToEnd.test.ts` (239) — v1 end-to-end
- `src/shared/procedure/test/oneOperation.test.ts` (284) — v1 "one operation" claim
- `src/shared/procedure/test/typedPartition.test.ts` (235) — v1 partition
- `src/shared/procedure/test/partitionFactory.test.ts` (177) — v1 partition factory

**Total ~4553 lines** to delete in Cluster 6 alongside workspace.ts.

These look like obvious early deletions but are NOT — they protect the
v1 substrate from regressions throughout the migration. Removing them
before workspace.ts itself is removed silently weakens every cluster's
safety net. Save the deletion for Cluster 6.

(v2 tests already cover the equivalent claims at the substrate level,
so nothing of value is lost when these eventually go.)

**Migrate** (tests of application behavior that survives in v2):
- `src/core/cli/test/agentPromptFrame.test.ts` — agent prompt frame; rewrite against v2 Sequence (already partially done)
- `src/core/services/test/goals.test.ts` + `goals.integration.test.ts` — service behavior
- `src/core/workflows/test/llmInterpret.test.ts` — LLM interpret turn
- `src/shared/procedure/test/agentAsCascade.test.ts` — agent loop semantics; v2 has `agent-loop.ts` test pattern
- `src/shared/procedure/test/explorerIntegration.test.ts` — explorer integration
- `src/shared/procedure/test/llmAgent.test.ts` — LLM agent schematic
- `src/shared/procedure/test/programAsData.test.ts` — program as data
- `src/shared/procedure/test/workspaceAcceptance.test.ts` — acceptance type derivation
- `src/shared/procedure/test/workspaceClient.test.ts` — client callables
- `src/shared/procedure/test/workspaceCompilation.test.ts` — compilation
- `src/shared/procedure/test/workspacePrompt.test.ts` — prompt detection

**Keep as-is** (don't touch in this migration):
- All other tests not listed above.

## Migration order: cluster, not file-by-file

Each Workspace consumer is tightly coupled to its callers via the
`Workspace` type. Changing one in isolation breaks callers. Migrate in
clusters where every file in the cluster moves to v2 in one PR. Other
clusters keep using Workspace.

### Cluster 1: Console
- `src/core/cli/console.ts` — 2189 lines
- `src/core/cli/test/agentPromptFrame.test.ts`
- Tier-B deps that have to migrate alongside: `workspaceCompilation.ts`,
  `workspaceClient.ts`, `workspaceAcceptance.ts`, `workspacePrompt.ts`
  (console.ts uses all four)
- **Earlier "half-migrated" claim was wrong.** The 371 lines of recent
  changes (`mountPromptDerivation`) are still v1 — they write to `ws`,
  use Workspace types. The frame-shape rendering work doesn't reduce
  the migration scope.
- **Estimate**: 3–5 days.

### Cluster 2: Lambda
- `src/lambda/boot.ts` (197) + `src/lambda/handler.ts` (203)
- Tier-B deps: `workspaceInterpreters.ts` (829 lines!), `workspacePrompt.ts`
  (renderWorkspace, 192), v1 type system (`@shared/type/normalize`
  for snapshotFT, `@shared/type` for FieldType)
- **`runLambdaEnv` claim was wrong.** That primitive is in
  `services/contextgraph/src/env-lambda.ts` (v1 office-space service),
  not v2 stdlib. Lifting it to v2 is its own ~half-day task and should
  precede this cluster.
- **Estimate**: 3–5 days (after `runLambdaEnv` is in v2).

### Cluster 3: Renderer (NEW SUBSTRATE)
- `src/main/headBridge.ts` becomes cross-sequence transport
- renderer panes get a v2 Sequence (no Workspace today, no migration debt)
- one pane (token-error or settings) becomes the first reader-contract
  rendered substrate-native
- **Why valuable**: no v1 baggage to remove; pure addition; proves
  cross-sequence transport over IPC.
- **Estimate**: 3–5 days for the first pane + transport.

### Cluster 4: Workflows + Procedures
- `chat.ts`, `agentRunner.ts`, `draftProjection.ts`, `llmInterpret.ts`,
  `workflowTypes.ts`
- `workspaceClient.ts`, `workspaceCompilation.ts`, `workspaceAcceptance.ts`,
  `workspacePrompt.ts`, `schematics/llmAgent.ts`
- All migrate together because they share types.
- **Estimate**: 1–2 weeks. Largest cluster.

### Cluster 5: Services + Types
- `toolsetService.ts`, `scope.ts`
- Tests that survive (Tier C migrate list).
- **Estimate**: 3–5 days.

### Cluster 6: Kernel + Final Delete
- `src/core/kernel.ts` rewrites to use v2 Sequence as root.
- Delete `src/shared/type/workspace.ts`.
- Delete tier-C "delete outright" tests.
- **Estimate**: 2–3 days.

## Total effort

Realistic: **4–6 weeks of focused work**. Each cluster is 3–5 days when
the tier-B deps are honestly counted. Some parallelism possible (Lambda
+ Renderer + Console can land independently once their tier-B deps
are isolated from each other).

## Session-sized increments (NOT clusters)

When you don't have a 3–5-day window, these are real progress without
committing to a cluster:

1. **Lift `runLambdaEnv` to v2 stdlib.** Currently in
   `services/contextgraph/src/env-lambda.ts` (per memory entry
   `project_stage2c_landed`). Generic lambda boot + remainingTimeMs
   budget + priorSnapshot hydration. Half-day. Prerequisite for
   Cluster 2.

2. **Add cross-sequence transport over Electron IPC scaffold.** No
   pane migrations yet — just the transport. `installCrossSequence`
   on both sides, IPC channel as the wire. Half-day. Prerequisite for
   Cluster 3.

3. **Migrate one Tier-C "migrate" test.** Rewrite a test that's already
   classified as worth migrating against v2 substrate directly. Builds
   the test pattern. ~1–2 hours per test.

4. **Detailed plan for one cluster.** Pick a cluster and write a
   section-by-section migration plan (every `ws.write/read` mapped to
   its v2 idiom, every callsite of every consumer it depends on
   audited). Surfaces hidden coupling before code changes. ~half-day.

What is NOT a session-sized increment, regardless of how it looks:

- "Delete the Tier-C delete-outright tests now" — see
  classification above; they protect the v1 substrate during migration.
- "Just start console.ts and see how far we get" — partial console.ts
  rewrite leaves the file broken. Cluster 1 is one PR or zero PRs.
- "Add a workspace adapter for incremental migration" — already
  tried, deleted; preserves v1 architectural mistakes.

## Open questions

- Does the renderer pane migration need a fork primitive, or does
  scoped-prefix cover the speculative-execution use cases (chat draft)?
  Default: scoped-prefix until proven insufficient.
- `headBridge.ts` IPC layer: wrap (cross-sequence on top of existing IPC)
  or replace (cross-sequence direct over IPC)? Default: wrap first,
  measure, replace if necessary.
- Should `runLambdaEnv` (v2 stdlib) become the canonical Lambda boot, or
  does lens-desktop's lambda/boot.ts have constraints that diverge?
  Default: lens-desktop calls `runLambdaEnv` directly, no separate path.

## Status

- 2026-04-24: doc written. Adapter (workspace-adapter.ts) deleted from
  lens-desktop in same session. No clusters migrated yet.
- v2 Sequence is at 255/255 in `~/publicpackages/sequence/src-v2/`.
- Lens-desktop v2 import smoke test passes (path mapping wired).
