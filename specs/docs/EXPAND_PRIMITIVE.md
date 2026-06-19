# EXPAND_PRIMITIVE — Read-driven materialization on the existing substrate

**Status**: three surgical wires to add to v2 at `~/publicpackages/sequence/src-v2/`. Not a rewrite. No new cell state. The substrate already encodes this; `get()` doesn't yet use what's there.

## The primitive was implicit all along

From CLAUDE.md: **"Types and values are one continuum. A value IS a maximally concrete type."**

v2's `Cell` (sequence.ts:57) already has `value?: unknown` and `type?: Type`, both optional. A cell with type only IS the compressed form; a cell with value IS the materialized form. There is no two-state enum to add — there is a concreteness gradient, already there.

What's missing is the READ-side wiring that lets this gradient drive all the operations the user enumerated — boot, cache paging, LLM prompt compression, cross-sequence hoist, plan-search branching, MOE gating, API pagination. All are the same operation at different boundaries: read a cell; maybe expand; observe.

## The distinction that must hold: gap vs. claim slot

A type-only cell is one of two things, and the wire must distinguish them:

- **Gap** — the type has a local producer. Read-triggered backward inference can discover how to materialize: `derivedVia(...)`, `kind: 'fn'` with a registered impl, a ref chain that terminates in a derivable value. Reading a gap auto-elects an invocation through the normal commitment machinery.

- **Claim slot** — the type has no local producer; it describes *shape an external writer is responsible for filling*. Examples: `sessions.{user}.profile`, `req.*` cells, peer-owned cells, user-input fields. Reading a claim slot returns `undefined` and fires an access-miss observation — no invocation is attempted. Soliciting the fill is a separate question for an upstream actor (UI prompt, peer proposal, API call declared elsewhere).

Partition is a coarse hint (`req` / `chan` bias toward claim slot; `state` / `proj` bias toward gap) but it is not the canonical check. The canonical check is whether the type has a discoverable producer *under this sequence's impls and ref graph*.

```typescript
function hasLocalProducer(t: Type, seq: Sequence): boolean {
  if (t.kind === 'fn' && seq.impls.has(implIdFor(t))) return true;
  if (hasConstraint(t, 'derivedVia')) return true;
  if (hasConstraint(t, 'ref')) {
    const target = seq.typeAt(refTargetOf(t));
    return target ? hasLocalProducer(target, seq) : false;
  }
  return false;
}
```

Without this split, auto-expand would elect commitments against external writers who never agreed to respond — wrong, and noisy.

## The three wires

### Wire 1 — `get()` on gap cells auto-expands

Today: `get(path): unknown { return this.findCell(path)?.value; }` (sequence.ts:196).

Extend to:

1. If `cell.value` present: fire access-hit observation, return value.
2. If `cell.value` absent, `cell.type` present:
   - Fire access-miss observation with context binding.
   - If `hasLocalProducer(cell.type, this)`: elect invocation via existing commitment flow. Return a pending-marker synchronously; fulfillment arrives via normal cascade.
   - Else (claim slot): return `undefined`. The observation is the only effect.
3. Cell absent entirely: same as (2) with claim slot — return undefined, fire observation.

~60 kernel lines including the producer check.

### Wire 2 — access observations as dispatched events

Today observation rules fire on `insert()` cascade (sequence.ts:259 `propagate`). Extend to dispatch on `get()` as well:

- `get()` emits an event `{ kind: 'access-hit' | 'access-miss', path, contextClass?, time }`.
- Observation rules whose guards match fire through the existing emitter machinery.
- Rule implementations (stdlib) update per-cell access posteriors, potentially trigger eviction, etc.

No new axis in the `Axis` enum. Access is an event kind of observation, not a structural/temporal/ref edge.

~20 kernel lines.

### Wire 3 — hoist replaces depth cap with budget × posterior

v2's `hoistForReader` takes `depth: number`. Replace / generalize:

```
hoistForReader(seq, readerName, { budget, contextClass, sla })
```

For each cell in the walk:
- Compute `expected_utility = posterior(cell, contextClass) * information_density(cell)`.
- While `budget > 0` and `expected_utility > marginal_threshold`: materialize inline; decrement budget by rendered-size.
- Else: emit compressed token `[[ path : render(sketch) | p=posterior sla=ms ]]`.

The token IS the existing gap marker in ft text; the new information is the posterior + SLA annotations. A consumer (LLM, UI, peer) reading such a hoist can request expansion by addressing the path.

~50 stdlib lines. Replaces — not adds — the `depth` param.

## What existing machinery this reuses (nothing new invented)

- **`Cell.value` + `Cell.type` optionality** → compressed/materialized gradient.
- **Observation rule dispatcher** (`propagate` + emitters) → fires access events.
- **Backward inference** → producer discovery for gaps.
- **Commitment election** (`kind: 'fn'` invocation delta, sequence.ts composeAtCell) → the auto-expand mechanism.
- **Reliability posterior** (stdlib) → re-targeted as per-holder component of access posterior.
- **Sub-type refinement key** (stdlib) → the `contextClass` dimension.
- **Partition model** → advisory hint for gap-vs-slot, not canonical.
- **ft-text `[[ path : type ]]` gap token** → already an expand token; gains posterior + SLA annotations.

## What this is NOT

- Not a rewrite. v2 stays. 98 tests stay green throughout.
- Not a new Cell state enum. Materialized/Compressed are projections of `value?` + `type?` presence; naming them as states adds a kind where a parameter value already existed.
- Not a feature collapse target. The 18 v2 stdlib features don't get rewritten as a goal. Some may naturally reduce to thin wrappers after the wires land; don't pre-commit to line counts.
- Not a new `Axis`. Access is an observation event kind, not a new lattice direction.

## Order of operations

1. **Wire 2 first** (access observations dispatched on `get()`). Cheapest; purely additive; lets stdlib rules start updating posteriors. Tests: repeated `get()` accumulates observation blocks at the right paths.

2. **Wire 1 second** (gap auto-expand). Requires `hasLocalProducer` to be correct. Tests: `get()` on fn-typed cell with registered impl triggers invocation and materialization; `get()` on claim slot (type-only with no producer) returns undefined + fires observation only; existing 98 tests unchanged.

3. **Wire 3 third** (budget × posterior hoist). Tests: cold posterior hoists shallow inline, deep as expand tokens; after observed access patterns, frequently-accessed subtrees pre-materialize deeper under same budget.

4. Only after (1)-(3) are green: survey v2 stdlib for features that now have dead or duplicated code. Retire where real. No "shrink stdlib to 400 lines" target.

## Open questions

- **Producer discovery under ref chains.** When a type is defined by a ref whose target has a local producer, how far do we chase? Bounded search with a depth cap? Cache results per-type?
- **Pending-marker semantics.** When `get()` returns while invocation is in flight, what shape? Is it distinguishable from `undefined`? Does it block subsequent reads at the same path until fulfillment, or coalesce?
- **Budget propagation under recursive hoist.** When hoist emits a compressed token whose expand is another hoist call, how is the outer budget partitioned for the inner? Declared per-cell, or uniformly split?
- **Eviction trigger.** When does a materialized cell flip back to type-only under memory pressure? Smooth posterior-threshold decay, or hard LRU? Per-cell or per-subtree?

## Cross-references

- `specs/docs/NABLA.md` — traversal algorithm. Access events are a new event kind routed through the same observation dispatcher, not a new axis.
- `specs/docs/SEQUENCE_SIMPLIFICATION.md` — container/realization + 5-step core loop. Gap/claim-slot distinction refines what "realization can satisfy container" means when no realization exists and no local derivation is possible.
- `specs/docs/PARTITION_MODEL.md` — coarse hint for gap-vs-slot via partition authority rules.
- `specs/docs/READER_DOCUMENTS.md` — readers become `(budget, contextClass)` parameterizations of Wire 3.
- `specs/docs/AGENT_PROMPT_FRAME.md` — the canonical prompt with `[[ expand ]]` tokens IS a Wire-3 output; posterior + SLA annotations become load-bearing for agent-side expand decisions.
- `~/publicpackages/sequence/specs/docs/COMMITMENTS.md` — the mechanism Wire 1 reuses for auto-expand (no new commitment machinery).
- `~/publicpackages/sequence/specs/docs/LEARNING_AS_COMPRESSION.md` — access posterior IS the compression policy; loss = surprisal over the predicted expand trace.

## One-line summary

`get()` on a gap auto-expands; `get()` on a claim slot just observes; `hoistForReader` spends budget against access posterior instead of a hard depth cap. Everything else stays.
