# THE STORYBOARD WALK — 12 beats in your terminal

```
cd services/office-space
node bin/office-space.cjs walk              # interactive, one beat at a time
node bin/office-space.cjs walk --scripted   # full transcript, CI mode
```

The walk is the product's end-state spec made executable: a dev with
context (narratives about their team and themselves) and a workflow
(personal mail) hands both to LLM agents — safely, priced, accountable.
The connector is a **local mailbox simulator, labeled as such**; what
is *not* simulated is every number the system shows you: reliability
and latency annotations are conjugate posteriors of real measured
local calls. No posterior, no annotation. The first manufactured
number would poison the whole thesis, so there are none.

## The beats

| # | The dev does | Passes when… | Today |
|---|---|---|---|
| 1 | Writes short/medium/long narratives about the TEAM and THEMSELVES | A label reference alone (`[[narratives.self]]`) resolves to ONE budget-suitable variant | **PASS** |
| 2 | Browses connectors, installs the mailbox one | Install is DATA (an ft manifest) — no compiled connector code | **PASS** |
| 3 | Stores a key for their personal mail | Addressable by alias only; the service really refuses without it; the value never rides a frame or a usage fact | **PASS** |
| 4 | Creates a KIT: key alias injected + email-WRITING filtered out | The exclusion is a kernel ADMISSION RULE — any future mount at the excluded verb is refused, forever, queryably | **PASS** |
| 5 | Describes the capability, transcluding narratives BY LABEL ONLY | The description carries `[[narratives.self]]` unresolved; variant election happens at FRAME time, by budget | **PASS** |
| 6 | (Connector author) manifest carries per-API temporal metadata | cacheable/hydratable/TTL/throughput are kernel-readable facts | **PASS** |
| 7 | Install offers "save emails locally?" → yes | The offer DERIVES from beat-6 metadata; rows land in real SQL tables; the extent is a queryable fact | **PASS** |
| 8 | `office-space walk` frames the capability (`--maxtokens 2000 --duration 100s` shape) | Budget-true · observed annotations only · every load-bearing fact a receivable statement (strip all `--` comments → a fresh kernel reconstructs the same tools, expiry and reliability) | **PASS** |
| 9 | An agent (fixed script, labeled) calls a tool through the frame | Real observation → conjugate update → the NEXT frame's annotations have moved | **PASS** |
| 10 | "Where was my mail used, for what?" | Usage queryable at the capability grain, key-free | **PASS** |
| 11 | Two vended frames → one merged surface | Merge is compose: same tool → tightest consistent; genuine conflict → named `never` | **LEDGERED** (kernel V17) |
| 12 | Office B installs A's frame AS A CONNECTOR, narrows, re-vends to C | Closure: monotone narrowing ✓ and temporal meet ✓ hold today; chain-grained provenance ledgers the beat | **LEDGERED** (kernel V19) |

## The ratchet

`services/office-space/src/walk/storyboard-ledger.ts` lists the beats
known not to pass. The contract, enforced by the walk's exit code and
by `src/test/storyboard-walk.test.ts`:

- a beat NOT in the ledger must pass — regression guard;
- a ledgered beat that STARTS passing **fails the suite until struck**
  — progress is recorded, never silent.

## The standing guard

Strip every `--` comment line from a vended frame: every merge,
planner, expiry and constraint assertion must still pass. That is the
mechanical test for "interpretable equivalently by non-LLM systems" —
an LLM reads the rendered text, another office merges it, a planner
prices it from the types alone. Beat 8 runs this guard live inside its
acceptance.

## The layer beneath

The kernel scenarios live in the sequence repo:
`src-v2/test/vending-endstate.test.ts` + `specs/impl/VENDING_LEDGER.json`
— same ratchet contract, kernel grain (V13–V17, V19 are the open gaps
that ledger beats 11/12 and the deeper enforcement refinements).
