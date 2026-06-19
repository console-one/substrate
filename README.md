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

## Substrate packages

The kernel and its companion runtime live in two separate repos; this repo composes them
and adds product-specific wiring (`bootstrap.ft`, env adapters, CLI).

| Package | Purpose |
|---|---|
| [`@console-one/sequence`](https://github.com/console-one/sequence) | Append-only behavioral type kernel. One op (`mount`), one data structure (`Sequence`), one protocol (ft text). |
| [`@console-one/sequenceutils`](https://github.com/console-one/sequenceutils) | Companion runtime: indexSpec lifecycle policies, base tools (`fs`/`http`/`schedule`), WebSocket transport, the LLM-agnostic agent loop, and React UI hooks. |

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
│   │   ├── env/                    # unix / docker / lambda / browser adapters
│   │   └── bootstrap.ft            # Workspace class, session/narrative schemas
│   └── test/                       # Product tests
├── packages/stdlib/           # Reusable .ft kits (taskqueue, github, openai)
└── CLAUDE.md                  # AI onboarding / invariants
```

## Build

The substrate packages are published to npm, so this repo builds standalone — no
sibling checkouts required:

```bash
npm install            # pulls @console-one/sequence + sequenceutils from npm
npm run build          # compiles services/office-space
npm test               # product test suite
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
