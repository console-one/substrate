# @console-one/substrate

The `ft` library — event orchestration across agents and users, built on the
[`@console-one/sequence`](https://github.com/console-one/sequence) substrate. This
repository is the **Office Space** product composition: a deployable server, clients,
and deployment adapters assembled from the substrate packages, adding persistent
narratives, offline-capable clients, permanent agents, and bilateral gap exchange over
WebSocket.

It is a **prototype** — the original, working implementation of the principal build
concepts behind [Shared Office](https://sharedoffice.ai): a shared belief system with a
clock and a budget, where memory, the calendar, the scheduler, and an agent's context
window are projections of one append-only fact space. This repo predates and informs the
shipped product; treat it as a reference prototype rather than the maintained release.

## Quickstart: THE STORYBOARD WALK

![The storyboard walk](docs/walk.gif)

The fastest way to understand what this substrate does is to walk the
12-beat storyboard in your terminal — a dev hands their context
(narratives) and a workflow (personal mail) to LLM agents, safely,
priced, accountable:

```bash
# Node 22+ · the kernel comes from npm: @console-one/sequence ≥0.2.0
git clone https://github.com/console-one/substrate
cd substrate && npm install
cd services/office-space
node bin/office-space.cjs walk              # interactive, one beat at a time
node bin/office-space.cjs walk --scripted   # full transcript at once
```

(Hacking on the kernel itself alongside? Point the dep at your local
checkout — `npm install ../../../sequence` from `services/office-space`
— and everything below still holds.)

You will watch: labeled narrative variants elected by budget · a
connector installed as pure DATA · a secret addressable by alias only ·
a capability whose excluded verb the kernel refuses **forever** · local
SQL hydration whose extent is a fact · an FT frame whose reliability
numbers are **observed posteriors of real local calls** (never authored
— the connector is a labeled simulator, the measurements are not) · a
learning loop where the next frame's annotations have moved · two
frames merged into one surface (conflicts named, never silently
overwritten) · and the closure: a re-vended grant that can only narrow
and tighten, with the full chain reported back to its origin. All 12
beats are enforced; the ratchet ledger that once held the unbuilt ones
is empty — and stays wired so any regression, or any future beat, fails
loudly. The full spec:
[`specs/docs/STORYBOARD_WALK.md`](specs/docs/STORYBOARD_WALK.md).


## Substrate packages

The kernel and its companion runtime live in two separate repos; this repo composes them
and adds product-specific wiring (`bootstrap.ft`, env adapters, CLI).

| Package | Purpose |
|---|---|
| [`@console-one/sequence`](https://github.com/console-one/sequence) | The behavioral type kernel. **The canonical engine is v2** (`@console-one/sequence/v2`): one op (`insert`), one algorithm (traverse → admit → compose → propagate), features as rules. The package root still exports the superseded v1 engine plus the shared type/DSL vocabulary both engines use; new work consumes `/v2`. |
| [`@console-one/sequenceutils`](https://github.com/console-one/sequenceutils) | Companion runtime: indexSpec lifecycle policies, base tools (`fs`/`http`/`schedule`), WebSocket transport, the LLM-agnostic agent loop, and React UI hooks. (v1-era; superseded piecewise by the kernel repo's `src-v2` per its deletion ledger.) |

The authoritative substrate docs (types, compose, cascade, partitions, invariants) live
in the kernel repo's specs.

## Structure

```
substrate/
├── services/office-space/     # Product composition — server, CLI, env adapters
│   ├── src/
│   │   ├── office-space-server.ts  # Composed ContextGraphServer (policies + tools)
│   │   ├── agent.ts                # PermanentAgent — serialisable agent runtime
│   │   ├── index.ts                # office-space CLI entry point
│   │   ├── walk/                   # THE STORYBOARD WALK — 12 beats on the v2 kernel
│   │   ├── env/                    # unix / docker / lambda / browser adapters
│   │   └── bootstrap.ft            # Workspace class, session/narrative schemas
│   └── test/                       # Product tests (incl. the walk's ratchet suite)
├── packages/stdlib/           # Reusable .ft kits (taskqueue, github, openai)
└── CLAUDE.md                  # AI onboarding / invariants
```

## Build

```bash
npm install            # resolves the file: deps against the sibling checkouts
npm run build          # compiles services/office-space
npm test               # product test suite (includes the storyboard walk)
npm start              # boots the server on :3100
```

## Run the server

```bash
cd services/office-space
npm run build
node dist/index.js start
```

Environment:

- `PORT` — listen port (default 3100)
- `DB_PATH` — sqlite file (default `./contextgraph.db`)
- `SNAPSHOT_FT_PATH` — optional ft file to restore state at boot

## License

MIT © zerotoprod
