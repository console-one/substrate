# V2 Migration Context — Session Handoff (2026-04-24)

Comprehensive summary of where the v2 Sequence migration stands and the
strategic open question. Written for context-compression survival.

## TL;DR

- v2 Sequence (`~/publicpackages/sequence/src-v2/`) is **272/272 tests green**.
- The v1→v2 capability port is mostly done: writer-authority, session
  lifecycle, auth tokens, NodeStorage, BrowserStorage, priorSnapshot,
  cross-sequence forwarding (with author preserved across the wire),
  blueprints, kits, AGENT_PROMPT_FRAME render — all running.
- One concrete integration into lens-desktop landed: jest+ts path mapping
  `@v2/*` → `~/publicpackages/sequence/src-v2/*`, and lens-desktop's own
  `writeClientCallables` runs against a v2-backed workspace (8 tests
  green inside lens-desktop's own `npx jest`).
- **The workspace adapter (`createWorkspaceOverSequence`) is not
  load-bearing.** Only those 8 tests use it. Zero lens-desktop application
  code paths go through it.
- **Open strategic question:** is the workspace adapter even the right
  migration vehicle, or should we abandon it and migrate directly to v2
  native idioms one feature at a time?

## What v2 Sequence has (`~/publicpackages/sequence/src-v2/`)

### Kernel (`sequence.ts`, ~775 lines)

- One operation: `seq.insert({ path, value?, type?, rules?, where?, author?, identity?, op? })`.
- One algorithm: traverse → admission rules → compose-at-cell → apply
  → propagate (ref / temporal / observation rules).
- Three lattice axes: structural, temporal, ref.
- Three rule phases: `admission`, `observation`, `access`.
- Re-entrancy guards: `accessInFlight` (Wire 2), `expandInProgress` per-path
  (Wire 1 cycle break).
- Block ops: `narrow`, `invalidate`. BlockTemplate threads `op` through
  `dispatchRule` so emitters can delete cells.
- `BlockTemplate.author` preserved via cross-sequence forwarding.

### Stdlib (`stdlib.ts`, ~3500 lines)

| Section | What it does |
|---|---|
| Commitment | Fn-typed invocations elect a write-lease at `_commitments.{id}` |
| Reliability | Bayesian-conjugate prior on holder fulfillment per input sub-type |
| Refinement promotion | Sub-type buckets refine when posterior gap meets MDL gate |
| Latency posteriors | Running mean + variance per holder |
| `installAccessPosterior` + `accessScore` | Wire 3: per-cell access counters |
| `hoistForReader` | Reader contract + budget × posterior projection |
| `installCrossSequence` + `receiveFromPeer` | Bilateral peer forwarding (preserves author) |
| `proposePlan` + `installProposalHandler` + refund | Cross-sequence plan negotiation |
| `searchCandidates` + `executePlan` + `feasibility` | Backward inference |
| `installIndexSpec` | Tuple-product class driver (with `gt`/`lt`/arithmetic, value-bound vars, `op:'delete'` translates to invalidate) |
| `installAgentPrompt` | Substrate-native AGENT_PROMPT_FRAME render via derive chain |
| `installTool` | Mount fn-kind callable cells |
| `buildHoistingFormatter` + `extractFnClaims` | Type rendering with hoisted dedup + identity/preserves/temporal claims |
| `installBlueprint` + `installBlueprintGapsReader` + `installKit` + `installBlueprintOutput` | Blueprint = scope of typed gaps; kit = narrative ordering; output = tool materializes when complete |
| `installWriterAuthority` | v1 sessions.* admission ported (ownerSegmentIndex configurable; `block.cause.ruleId` as systemInternal equivalent) |
| `installSessionLifecycle` + `installHolderRelease` | Active/idle/expired status + release-on-disconnect via index_spec |
| `mintSessionToken` + `validateSessionToken` + `installAuthCaps` + `stampSessionToken` | HMAC-SHA256 typed-authority |
| `captureSnapshot` + `restoreSnapshot` | Permanent-agent handoff (preserves author per cell) |

### Env adapters (`env/`)

- `IStorage` interface (async, browser-compat)
- `NodeStorage` — fs-backed, trusted-root + traversal guards + read cache
- `BrowserStorage` — IndexedDB (auto) or MemoryBackend stub (test)

### Workspace adapter (`workspace-adapter.ts`)

- `createWorkspaceOverSequence(seq?)` → `WorkspaceLike` with `write/read/type/entries/delete/seq`
- FieldType ↔ v2 Type bidirectional conversion (primitive kinds, object
  properties, array values, callable, ref, literal)
- Structural detection of FieldType-shaped writes (looks for `fieldtype`
  string + `attributes` array)
- **NOT IMPLEMENTED**: fork, merge, discard, subscribe, query, undo,
  history, at, pendingSuspensions

### Tests

- 272/272 across 12 test files
- Federation e2e demonstrates: writer-authority across the wire,
  shared-secret token interop, session lifecycle propagation,
  snapshot survives federation, storage round-trip across boundary,
  scope-filtered forwarding (private partitions stay local),
  three-peer + impersonation rejection

## What landed in lens-desktop

### Concrete (uncommitted, on `blueprintgenerator-console`)

- `tsconfig.json` + `jest.config.cjs` — added `@v2/*` and `@v2-type/*` path mappings
- `src/shared/type/test/v2-import-smoke.test.ts` (3 tests) — proves lens-desktop can resolve v2 imports at all
- `src/shared/type/test/v2-backed-workspace.test.ts` (5 tests) — proves lens-desktop's `writeClientCallables` runs against the v2-backed adapter

### Earlier session work, also uncommitted on the same branch

- `src/core/cli/console.ts` — `renderAgentTools` + `renderAgentPrompt` upgraded to AGENT_PROMPT_FRAME shape; exported `mountPromptDerivation`
- `src/shared/service/view.ts` — stripped `[id]` redundancy when `nameDisplay === idDisplay`; added claim-suffix rendering when `node.claims` is present
- `src/shared/procedure/workspaceCompilation.ts` — propagates `metadata.claims` through all 3 `plane.set` sites into `DefinitionPlaneNode`
- `src/core/cli/test/agentPromptFrame.test.ts` — 4 tests, runs against lens-desktop's native Workspace substrate (not v2)

### Test counts

- Lens-desktop full suite: **907/1032** (28 failing — all pre-existing,
  same set fails without my changes; baseline was 880/1009 with 32 failing)

## The strategic open question

**Is the workspace adapter the right migration vehicle?**

### Bridge path (what the adapter assumes)

- Build adapter to expose lens-desktop's existing `Workspace` API surface
- v2 Sequence sits underneath; existing application code unchanged
- Migrate the SUBSTRATE without touching ws.write / ws.read call sites
- Add adapter features (fork/subscribe/etc.) one at a time as needed
- Lens-desktop modules migrate one at a time by swapping `createWorkspace()` → `createWorkspaceOverSequence()`

**Pro**: minimum touch on lens-desktop application code; existing logic keeps working as the substrate moves.

**Con**: carries forward the Workspace API's design choices indefinitely. Workspace assumes `FieldType`, fork-as-isolated-workspace, write-wins semantics, etc. — none of which are v2 idioms. The adapter accumulates indirection and re-implements primitives v2 already has differently. fork, subscribe, query, pendingSuspensions all need bespoke adapter implementations.

### Native path

- Don't bridge. Pick a feature you're going to land anyway (renderer-as-Sequence, distributed cross-sequence over IPC, substrate-native blueprint UI, AGENT_PROMPT_FRAME rendering as actual prompt) and build that feature DIRECTLY in v2 native idiom.
- Lens-desktop modules you're not changing keep running on `createWorkspace()` unchanged.
- Modules you ARE changing (because the feature requires it) get rewritten to use `seq.insert` / fn-kind cells / observation rules / blueprints / etc.
- v1 Workspace eventually withers as more features land natively.

**Pro**: every migrated module is in the actual target idiom — no bridge debt. Code that touches v2 looks like v2.

**Con**: each migration is a real refactor, not a substrate swap. More work per module.

### What pushed the adapter into being

A mid-session pressure to make "v2 actually drives lens-desktop" — the user reasonably observed that v2 was sitting orphan after two months and nothing was running on it. The adapter was the smallest motion that gave a "lens-desktop module on v2" demo. But: it demos a path that may not be the right path.

### Why the adapter feels off

1. **Fork analysis showed**: lens-desktop fork is a CONVENTION over scoped paths + read-fallthrough + invalidate-on-discard. v2 expresses these natively. Adding `fork()` to the adapter means re-implementing what v2 already has via a different API. We'd be wrapping native primitives in legacy API shape.

2. **Hierarchy analysis showed**: lens-desktop's actual architecture (renderer-as-thin-RPC-client to main, per-chat fork, per-agent isolated workspace, lambda-as-snapshot-handoff) maps cleanly onto v2's three primitive boundaries (cross-sequence federation / fork-via-scope / snapshot handoff). Each existing fork/createWorkspace site is one of those three. Bridging hides this mapping behind the Workspace facade.

3. **Renderer has no Workspace today.** It's pure RPC. If we're moving the renderer to its own Sequence (the strategic distributed-architecture move), we're not bridging an existing Workspace there — we're CREATING substrate state in the renderer for the first time. The bridge has nothing to bridge.

### My recommendation (still up to you)

**Drop the adapter as the migration strategy. Keep it as a useful shim for the small case where someone wants to run a Workspace-shaped consumer against v2 in tests.**

Migrate native instead:

1. Pick **renderer-as-Sequence** as the first real change. Renderer currently has no substrate state — it queries main via IPC. Adding a renderer-side v2 Sequence + cross-sequence forwarding to main IS the substrate-native distributed move. No legacy to bridge.

2. The IPC bridge (`headBridge.ts` in main, `preload.ts` in renderer) becomes the cross-sequence transport. `installCrossSequence` on both sides, IPC channel handles the `Outgoing` envelope.

3. One renderer pane (pick the smallest, probably settings or token error) becomes a reader-document on the renderer's Sequence. Substrate-native, renders from local v2 cells, forwards user submissions back to main via cross-sequence.

4. Each subsequent pane migrates the same way. Each migration is also a feature change (substrate-native rendering replaces ad-hoc IPC + Redux).

5. Main process keeps its existing Workspace for everything not touched. Modules that DO get touched (chat, agentRunner) migrate native to v2 — `seq.fork()` becomes either `installCrossSequence` (if cross-process) or scoped-prefix convention (if same-process speculative work).

The 8 tests proving "lens-desktop module on v2 via adapter" are still useful: they prove the v2 substrate is reachable from lens-desktop. They just shouldn't be the migration template.

## What's clearly load-bearing regardless of path

- v2's substrate primitives (kernel + stdlib + env) — keep
- Path mapping `@v2/*` in lens-desktop — keep (any native migration also imports from there)
- The `view.ts` + `workspaceCompilation.ts` cleanups (claim rendering, `[id]` strip) — keep, useful regardless
- The `agentPromptFrame.test.ts` console renderer upgrades — only useful if we keep the lens-desktop console; orthogonal to migration choice

## What's NOT clearly load-bearing

- `createWorkspaceOverSequence` and the FieldType ↔ v2 Type conversion — only useful in bridge path
- `v2-backed-workspace.test.ts` — only proves bridge path
- `v2-import-smoke.test.ts` — useful regardless (proves the path mapping works)

## Open questions for next session

1. **Bridge or native?** Doc above lays out the case for native. User's call.
2. If native: **which renderer pane is smallest** for the first migration? Probably one of: token-error, settings, profile-display.
3. **Fork in v2** — even on the native path, the in-process speculative-execution use cases (chat draft, agentRunner) need a fork primitive. Can be path-prefix scoping convention (no kernel change) or a real `seq.fork()` (kernel addition with copy-on-write). Native path pushes this decision — it's still required.
4. **What does the v1 Workspace's `subscribe(path, fn)` map to in v2 for the renderer use case?** A `phase: 'observation'` rule scoped to the path that calls back out. Adapter could do it; native code would just write the rule directly.
5. **lens-desktop's `headBridge.ts` IPC layer** — does it become the cross-sequence transport, or is it replaced wholesale? If replaced: significant refactor, breaks every renderer api/* file. If wrapped: thinner change. Probably wrap first, replace gradually.

## State of the v2 stdlib that's actually used in this strategy

| Used in native migration | Used in bridge migration |
|---|---|
| Sequence kernel | Sequence kernel |
| installCommitment | installCommitment |
| installCrossSequence + receiveFromPeer | (eventually) |
| installWriterAuthority | (when needed) |
| installSessionLifecycle | (when needed) |
| installAuthCaps + stampSessionToken | (when needed) |
| NodeStorage / BrowserStorage | (when needed) |
| captureSnapshot / restoreSnapshot | (for handoff) |
| installAgentPrompt + installTool | (eventually) |
| installBlueprint + installKit + installBlueprintOutput | (eventually) |
| **NOT NEEDED**: createWorkspaceOverSequence | **CORE**: createWorkspaceOverSequence |
| **NOT NEEDED**: FieldType conversion | **CORE**: FieldType conversion |

## Files modified or added (uncommitted across both repos)

### `~/publicpackages/sequence/src-v2/`
- `sequence.ts` — kernel additions across the session: access axis (Wire 2), gap auto-expand (Wire 1), `BlockTemplate.op`, threading author through cross-sequence
- `stdlib.ts` — ~3500 lines; everything in the table above
- `env/storage.ts` — IStorage + NodeStorage
- `env/browser-storage.ts` — BrowserStorage
- `workspace-adapter.ts` — the bridge (questioned)
- `test/*.test.ts` × 12 — kernel, stdlib, agent-prompt, blueprint, writer-authority, session-lifecycle, auth, storage, browser-storage, snapshot, federation-e2e, workspace-adapter

### `~/lens-desktop/lens-desktop/`
- `tsconfig.json` — added `@v2/*` + `@v2-type/*` paths
- `jest.config.cjs` — same as moduleNameMapper
- `src/core/cli/console.ts` — frame-shape prompt rendering
- `src/shared/service/view.ts` — claim suffix + `[id]` redundancy strip
- `src/shared/procedure/workspaceCompilation.ts` — `metadata.claims` propagation
- `src/core/cli/test/agentPromptFrame.test.ts` — 4 tests
- `src/shared/type/test/v2-import-smoke.test.ts` — 3 tests
- `src/shared/type/test/v2-backed-workspace.test.ts` — 5 tests

### Reverted but worth flagging

- Earlier in session: `KERNEL_V3.md` was deleted, replaced with `EXPAND_PRIMITIVE.md` (the surgical-three-wires framing instead of v3 rewrite)
- v1 memory entries `project_v3_target_expand_primitive` and `feedback_v3_handoff_critical_notes` were deleted, replaced with `project_expand_primitive_surgical`

## What I'd preserve in memory going forward

- v2 has 272 tests, the substrate is real, the federation primitives work end-to-end
- The workspace adapter is a maybe-wrong-path shim, not a strategic asset
- The user has explicitly questioned the bridge approach; native path is on the table
- Lens-desktop renderer has no Workspace today — it's pure IPC RPC. That's an opportunity, not a problem
- v1 Workspace's design choices (FieldType, fork-as-workspace, write-wins) are NOT v2's. Bridge carries them forward as debt.
- "Should the entire system be a hierarchy of sequences?" — yes. Three boundary primitives (cross-sequence, fork, snapshot handoff) cover the three kinds of edges in that hierarchy.
- Convergence in v2 is per-cell suspension: failed merges don't error, they suspend in the cell's block log, retry on temporal cascade. The substrate IS the conflict log.

## Next session, the question I'd start with

> Bridge path or native path? If native: pick the first renderer pane to migrate.
