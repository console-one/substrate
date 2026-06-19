# Sequence Nodes — The Live System Architecture

Persistent record of the topology decision and the end-to-end
coherence test that's the v1 deliverable. This doc is the north
star — keep it current as the work lands.

## Reframe

There is no "server" and no "client." Every process is a
**Sequence node**:

- Runs one `Sequence` instance.
- Has an identity.
- Has some set of peers (upstream, downstream, or both).
- Links to peers via bilateral gap exchange over WebSocket — the
  same protocol at every hop, no matter the tier.

Some nodes listen (accept downstream peers). Some dial (connect
to an upstream peer). Most do both. Today's `ContextGraphServer`
is a listen-only node; `OfficeSpaceClient` is a dial-only node.
A process that runs BOTH halves, sharing one `Sequence`, is the
composition primitive — and it's the shape every non-browser,
non-leaf-scheduler node takes in the deployed system.

The recursion collapses the design: the relationship User Session
has to Org Scheduler is the same relationship Browser has to User
Session. Same protocol, same kernel, same bilateral gap exchange,
same reader tools. No special cases.

## Coherence Test (North Star)

The v1 deliverable is a live, running system where a mount in one
browser propagates through FIVE Sequences to appear in another
browser, without corruption, race, or loss.

```
Browser A  ─►  User A Session  ─►  Org Scheduler  ─►  User B Session  ─►  Browser B
    (1)            (2)                 (3)                 (4)               (5)
```

Four bilateral links. Identical protocol at each hop.

**Unit tests are noise if this doesn't cohere.** The 670 green
tests in packages/core and 231 in contextgraph say nothing about
whether the system works. The only meaningful green signal is:
spin up the processes, open the browsers, act in one, observe the
effect in the other.

Stop adding unit tests until the five-Sequence flow is live.

## Deployment Shape (Two-User Test)

Five Sequences, four separate processes on the server side plus
two browser tabs:

| Process         | Identity               | Server-half         | Client-half                |
|-----------------|------------------------|---------------------|----------------------------|
| Org Scheduler   | `org`                  | listens on `P_org`  | none                       |
| User A Session  | `user:alice`           | listens on `P_alice`| dials `ws://org:P_org`     |
| User B Session  | `user:bob`             | listens on `P_bob`  | dials `ws://org:P_org`     |
| Browser A       | `browser:alice:tab1`   | none                | dials `ws://host:P_alice`  |
| Browser B       | `browser:bob:tab1`     | none                | dials `ws://host:P_bob`    |

User A Session and User B Session are the same binary with
different config (user identity, upstream URL, listen port).
Org Scheduler is that same binary too, with no upstream configured
(listen-only).

A single shape for every server-side process. Deployment is a
matter of topology, not of distinct service kinds.

## Composition Primitive

A Sequence node that runs both halves, sharing one Sequence:

```typescript
const seq = new Sequence(() => Date.now());

const server = new ContextGraphServer({
  seq,  // shared instance
  port,
  // ...
});

const client = upstreamUrl
  ? new OfficeSpaceClient({
      seq,            // SAME shared instance
      serverUrl: upstreamUrl,
      user: identity,
      // ...
    })
  : null;

await server.start();
await client?.boot();
```

The current code does not support this: both `ContextGraphServer`
and `OfficeSpaceClient` construct their own `Sequence` internally.
First work item is making the Sequence injectable on both sides.

Once injectable, any process can be any node type by configuring
its identity, listen port, and upstream URL. Leaf browsers use
`runBrowserEnv` (client-only, no shared Sequence needed since
there's no server-half). Everything else on the tree uses the
composition primitive.

## Work Plan

### Stage 1 — Composition primitive

- Refactor `ContextGraphServer` to accept an optional `seq` in
  config (inject vs. construct).
- Refactor `OfficeSpaceClient` to accept an optional `seq` in
  config.
- Two-process test (Node-land, no browsers yet): spawn an Org
  Scheduler and one User Session as separate processes. Mount a
  value at the User Session; observe it propagate through the
  bilateral link and land at the Org Scheduler. Reverse direction
  too.

### Stage 2 — Real browser clients

- Bundle `runBrowserEnv` for browser target. esbuild with
  `--platform=browser` plus stubs for `ws` / `fs` / `path`
  (unreachable on the browser code paths but referenced at
  module load). This was started (see `browser-stubs/ws-stub.ts`)
  and interrupted before the entry and config landed.
- Serve the bundle from the server's HTTP handler next to
  `ui.html`.
- Rewrite `ui.html` to a hoist-console: subscribe to the client's
  `render` event, display the ft text in a `<pre>`, send mounts
  via a textarea. No task-specific code.
- Prove: one browser tab connects to one user session (running
  alone, no scheduler yet), hoist renders, an edit in the
  textarea appears back in the hoist stream.

### Stage 3 — Full topology

- Spawn four server-side processes (org scheduler, two user
  sessions) plus two browser tabs.
- Open Browser A and Browser B, each pointed at its respective
  User Session.
- Prove: a mount in Browser A traverses all four bilateral links
  and appears in Browser B. Symmetric for Browser B.

## Open Questions

These affect correctness, not implementation order. They need
concrete answers before Stage 3 is "done":

- **Forwarding scope.** Which paths does a User Session forward
  up to the Org Scheduler, and which stay local? Reader contracts
  at the upstream link define this. The contract schema needs to
  exist and be testable; a too-wide reader leaks private state, a
  too-narrow one breaks coordination. Current plan: use a reader
  contract named `org_exchange` mounted at the session Sequence,
  scoped to an `org.*` subtree.
- **Identity and provenance across hops.** A mount traveling from
  Browser A through User A Session to Org Scheduler needs to
  preserve provenance. Writer-authority admission has to admit
  the User Session process as the effective author at the
  org-scheduler boundary, while attribute downstream stays
  `alice`. The typed-authority memo and the session-token work
  are the starting points, but cross-hop attribution isn't wired.
- **Conflict resolution on convergence.** If Browser A and
  Browser B both mount competing values at paths that converge in
  the Org Scheduler, what happens? The kernel's `compose` is
  lattice meet — tightest type consistent with both — so
  convergence has a well-defined semantics (never = contradiction,
  surface as a gap). But no test case proves this at the
  multi-Sequence level, and the UX for surfacing contradictions
  to users doesn't exist.
- **Reconnect and delta replay.** A User Session that reconnects
  to the Org Scheduler after a disconnect needs to catch up.
  Today the server sends a full hoist on connect, not deltas
  since last seen. For brief flaps that's fine; for long outages
  it's expensive. Probably fine for v1; note for v2.

## Trace / Cursor / Replay — Status

The v1 coherence work surfaced a performance diagnostic question
("why does 10 concurrent mounts take 21s to converge across four
bilateral links?") that led to a broader architectural clarification:
*cursor-based block queries are not a new primitive to invent.*

What the existing system already gives us for cross-process trace
subscription and historical replay:

- **Streams as indexed children under a prefix** — `specs/requirements/streams/api.md` R1-R7. Path hierarchy plus schema plus indexed children is the primitive. No stream-specific operations.
- **`indexSpec({ indexedBy, where, body })`** — `@ft/core` — the DynamoDB-style secondary index primitive. `bindFrom($var, 'glob.path')` introduces free variables; `where` clauses project a tuple space; `body` fires per tuple with `{var}` interpolation. Maintained incrementally by `runIndexConstraints` on every mount. Label-rules (25 lines) is the working precedent.
- **`specs/requirements/contextgraph/indexgeneration.md`** — R1-R8 — the authoritative spec for predicate-based secondary indexes: structural predicate → index maintains path set → incremental maintenance on mutation → subtype predicates filter parent index → utilization tracking.
- **`specs/requirements/contextgraph/provisionalshard.md`** — range delegation. Parent owns a full partition; spawns shard for a sub-range with snapshot + schemas + policies; drain-merge-release lifecycle. A sub-range nobody owns locally is a gap — not something the Sequence fabricates.

What landed this session on this thread:

- **Emission tool visibility** now allows `_blocks.*`, `_labels.*`, and `_indexes.*` prefixes through to peers (previously a blanket `_` skip). This unblocks `indexSpec`-based trace consumers: a client mounts an `indexSpec` that projects over `_blocks.*` or `_indexes.*`, the maintained set reaches the client via the existing delta stream, no new transport required. The rule stays hardcoded in `server.ts` for now — the principled version makes visibility a declared constraint on the reader contract itself.

What did NOT land and why:

- **Mirroring full block metadata to `_blocks.{seq}.*`** (time, author, status, paths) was attempted and reverted. The kernel's current `keys()` implementation linearly scans all of `proj.values`, so making `_blocks.*` dense (every block gets a child instead of only labeled blocks) multiplied label-rules' `bindFrom('seq', '_blocks.*')` enumeration cost by the number of mutations ever, pushing `runIndexConstraints`' fixpoint passes past the chat-convergence test's per-step timeout. The fix is kernel R2/R3 from indexgeneration.md — an incremental children-index on every `proj.values.set`/`.delete` so `keys(prefix)` is O(1) lookup. A comment block in `sequence.ts` around the label write records the follow-up.

With the children-index landed, the block mirror can land safely, and trace consumers become declarative:

```
// in a consumer's own ft state:
_indexes.myTrace = indexSpec({
  indexedBy: ['seq'],
  where: [
    bindFrom('seq', '_blocks.*'),
    gt('_blocks.{seq}.time', someCursor),
    // whatever other dimensions
  ],
  body: [
    { op: 'bind', path: '_indexes.myTrace.result.{seq}', value: true },
  ],
})
```

No `appliedSince`. No `BlockFilter` type. No new transport. The existing
cascade maintains the set; the existing emission stream delivers
updates; the consumer's local Sequence holds the result. Historical
replay is the same shape with a bounded-cursor variant. Sub-ranges
too large or too hot to hold locally get delegated via
provisionalshard — requests for unowned ranges surface as gaps, not
fabricated results.

## Known Gotchas Surfaced During v1 Coherence Work

These aren't blockers; they're behaviors to be aware of and fix
properly as the product evolves:

- **Objects hide their own values in `hoist()`.** When you mount
  `path = { a: 1, b: 2 }`, the kernel writes `path.a._provenance`
  and `path.b._provenance` sidecars. `hoist()` only emits a
  `path = VALUE` line when the path has no children; the provenance
  sidecars count as children, so the actual object value never
  appears in the rendered ft text. Parent-value emission needs a
  fix (filter provenance sidecars out of `hoist`'s children, or
  render the parent inline regardless). Workaround in
  `stage3-chat-convergence-test.ts`: use string values instead of
  objects for collection items.

- **The DSL parser treats `-` as minus inside path identifiers.**
  So `alice-1` is `alice - 1`, not a path segment. Use `_` or
  camelCase. The lexer could be taught to distinguish, but for now
  this is a naming convention.

- **The walker emits `x = value` as TWO mounts (literal schema +
  bind).** Combined with per-peer emission tools, a single source
  mount traverses the topology with ~4 applies at each node.
  Bounded, idempotent, converges — but noisy. Either kernel-level
  short-circuit on same-value binds, or mutable-mode `receive` by
  default for wire-protocol mounts, would fix this.

- **Literal schemas lock paths.** After `path = "hello"`, re-mounting
  `path = "world"` would fail — the first mount installed a
  literal-value schema. Mutable state needs either explicit
  `{ mutable: true }` to `receive` (strips literal schema emission)
  or a schema-overriding narrow. This is tracked in a server.ts
  NOTE block; affects the current heartbeat flow.

- **Burst convergence is correct but slow.** Ten concurrent mounts
  from two browsers converge in ~20s, not <1s. The bounded
  redundancy above amplifies the time. Not a correctness issue;
  measurable optimization after the double-mount fix.

## Invariants (What Not To Regress)

- **Every connection is bilateral gap exchange.** Don't special-
  case a link because "it's internal." The protocol at
  User↔Scheduler is identical to Browser↔User.
- **One Sequence per process.** Don't run multiple Sequences in
  one process to "simulate" the topology. The recursion requires
  each node to BE a process, including its own scheduling clock,
  its own persistence boundary, its own blast radius.
- **Hoist output is ft text; all wire protocol is ft text.** No
  JSON codec at any link. Round-trippable through receive().
- **Reader contracts define what flows.** Not procedural
  forwarding code. A new forwarding rule is a reader contract
  mount, not a new handler function.

## Status

| Stage | Status | Notes |
|-------|--------|-------|
| Composition primitive | **landed** | `seq?: Sequence` injectable on `ContextGraphServer` and `OfficeSpaceClient`; `runSequenceNode` in `src/sequence-node.ts` composes both halves over one shared Sequence |
| Two-process Stage 1 test | **passing** | `scripts/stage1-bilateral-test.ts` |
| Cross-tier forwarding | **landed** | `MountResult.author` + `#upstream` tag + `onBlockApplied` forwarder. Known bounded redundancy from walker's schema+bind double mount; converges. |
| Three-process Stage 2 test | **passing** | `scripts/stage2-cross-tier-test.ts` |
| Five-Sequence Stage 3 test (Node stand-ins) | **passing** | `scripts/stage3-five-sequence-test.ts` — 5 real processes, 4 bilateral links, full topology |
| Real browser bundle | **landed** | `scripts/build-web.cjs` (esbuild + ws/fs/path stubs); `src/browser-entry.ts` registers `window.officeSpace`; server serves `/bundle.js` next to `ui.html`; ui.html rewritten as a hoist-console shell |
| **Five-Sequence end-to-end with real browsers** | **passing — v1 DELIVERABLE IS LIVE** | `scripts/stage3-browser-test.ts` spawns org + 2 user sessions as real processes, then hosts two `dist-web/bundle.js` instances inside jsdom (with Node `ws` injected as `window.WebSocket`). `browser-A.officeSpace.mount(...)` propagates through all four bilateral links and shows up in `browser-B.officeSpace.render()`; reverse direction verified too. The same bundle runs in Chrome. |
| **Chat convergence (multi-user collaborative shape)** | **passing** | `scripts/stage3-chat-convergence-test.ts` — each message is a string at a unique path (`chat.room1.messages.{author}_{n}`), both browsers write concurrently, both converge on the same set. Three tests: single messages each direction, six-message sequential set, ten-message concurrent burst. 16 total messages from two users land on both browsers with matching values. Known gotchas recorded below. |
| **Agent cycle — Cut A (gap → agent → tool → result)** | **passing** | `scripts/stage3-agent-cycle-test.ts` — `browser-A → user-A → org ← agent` topology; alice mounts `work.{id}.a` and `work.{id}.b`; an AgentWorker (plain `OfficeSpaceClient` with a tool-callback registered for the `changes` event) sees the task arriving, sums the inputs, mounts `work.{id}.sum`. Three sub-tests: (1) single task end-to-end; (2) concurrent burst of three tasks; (3) agent restart — agent shut down mid-session, alice mounts j5, no answer appears; a fresh agent boots and picks up j5 from its initial hoist snapshot. Task shape is append-only (no status field — presence of `sum` = done) so no `__MUT__\n` wire wrap is needed. LLM-backed tools are the same shape with a different tool impl; Lambda runtime is the agent-restart case wrapped in cold-start lifecycle. A kernel-level bug surfaced and fixed during this work: server-generated client IDs formerly used hyphens (`c-{ts}-{suffix}`), which the ft DSL parser reads as subtraction, so any initial hoist snapshot containing hyphenated peer IDs failed `receive()` as one block and left late-joining clients with no state. Changed to underscore separators (`c_{ts}_{suffix}`). Fix landed in `server.ts`; three test regexes updated. |
| **Workspace UI — Cut B (UI as reader projection)** | **passing** | `scripts/stage3-workspace-primitives-test.ts` — proves the three API exposures `window.officeSpace.keys/get/gaps` the new `ui.html` workspace shell depends on. Five tests through the 5-Sequence topology: alice sees three files bob mounted; alice reads bob's content via `get('files.{id}.content')`; alice's edit reaches bob's local Sequence; new file created at runtime shows up in both sides' `keys('files')`; `gaps()` returns a well-typed array. `ui.html` restructured from a raw `<pre>` into a three-panel workspace (file list sidebar + selected-file textarea + gaps panel + collapsible debug hoist). Real Chrome tab at `/ui.html` renders the same structure — the bundle is the same one jsdom runs. |
| **Dual editor — Cut C (shared-mutable-state primitive)** | **passing** | `scripts/stage3-dual-editor-test.ts` — Alice in jsdom browser, Bob as plain Node `OfficeSpaceClient`, both edit one path `files.tasks.ft.content`. Six tests: alice→bob, bob→alice, three alternating round-trips, rapid-fire LWW convergence, `getAt(path, seq)` historical read returning 20 distinct values, offline-edit + auto-reconnect (Bob disconnects, makes 3 offline edits queued in `pendingBuffer`, auto-reconnects, Alice receives the final offline value, buffer drains). Wire extension: `__MUT__\n` prefix marker (both directions) strips the walker's literal-schema emission for `files.*` paths so successive overwrites compose. `client.mount(text, {mutable: true})` is the opt-in. `ui.html` textarea wired to the same path — real Chrome can participate as a third editor without protocol changes. |

## How to Update This Doc

- Status table at the bottom — flip entries as stages land.
- Open Questions — add decisions inline (strike-through, or move
  to a Decisions section) as they resolve. Don't delete — the
  reasoning is load-bearing for whoever picks this up next.
- Deployment Shape — update identities/ports if the config shape
  changes.
- Invariants — append when a new "don't regress this" lesson
  comes out of an implementation round. Removing one requires
  explicit justification.

Next session should read this doc first, run the status table,
and pick up where it says "not started."
