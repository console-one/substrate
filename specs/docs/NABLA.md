# ∇ — The Propagation Primitive

## Purpose

This document specifies **∇** (nabla), the single kernel operation that the
FT substrate must implement in order to unify its propagation machinery. ∇
is the bidirectional chain rule for probability densities on the substrate's
reflexive claim graph. Every current specialized propagator — cascade,
backward inference, `indexSpec` evaluation, law dispatch, admission check,
tool auto-wire, `tryResumeSuspended` — is a restriction of ∇ to a
specific lattice and direction.

Extracting ∇ as the kernel primitive is what earns the substrate's claim to
be the unifying point for differential dataflow, belief propagation,
variational inference, active inference, POMDP value iteration, equilibrium
propagation, differentiable Datalog, and autodiff. Without ∇ extracted,
those equivalences are assertions; with it, they are demonstrable
specializations.

## Scope

This doc specifies **what** ∇ does, **what** must be true for it to be
computable, and **how** to verify an implementation. It does not specify
how the operation is physically implemented (dispatch strategy,
compilation, memory layout). Those are downstream choices.

## Type Grammar Context (Honest Status)

This spec describes ∇ as it would operate over the substrate's state
graph. The preconditions (P1)–(P4) below reference properties — reflexive
graph structure, claim-as-constraint, where/while/body semantics — that
the substrate currently realizes **operationally at runtime**, not
**grammatically within its type system**.

This is a real gap. Acknowledged up-front so the spec is not read as
already-achieved:

- `where` clauses, `while` clauses, block bodies, admission laws, and
  lifecycle semantics currently live in `BlockOpts` and the kernel's
  runtime dispatch, not in the type vocabulary found in `type.ts`.
- The kernel interprets `BlockOpts` alongside the type's constraint set
  and pretends the two are unified. They are not. They are decoupled
  layers that the kernel's implementation happens to coordinate.
- ∇ as specified here operates over the combined behavior. A fully
  satisfying implementation requires folding the operational
  vocabulary into the type grammar so that ∇ does not need to reach
  outside the type lexicon to find its dispatch rules.

### What the unified grammar would need

The target grammar is a **probabilistic, temporally-modal, behavioral,
linear, refinement, dependent type system with distributional content
and transition kernels**. No existing type system in the literature
covers this combination; fragments exist, each handling one aspect:

**Dependent type theory** (Coq, Agda, Lean, Idris). Types depend on
values. `Vec(n, A)` is a vector of length n with elements of type A.
Pi- and Sigma-types support refinement via dependent pairs and
propositions-as-types. Captures value/type continuum. Missing:
lifetime, behavior, distributional content.

**Session types** (Links, SePi, Rust/Haskell libraries). Types express
communication protocols: `!Int.?String.End` means "send Int, receive
String, terminate." Protocol duality and compile-time verification of
deadlocks. Captures lifetime-as-type, protocol structure, sequence of
operations. Missing: distributional content, initiation predicates,
quantitative reasoning.

**Effect types / algebraic effects** (Koka, Eff, OCaml 5 with effect
handlers, Haskell effect libraries). Types track side effects as row
extensions: `readFile : String → String ! {IO}`. Handlers intercept
effects at a distance. Captures behavior-as-type and composable
interpretation. Missing: lifetime invariants, distributional content,
temporal structure.

**Linear / substructural types** (Linear Haskell, Rust's ownership,
Idris 2 Quantitative Type Theory). Values must be consumed per their
multiplicity — exactly-once (linear), at-most-once (affine), etc. No
accidental duplication or discard of resources. Captures lifetime
bounds, authority, use-once. Missing: distributional content,
predicate refinement, behavior.

**Refinement types** (Liquid Haskell, F*, Dafny, Why3). Types carry
propositional predicates: `{x : Int | x > 0}`. Typechecker discharges
obligations via SMT. Captures preconditions, postconditions, value
invariants. Missing: lifetime (predicates are instantaneous),
behavior, distributional content.

**Modal types** (Pfenning's judgmental modal types, staged computation,
temporal-logic-as-types). Types carry modal operators — necessity (□),
possibility (◇), past/future temporal operators, information-flow
levels, staged-computation levels. Captures temporal invariants,
context-dependent validity, information flow. Missing: quantitative
temporal reasoning, distributional content.

The substrate's unified grammar absorbs one distinctive move from each:

| From | The substrate absorbs |
|---|---|
| Dependent types | Values in types — the value/type continuum |
| Session types | Protocol / sequence / lifetime structure for `while` |
| Effect types | Behavior-as-type for tool invocations |
| Linear types | Authority and holder semantics for writer-authority, leases |
| Refinement types | Propositional predicates (already present as constraint ops) |
| Modal types | Temporal operators for `while`, deadlines, transition kernels |

Plus two moves that **no existing type system offers**, which the
substrate genuinely needs:

- **Distributional content.** Types carry probability distributions
  over their inhabitants, not merely logical predicates. Composition
  is conjugate-posterior update in a lattice, not just set
  intersection.
- **Transition kernels / productivity decay.** Types specify how their
  distributional content diffuses over time in the absence of new
  observations. A sharp observation becomes a diffused distribution;
  productivity (the observation's contribution to compose) evaporates
  at the kernel's rate. No existing type system treats information
  ageing as a type-level property.

### What this means for ∇

∇ as specified below operates over the intended unified grammar. Where
the current implementation satisfies the grammar operationally (via
BlockOpts, admission dispatch, cascade machinery, conjugate compose
for a handful of distributional families), ∇ can be extracted and
work. Where the implementation hasn't caught up to the grammar —
everywhere lifetime, behavior, and linearity live in runtime
bookkeeping rather than in the type's constraint set — ∇ as extracted
will still need to reach into that bookkeeping to dispatch correctly.

The long-term correct shape: every notion this spec treats as a
"direction" or "edge kind" of ∇ is a constraint constructor in a
unified type grammar. Every BlockOpts field becomes a type-level
constraint. `where` becomes `InitiableWhen(C)`. `while` becomes
`ValidWhile(I)`. Body becomes `BehavesAs(...)`. Transition kernel
becomes `Transitions(K)`. Under this redesign, the mount operation is
trivial — "instantiate this type at this path" — because the type
carries everything about when, how, and why it applies. ∇ then
operates uniformly on one vocabulary, with no reach into a separate
operational layer.

### Anti-pattern: operational unification without grammatical unification

This spec (and the substrate's current framing) commits a specific
expressive error if read too generously: it claims that external
frameworks (HRL, neural networks, active inference, POMDPs,
differential dataflow) are "unified" into the substrate because
their concepts map onto substrate runtime primitives. That
correspondence is real at the runtime layer and vacuous at the type
layer.

Concretely: HRL's option ⟨I, π, β⟩ maps onto the substrate's
`where`-gated, `while`-bounded block with a body. True operationally.
But the substrate's type grammar does not currently express "option"
as a type — there is no `Option(I, π, β)` constraint constructor in
`type.ts`. The unification is at the runtime dispatch level, not at
the type grammar level.

The substrate's claim to unify these frameworks is only structurally
sound once the type grammar itself absorbs the fragments above. Until
then, the correspondence is accurate and useful for reasoning, but it
is a bridge over a gap, not a merger.

## Signature

```
∇(path, delta, direction, scope) → InducedChanges
```

Where:

- **path**: a path in the substrate whose value (or distributional claim)
  has changed.
- **delta**: the change at that path, expressed in the lattice's tangent
  structure. For distributional lattices, a shift in the natural parameters
  of the posterior. For numeric lattices, a scalar increment. For
  lattice-valued refinements, the narrowed subset.
- **direction** ∈ `{forward, backward, lateral, temporal}`.
- **scope**: the reader/partition context in which the propagation runs;
  governs which peers receive the induced change.
- **InducedChanges**: the set of `(path, delta)` pairs that must propagate
  next. ∇ is iterated over this set (possibly to fixpoint).

## Directions

Each direction is a restriction of the chain rule for probability densities
applied along a specific edge-kind in the backward index.

**forward** — input change ⇒ output change.
The classical forward pass. For each claim in `_rdeps[path]`, apply the
claim's compose operator with the updated input; emit the output delta.
Restricts to cascade (scalar case), Datalog rule firing (boolean case),
forward belief propagation (distributional case), feedforward NN pass
(real-valued case).

**backward** — output constraint ⇒ input refinement.
For each claim in `_deps[path]` whose output was constrained by the
change, invert the compose operator (where invertible in closed form; else
variational projection) to narrow the input prior. Restricts to
backward-inference, reverse-mode autodiff, sum-product backward messages,
active-inference posterior update.

**lateral** — joint-constraint change ⇒ sibling refinement.
For each claim $c$ with a conjunction over multiple inputs, when one input
changes, marginalize the joint over the changed input and re-derive the
conditional distribution of the others. Restricts to `indexSpec` fixpoint,
Markov blanket propagation, message passing on loopy graphs.

**temporal** — plan/actual merge ⇒ prior update at the originating claim.
When `_rt` advances past the referenced moment of a claim that contains a
forward-looking reference, the referenced actual is composed against the
planned prediction. The resulting delta propagates backward through the
claim that produced the plan. Restricts to `tryResumeSuspended`, Kalman
update, Bayesian filtering, free-energy-driven prior adjustment.

All four directions call the same underlying operation — compose applied
along an edge — differing only in edge orientation and which side carries
the delta.

## Preconditions

∇ is computable iff the following hold on the substrate's claim graph.

**(P1) Conjugate closure of compose.**
For each supported distributional family $F$ (Beta, Dirichlet, Normal,
Gamma, etc.), the compose operation must produce a member of $F$ when given
a prior in $F$ and a likelihood conjugate to $F$. For non-conjugate cases,
compose must project to the nearest member of $F$ via variational
approximation with a declared objective (default: forward KL minimization).

**(P2) Reflexive graph structure.**
The dependency graph must be expressible as substrate values — i.e.,
`_deps.*`, `_rdeps.*`, `_tools`, `_blocks.*` must be queryable paths, and
the evaluator of ∇ itself must be authorable as a mounted tool. If
the graph is hardcoded outside the claim vocabulary, ∇ cannot operate on
its own structure uniformly.

**(P3) Sparse-by-dependency activation.**
Each claim must declare its full read set as its dependency set. Cascade
fires only for claims in `_rdeps[changed_path]`. No claim may implicitly
read a path outside its declared deps. This keeps each ∇ application
$O(|\text{affected neighborhood}|)$ rather than $O(|G|)$.

**(P4) Monotone compose OR explicit retraction.**
Each compose operation must be monotone on its lattice (stricter inputs
yield stricter outputs), OR non-monotone cases must route through the
substrate's existing invalidation mechanism (explicit retraction block
appended when a claim newly evaluates false). This guarantees fixpoint
termination in bounded iterations.

Violation of any of (P1)–(P4) makes ∇ ill-defined, non-terminating, or
non-sparse.

## Invariants

∇ preserves the following across every application.

**(I1) Claim truth.** No live claim evaluates to false in the post-∇ state.
Claims that newly evaluate false trigger explicit retraction.

**(I2) Lattice monotonicity modulo retraction.** Values only tighten in
the lattice across a ∇ call, unless the claim is explicitly retracted by
an invalidation block.

**(I3) Locality.** ∇ applied at `path` modifies only paths in the
transitive closure of `_rdeps` (forward) / `_deps` (backward) /
joint-constraint peers (lateral) / plan-referenced paths (temporal) from
`path`.

**(I4) Sheaf gluing across processes.** For any claim whose dependency set
spans a cross-process boundary, the result of ∇ is consistent with the
result obtained by the peer process once bilateral gap exchange completes.

## Termination

Under (P1)–(P4), iterated ∇ terminates in finite steps:

- Monotone compose on a bounded-height lattice: ascending chain condition
  guarantees termination.
- Finite dependency graph: locally-finite firing bounds per-step work.
- Explicit retraction for non-monotone updates: no infinite non-monotone
  oscillation.

Iteration bound: $O(h \cdot |\text{transitively affected claims}|)$, where
$h$ is the lattice's maximum ascending-chain length.

## Mapping to existing primitives

Each current specialized propagator extracts into ∇ as follows.

| Current primitive | Direction | Lattice scope |
|---|---|---|
| `cascade` | forward | scalar, categorical |
| `tryResumeSuspended` | temporal + backward | any |
| `runIndexConstraints` | lateral | glob-indexed tuples |
| `runLaws` | temporal (distributional) | Beta prior |
| `tryAutoWire` | lateral | tool union |
| `backwardInfer` | backward | refinement type |
| admission law eval | (claim truth check, not ∇) | — |
| `checkWhileClauses` | (truth check; triggers retraction) | — |

Admission and `while`-checking are **not** ∇ — they are claim-truth
evaluations whose failure triggers retraction blocks, which then trigger
∇. Keep this distinction clean: ∇ is propagation, admission/while is
invariant-check.

## Acceptance criteria

An implementation of ∇ is correct iff all of the following hold.

**(A1) Unified dispatch.**
The four directions share one code path for compose application, one code
path for induced-change enumeration, one code path for fixpoint iteration.
Direction-specific branches are allowed only at the compose-edge-inversion
call (since forward/backward use the forward/inverse compose respectively).

**(A2) Regression on the existing test suite.**
All ~285 kernel tests pass unchanged after the current specialized
propagators are replaced by ∇ dispatches.

**(A3) Three-paradigm demonstration.**
Without adding kernel code beyond ∇ and a vocabulary of claim ops, the
following three behaviors land as claim-set authorings:

- **Neural network training**: a small MLP authored as claims converges
  on synthetic regression data with loss trajectory matching a JAX
  reference within numerical tolerance.
- **Belief propagation**: inference on a small Bayesian network (medical
  diagnosis or similar) produces marginals matching a reference BP
  implementation.
- **POMDP value iteration**: optimal policy on a gridworld matches a
  reference POMDP solver.

Each demo adds only claim sets, not kernel code. If any of the three
requires kernel extension, ∇ has not captured the generalization.

**(A4) Sparsity under load.**
Synthetic stress test: 10⁴ mounts/sec on a graph of 10⁵ claims must touch,
on average, only the transitive `_rdeps` neighborhood per mount. Verified
by instrumentation: claim evaluations per mount ≪ |G|.

**(A5) Reflexive evaluation.**
The ∇ evaluator is itself a mounted tool, discoverable via
`seq.toolAt('_eval.nabla')` (or equivalent path). An admission law
on that tool fires for every ∇ invocation. Disabling the tool disables ∇;
enabling it restores behavior. This is the operational test of
reflexivity-at-implementation.

## Anti-requirements

**(AR1)** ∇ must not admit direction-specific evaluators. One operation,
one dispatch, four argument configurations.

**(AR2)** ∇ must not be a framework with plugins. Compose operations are
registered as mounted tools; ∇ itself is a single function that invokes
them.

**(AR3)** ∇ must not be lattice-specific. Any lattice satisfying (P1)–(P4)
participates without kernel change.

**(AR4)** ∇ must not include admission or while-check logic. Those are
separate concerns; their failure modes trigger retraction, which then
invokes ∇.

**(AR5)** ∇ must not smuggle performance specialization into its spec. The
specification is semantic; compiled fast paths that preserve (A1) and (A2)
semantics are permitted at the implementation layer but may not affect the
contract.

## Open questions

**(O1) Variational compose for non-conjugate families.**
Default KL-forward projection covers the textbook cases. Edge cases
(multimodal posteriors, heavy tails) may need per-family strategies.

**(O2) Convergence bounds on cyclic graphs.**
Strict stratification guarantees termination. Mutually recursive claims
without strict stratification: bounded-iteration truncation with explicit
"did not converge" signal, or graph-level stratification pass. Needs
decision.

**(O3) Backward compose invertibility.**
Some compose operations are non-invertible (information destruction). For
these, backward ∇ produces a partial update (the likelihood under the
prior). Not all information is recoverable. Document per-family
invertibility explicitly.

**(O4) Cross-process temporal alignment.**
Temporal ∇ depends on `_rt` being comparable across processes. Under
clock skew, bilateral-exchange-induced ∇ may produce slightly different
deltas at different peers before sheaf gluing reconciles. Quantify the
bound; decide whether additional alignment is required.

**(O5) Performance floor for NN-scale workloads.**
A uniform ∇ implementation will be slower than specialized autodiff on
dense numeric workloads. Acceptance criterion (A3) does not require
performance parity; the unification is the goal. Performance optimization
is downstream work with its own spec.

## How to use this document

- **Before landing a new propagator**: check that it decomposes into ∇
  with the appropriate direction and lattice. If it doesn't, either
  extend ∇'s spec (with justification) or reject the proposed feature.
- **When refactoring existing primitives**: use the mapping table as the
  extraction target. Each entry's behavior must be reproducible by ∇
  with its specified direction and lattice restriction.
- **When evaluating the substrate's claims of unification**: run the
  three-paradigm demonstration (A3). That is the empirical test; the
  theoretical argument is only as strong as the demonstration.

## Relation to other documents

- **SEQUENCE_NODES.md** — the live system plan. ∇ is the operation each
  Sequence node runs locally; sheaf gluing extends it across peers.
- **PARTITION_MODEL.md** — partitions are the segmentation axis for
  distributional lattices in (P1). ∇'s compose must respect partition
  boundaries.
- **SEQUENCE_SIMPLIFICATION.md** — the five-step core loop that ∇ iterates.
- **INDEX_CONSTRAINTS.md** — tuple-product dimension, one of ∇'s lateral
  propagation targets.

## Status

**Draft. v0.** This document specifies the target. The implementation
does not yet satisfy (A1), (A5), or (A3) beyond specific fragments. Work
items tracked against this spec live downstream.
