# Reader-as-Document Convention

The product surface (UI, agent, external API) consumes typed reader contracts as **documents**. There is no other client→server query primitive. To see something, subscribe to a reader that surfaces it.

This is the convention every UI panel, every external tool, and the agent loop's prompt rendering follows. It is the discipline that lets the substrate's existing primitives (cascade, admission, dep-index, partition, visibility) bound queries by construction.

---

## The principle

**Every read is a reader subscription.** The reader contract structurally limits source, filter, depth, and identity-based visibility. Clients do not query paths directly; they subscribe to readers and consume the rendered document.

Three consequences:

1. **Subscription = scope.** The server knows exactly which paths to forward to a client by reading its mounted reader subscriptions.
2. **Identity is enforced once at the reader.** The reader's `hoistForReader` applies visibility filtering before serialization. Masked paths never reach the wire.
3. **The UI cannot leak.** A view that wants to show a path must declare a reader. Adding a reader is the architectural commit; rendering is just hoist.

## Navigation axes

Two orthogonal axes:

- **Identity** — who is the reader. Determines visibility and writer-authority. Mounted at `client.identity`.
- **Reader contract (selection)** — which named contract is being rendered. Each contract IS a document template. Mounted at `client.tabs.{id}.reader`.

Per-contract args (scope, depth, filter, time-mode) are parameters of the chosen contract, not orthogonal degrees of freedom.

Tabs = N concurrent (identity, reader, args) tuples. Tab-switching = changing focus among already-subscribed tuples.

## Reader contract shape

A reader is type-state mounted at `_readers.{name}.*`. Properties (read by `hoistForReader`):

| Property | Type | Purpose |
|---|---|---|
| `source` | string | Path glob the reader projects (e.g. `state.tool_instances.*`). Required. |
| `mode` | `stable` \| `history` \| `implications` | `stable` = current values, `history` = `_blocks.*` log filtered, `implications` = traverse `_deps.*`. Default `stable`. |
| `filter` | string (optional) | Path-prefix or constraint name to further narrow what's emitted. |
| `limit` | number (optional) | Max child entries emitted; remainder summarized as expand token. |
| `depth` | number | Hoist recursion depth. Default 3. |
| `render` | string (optional) | Render hint passed through to the consumer. |
| `sink` | string (optional) | Where filled values get mounted (for write-back surfaces). |

Mount example:

```ft
_readers.tools.source = "state.tool_instances.*"
_readers.tools.mode = "stable"
_readers.tools.depth = 4
```

Consumer:

```ts
const { text } = hoistForReader(seq, 'tools');
```

The output is valid ft text — round-trippable through the parser. Same surface for UI, LLM prompt, external API.

## v1 readers

Five reader contracts cover the lens-desktop-equivalent surface. Each is one mount of `_readers.{name}.*` at server boot plus a UI panel or agent consumer.

| Reader | Source | Mode | Renders |
|---|---|---|---|
| `tools` | `state.tool_instances.*` | stable | Installed tools — per-instance config, contract paths, current usage/quota/reliability state, contract input surface |
| `blockers` | `*` (filtered to gaps minus self-resolving infra) | stable | All unresolved inputs as a flat list with their constraints. Filling a gap = mounting at the path it surfaces; same form for kit installation. |
| `narratives.{threadId}` | `narratives.{threadId}.*` | stable | A thread document — posts in chronological order, contributors, label backlinks |
| `anticipations` | suspended blocks | history | Suspended blocks whose `where` contains `gt('_rt', T)` — the substrate's own future events surfaced as a timeline. No `.fireAt` sidecar field. |
| `agent_runs.{agentId}` | `agents.{agentId}.turns.*` | stable | The agent loop's turn records — prompt, response, applied paths, violations, unresolved counts per turn |

Adding a sixth reader (e.g. `inbox`, `audit_log`, `permissions`) follows the same shape — one mount plus one consumer.

## What this is NOT

- **Not a routing system.** No URLs. Tabs are objects in client state.
- **Not a query language.** Filters are reader-contract attributes set at design time, not user-typed strings.
- **Not page navigation.** Closer to "open a document" + "switch focus."

## What's already there

- `hoistForReader(seq, name)` exists in `packages/core/src/hoist.ts`. Reads `_readers.{name}.*`, projects per source/filter/limit/depth/mode.
- Visibility filtering via `meta.visibility` constraints — masked paths never serialize.
- `OfficeSpaceClient.render(readerName?)` and `window.officeSpace.render(name)` consume reader contracts directly.

## What's not yet there

- **Per-reader server forwarding.** The current server emits all non-internal deltas to every connected client. The right model is: server reads each client's mounted reader subscriptions, forwards only deltas to paths covered by their sources. Client-side: re-render the relevant reader on each delta.
- **Tab navigation tools** — `client.nav.open / update / close / focus` typed fns. Mount at `client.tabs.*` to track concurrent subscriptions.
- **Write-back via `sink`** — when a reader has a `sink` declared, the consumer can post values that mount at the sink path. Generalizes BlockersPage's "fill this form."

## Cuts

- **D1**: `tools` reader + UI panel + round-trip test.
- **D2**: `blockers` reader + form rendering of constraints (kit installation falls out).
- **D3**: `narratives` reader + label backlinks + `agent_runs` reader rendering today's turn records inline.
- **D4**: `anticipations` reader + tab navigation tools + per-reader server forwarding.

Each cut ships a usable screen. Each is a UI/flow session, not a substrate session.
