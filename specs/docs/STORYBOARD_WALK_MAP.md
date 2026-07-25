# The Storyboard Walk — materialization map

**2026-07-25. The architecture record for materializing the 12-beat
vending storyboard as an interactive CLI + CI-regenerated GIF in this
repo. Decisions below are grounded in a full survey of this repo and
the sequence checkout (both trees), not inherited assumptions.**

The storyboard itself (the 12 beats, the ratchet-ledger contract, the
comment-strip guard) ships as `STORYBOARD_WALK.md` next to the walk
code. This file records *why the build is shaped the way it is*.

## The problem this map answers

The walk needs three things at once: **vend** (tool compilation with
budget/expansion/prelude — beats 5/8), **observed posteriors** (the
conjugate learning loop — beat 9), and **structured validity/merge**
(temporal gates, survival bands, compose — beats 8/11/12). At survey
time these lived on *different trees* of `@console-one/sequence`:

- `vend`/`continueSession` — v1 only (`src/vend.ts`, binds the v1
  `Sequence` mount vocabulary; its validity line is a `--` comment,
  which the comment-strip guard bans by design).
- `conjugateUpdate`/`survival`/`planFeasibility`/`compose`/
  `timeHorizon`/`selectUnderPrices` — canonical on v2
  (`src-v2/index.ts`; the math is singly-sourced in `src/compose.ts`
  and re-exported — NOT forked).
- The v2 kernel (`src-v2/sequence.ts`) is THE kernel going forward;
  this repo's own stage-3 commit re-pointed storage/auth onto `/v2`,
  but the running office-space server is still v1 beneath that seam
  (via `sequenceutils/transport`), and the sequence README teaches the
  v1 root import.

Verified compatibility facts the port relies on:
- v2 read surface matches v1 where vend reads: `get`, `keys`,
  `typeAt`/`rawTypeAt`; clock is `now()` (v1: `.realtime`).
- v2 write surface differs entirely: `insert({path, value?, type?,
  rules?, where?})` — no `mount('bind'|'schema'|'tool')` vocabulary.
- v1 `receive()` (the full DSL walker) is hard-bound to v1 mounts.
  v2 has `receiveCalls` — the *call subset* only (its header names
  itself stage 1 of the v1 deletion ledger).
- The clause layer parses AND enforces on receive today: refinement
  predicates reject at admission; `~survival(exp, r)` /
  `~lognormal(mu, sigma)` suffixes on functions mount alongside;
  `while`/`when` gates suspend; `@[T..T)` intervals parse.
  (`src/test/dsl-clauses.test.ts`, `specs/impl/SYNTAX_SUPPORTED.md`.)
- `pm(center, margin)` exists as a typed Expr + compose evaluation but
  has NO DSL surface syntax yet — emission/parse is a small shared-
  parser addition, scoped below.

## Decisions

**D1 — The walk runs end-to-end on the v2 kernel, in-process.** No
`sequenceutils/transport`, no WebSocket server: the walk is a CLI
driving v2 `Sequence` instances directly (beats 11/12 use two or three
in-process kernels). Extending `ContextGraphServer` would compound v1
debt on new work.

**D2 — vend ports to v2: `src-v2/vend.ts`.** Selection, budget,
prelude dedupe, docGroup variant election port near-verbatim (read-
only). Session record becomes `insert()`. The v1 module stays until
the deletion ledger strikes it; the sequence README re-points to the
v2 import in the same change (the doc divergence was the sharpest
public defect found).

**D3 — v2 gains document receive for the vend grammar: stage 2 of the
deletion ledger.** Not a port of the 943-line v1 walker — a receive
for exactly the definition-set subset vend emits (fn definitions with
constraint suffixes, `tool` marks, binds), built on the *shared*
parser, emitting `insert()`. Its correctness test is the round-trip
law: a second v2 kernel receiving a vended document gains the tools,
constraints intact and queryable.

**D4 — Nothing load-bearing in `--` comments.** The v2 vend emits:
validity as a temporal constraint (the `lte($now, T)` family that
`src-v2/validity.ts` `timeHorizon` already reads), reliability as
`~survival`/distribution suffixes sourced from mounted posteriors,
cost slopes as `pm(center, margin)` once the parser addition lands.
The standing guard: strip every `--` line from a vended frame — all
merge/planner/expiry/constraint assertions must still pass.

**D5 — The walk lives here**, in `services/office-space`, as a new
subcommand: `office-space walk` (interactive, beat by beat) and
`office-space walk --scripted` (deterministic; drives CI and the GIF).
The test artifact is the storyboard walk suite + `STORYBOARD_LEDGER
.json`: a beat not in the ledger must pass; a ledgered beat that
starts passing fails the suite until struck. Injected clocks only; the
agent side is a fixed script labeled operator-scripted.

**D6 — The connector is a local mailbox simulator, honestly labeled.**
Its manifest is pure data (install is data — beat 2) and carries the
beat-6 temporal metadata fields (cacheable/hydratable, throughput,
TTL). Reliability and cost annotations are observed posteriors of real
local calls through the same code path in demo and test; the test
asserts posterior *movement* (observation → conjugate update → next
vend differs), never a manufactured constant presented as observed.

**D7 — Public hygiene.** Absolute `/Users/...` paths in
`specs/notes/REPO_COMPARISON.md` get rewritten; the pasted-transcript
draft gets its browser chrome stripped and any redaction made visible;
private verbatim dictation never enters this repo.

**D8 — The README tells the truth.** Quickstart for a stranger today:
clone this repo and the sequence repo as siblings (`file:` deps),
install, run the walk. npm-standalone install is documented as pending
a registry publish (not this repo's lane to perform).

**D9 — The GIF cannot lie.** A vhs-style tape is checked in; CI
regenerates the GIF from the tape on every push. The byte-stable
un-liable property is the scripted walk's text transcript matched
against a golden; the GIF in the repo is only ever produced by CI from
the tape — never hand-recorded.

## Beat → primitive (survey result, v2-canonical)

| Beat | Primitive today | Tree | Gap for the walk |
|---|---|---|---|
| 1, 5 | `resolveDoc`/`docGroup` election in vend | v1 → port (D2) | label-only transclusion at frame time |
| 2 | `KitInstaller` (`env/installer.ts`); dead connector JSON unwired | v1-bound | manifest-as-data path on v2 |
| 3 | typed-authority pattern (`TYPED_AUTHORITY.md`), `identity()`/`producedBy` in shared vocabulary | shared | wiring: alias-only addressing in the walk |
| 4 | kit records + shared `law`/`not`/`oneOf` constructors | mixed | verb exclusion as retained constraint at bind |
| 6 | nothing (dead JSON has no temporal fields) | — | manifest fields, data only |
| 7 | nothing (sqlite present but unrelated) | — | hydration offer + accounting facts |
| 8 | vend v0 shape (budget/expansion/prelude); clause layer enforces | v1 → port (D2–D4) | structured annotations, duration-hydration, CLI verb |
| 9 | `conjugateUpdate` + `installReliability` rules | v2 | thread observations → next vend |
| 10 | `producedBy`, trace vocabulary | shared | capability-grain query |
| 11 | `compose` ("tightest consistent; contradictory → never"), `planFeasibility` | shared, v2-exported | merge of two *vended frames* |
| 12 | `installCrossSequence`/`receiveFromPeer` (v2), `covers` | v2 | the closure pipeline: receive-as-install → narrow → re-vend |

Beats whose machinery does not exist yet enter the walk LEDGERED —
present as stages, failing loudly, struck only when built. The walk
being honest about what is unbuilt is part of the product claim, not a
caveat to it.

## Build order

1. sequence: `src-v2/vend.ts` port + definition-subset receive (D2,
   D3) + `pm` surface syntax (D4) — with the reworked endstate suite
   (the uncommitted V1–V10 drafts, re-based to v2 and re-cut to serve
   beats 5/8/9) as the gate.
2. substrate: mailbox sim + manifest (D6), walk subcommand + storyboard
   suite + ledger + comment-strip guard (D5).
3. substrate: README truth (D8), hygiene (D7).
4. GIF tape + CI regeneration (D9).
