# CLAUDE.md

## READ FIRST

The substrate is one traversal algorithm over a multi-dimensional lattice. On every insertion: traverse to the target coordinate collecting lexical rules and maintaining incidence collections at each boundary crossing; compose the incoming fact with what's there under those rules; propagate the delta along every dimension OTHER than the insertion one; iterate to fixpoint. Everything — cascade, resume, invalidation, conjunction, backward inference, index firing, admission, reader projection, cross-sequence forwarding — is a specialization of that.

**`specs/docs/NABLA.md`** names that single operation (∇). The four directions (forward / backward / lateral / temporal) are the dimensions of propagation. Read this first.

**`specs/docs/SEQUENCE_SIMPLIFICATION.md`** is the five-step core loop in plainer terms: container/realization at every path, gap = realization can't satisfy container, two ops (`<<` narrow, `=` derive-then-narrow), everything else is accidental complexity.

**`specs/docs/PARTITION_MODEL.md`** names the six semantic partitions (state / process / identity / request / channel / projection) — these are dimensions of the lattice with authority / persistence / reference-direction rules.

**`specs/docs/SEQUENCE_NODES.md`** is the live-system topology and the v1 coherence test (FIVE-Sequence propagation: Browser → User Session → Org Scheduler → User Session → Browser). Every process is a Sequence node; bilateral gap exchange is the same protocol at every hop.

**`specs/docs/AGENT_PROMPT_FRAME.md`** is the canonical agent-prompt shape the whole stack serves. Do not paraphrase; link here.

**`specs/docs/READER_DOCUMENTS.md`** is the read-side convention: every read is a reader subscription; no other client→server query primitive.

**`specs/docs/INDEX_CONSTRAINTS.md`** is the self-instantiating-class primitive (`key()` generalized to tuple spaces). Classes with index constraints replace imperative lifecycle TS.

**`specs/docs/NARRATIVE_IS_TOOL.md`** is the unification statement: narrative-with-holes IS tool IS derived. Same primitive, different encodings.

**`~/publicpackages/sequence/specs/docs/DSL_REQUIREMENTS.md`** is the user-surface DSL spec.
**`~/publicpackages/sequence/specs/docs/TYPE_INTERFACE_REQUIREMENTS.md`** is the 29 verbatim type-system use cases.
**`~/publicpackages/sequence/specs/docs/COMMITMENTS.md`** is the write-side primitive (typed write-lease; in-process and external delegations isomorphic).
**`~/publicpackages/sequence/specs/docs/LEARNING_AS_COMPRESSION.md`** is the observational-side primitive (posteriors live as type-state; compression IS learning).

Any implementation that contradicts these documents is wrong.

## What This Is

An append-only behavioral type kernel. Everything is a FieldType — types and values are the same continuum. A value IS a maximally concrete type.

The system: mount a typed fact, see what's missing (gaps), fill gaps through compose, capabilities activate. One operation (`mount`), one data structure (`Sequence`), one protocol (ft text in/out).

The product built on this kernel is **Office Space** — event orchestration across agents and users, with persistent narratives, offline-capable clients, and permanent agents.

## Office Space — The Product

Event orchestration across agents and users. Persistent narratives. Offline-capable clients. Permanent agents.

Event orchestration across agents and users. Persistent narratives. Offline-capable clients. Permanent agents. Every process is a Sequence node; connections are bilateral gap exchange at every hop. A permanent agent is a session that outlives its runtime — any worker that can satisfy the agent's commitments can resume it from snapshot.

When gap-to-instance allocation can't be solved by compose + backward inference directly, the allocation problem itself is a gap — route it through the semantic kernel to an LLM; receive ft text; mount it.

## Load-bearing design principles (product/use level)

1. **Types and values are one continuum.** A value IS a maximally concrete type. Goals are types. Commitments advertised outward are types. Commitments accepted inward are types. The type system IS the orchestration vocabulary.

2. **Types carry temporal posterior, not static shape.** A type's identity at any moment includes its time-varying distribution: hazard, decay, conjugate-updating priors. Claims age. Productivity evaporates. Projection IS the posterior. Cascade IS the scheduler. Reliability priors ARE the trust model. See `specs/docs/NABLA.md`, `~/publicpackages/sequence/specs/docs/LEARNING_AS_COMPRESSION.md`.

3. **Backward inference IS orchestration.** A goal is a type (with temporal constraints). Plans are sequences of mount events (class instantiations / tool invocations). Search is branch-bound over that space, pruned by compose-feasibility. Tool calls are elements of the plan. Not a feature — the execution model.

4. **Every invocation is a commitment; local and remote are isomorphic.** Code-level computation is the degenerate fast case of remote work. Every tool call elects a typed write-lease at `_commitments.{id}`; fulfillment updates reliability priors; violation triggers counterfactual loss and policy update. See `~/publicpackages/sequence/specs/docs/COMMITMENTS.md`.

5. **Narrative IS tool IS derived.** A narrative with holes, a function type with unfilled param positions, and a derived value waiting on inputs are encodings of one primitive. Cascade fires when a position narrows. See `specs/docs/NARRATIVE_IS_TOOL.md`.

6. **`=` overwrites, `<<` narrows.** Two ops. Ordered choice on unions. `prev` for all self-reference. Comments are state (values without pkey).

7. **Hoist output IS valid ft input.** Round-trippable. One format for requirements documents, prompts, LLM responses, compiled specifications.

8. **Every read is a reader subscription.** No direct path queries. Readers are type-state at `_readers.{name}.*`. Identity-based visibility is enforced at the reader. See `specs/docs/READER_DOCUMENTS.md`.

9. **Every connection is bilateral gap exchange.** Both sides surface advertisements, both sides emit gaps, both sides fill gaps. Same protocol at every hop. See `specs/docs/SEQUENCE_NODES.md`.

10. **The LLM is just another tool.** Its input type is "rendered semantic kernel." Its output type is "ft text that closes search gaps." See `specs/docs/AGENT_PROMPT_FRAME.md` for the canonical prompt shape.

11. **Application features are type state, not kernel methods.** Backlinks, indexes, lifecycle phases, ranking, sharding, promotion/claiming/fulfillment — all expressible as classes with index constraints. See `specs/docs/INDEX_CONSTRAINTS.md`, `specs/docs/SUBSTRATE_DRIVEN_CAPS.md`.

12. **Access control is type incompatibility.** No separate authority layer. Secrets and credentials are typed values in the identity partition, round-trip-preserved by `identity()` constraints. See `specs/docs/TYPED_AUTHORITY.md`.

## Monorepo Structure

```
ft/
├── packages/core/         # kernel source (being migrated to publicpackages/sequence/)
├── services/contextgraph/ # Office Space — the product
└── package.json
```

`~/publicpackages/sequence/` is the canonical kernel as of 2026-04-21 (packaging migration in flight).

## Development

```bash
npm install
npm test
npm run build
```
