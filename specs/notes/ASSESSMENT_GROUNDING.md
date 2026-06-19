# Grounded Assessment

This repo has a real kernel and a real product direction, but the semantic surface is currently wider than the implemented product boundary. The main risk is not "bad code." The main risk is conflating four different layers into one language design problem:

1. A conflict-aware state substrate
2. A contract language for obligations and equivalence
3. A projection/query/view system
4. A distributed scheduling and execution model

Those layers interact, but they do not need to be solved as one indivisible DSL before something useful ships.

## What Is Actually Coherent Today

### 1. The kernel as an append-only typed state machine

This part is real.

- `Sequence` is a concrete append-only block log with projection, suspension/resume, cascade, gap discovery, capability markers, and change tracking.
- `compose` and `check` give you a usable lattice/constraint core.
- `where` and `while` already provide a meaningful distinction between instantiation gates and lifetime gates.
- `backwardInfer` exists and is not just described in prose.
- `reader` contracts and `hoistForReader` exist as a projection boundary.

This is the substrate worth preserving.

### 2. The "workspace as shared typed state" product frame

This also exists in embryo.

- `services/contextgraph` gives you a server, a SQLite store, a websocket transport, a local client, and an agent loop.
- The product direction is clear: shared state, offline-capable clients, bilateral gap exchange, agents as durable sessions.

The important caveat is that this is still a thin execution shell around the kernel, not yet the finished "shared agent/context/work-data view system."

## What Is Not Yet Coherent

### 1. The repo mixes "proved," "implementable," and "imagined" semantics

Several docs slide between:

- implemented and tested behavior
- requirements that can plausibly decompose to current primitives
- speculative language semantics

That is why the repo can feel like it "agrees with you" while still being structurally unreliable. The markdown often treats "I can see how this could be modeled" as if it were equivalent to "the model is now settled."

### 2. The DSL is carrying too many jobs

Right now the DSL is being asked to be all of the following at once:

- a schema/type notation
- a runtime mount language
- a contract language for cross-operation identities
- a prompt/document transport
- a UI projection format
- a planning/scheduling notation
- an event/filter/query language

That makes every semantic decision cross-coupled with six others.

### 3. Some key requirement classes are still explicitly unresolved

The requirement files themselves point at unresolved areas:

- universal quantification / dependency closure
- schema operators like `keyof`, indexed access, `Partial`
- error representation
- cross-operation intermediate bindings
- policy composition semantics

Those are not implementation bugs. They are language-boundary problems.

## The Core Semantic Split To Make

You should treat the system as four strata with narrow interfaces.

### Stratum A: Substrate

This is the only thing that must remain universal.

- append-only blocks
- projection
- `compose`
- `check`
- gaps/obligations
- `where` and `while`
- capability registration markers
- change stream
- durable snapshots

Definition:
The substrate manages conflict across beliefs and actual state over shared computation.

This is the real kernel.

### Stratum B: Contract Layer

This should not be "the whole DSL." It should be the smallest language needed to express:

- structural types
- path/value equivalence
- preservation mappings across call boundaries
- lifecycle conditions
- obligation shape

Definition:
The contract layer states what must hold and what inputs are required for claims to become concrete.

This is where "contractlike terms" belong.

### Stratum C: View/Query Layer

This should be modeled as projection contracts over substrate state, not as general computation.

- reader/view contracts
- scoped projections
- visibility and editability
- compression/expansion rules
- document/form rendering rules

Definition:
A UI is a document projection over shared state plus writable holes.

This appears close to your actual intent and should stay separate from scheduler semantics.

### Stratum D: Execution/Scheduling Layer

This should consume gaps and contracts, not define them.

- due work detection
- planner allocation
- resource assignment
- retries
- worker liveness
- narrative compaction triggers

Definition:
Scheduling is policy over unresolved obligations and available capabilities.

It is downstream of the substrate, not part of the substrate's core type theory.

## Where The Current Repo Crosses Its Own Wires

### 1. `<<` is overloaded beyond comfort

It currently acts like:

- narrowing
- instantiation
- composition
- and, in some paths, function application

That is powerful, but it blurs the boundary between "strengthen a claim" and "execute a capability." Those should remain adjacent, but not semantically identical.

### 2. `where` / `while` are doing real work, but they are not yet a full policy model

They are coherent as:

- mount preconditions
- lifetime constraints

They are not yet a settled answer to:

- authorization inheritance across shared ancestors
- capability invocation preconditions across distributed workers
- queue arbitration and exclusive claims
- multi-party ownership and override policies

### 3. Readers exist, but the view semantics are still thin

The current reader system is enough to say:

- what source subtree to project
- depth/limit/filter/mode
- visibility masking

It is not yet a full answer to:

- ancestor-shared view constraints
- stable editable document projections
- structural merge behavior for rich documents
- durable UI semantics across clients

### 4. Events exist as history and changes, but not yet as a first-class query algebra

Today you have:

- append-only blocks
- `changes`
- projection values
- some narrative framing

You do not yet have a clean, explicit event/query/projection layer with stable semantics for:

- historical queries
- incremental materialization
- event partitions
- watermarks/compaction boundaries
- pipeline composition

### 5. The agent/scheduler model is still much thinner than the product language around it

There is already useful machinery for:

- durable local client state
- reconnect
- pushing scheduling fields like `nextRunAt`

But the actual scheduler semantics are not yet the repo's strongest point. The current agent loop is still closer to:

"scan local gaps, try local capabilities, stop when stuck"

than to:

"shared distributed execution substrate with principled allocation and rescheduling semantics."

## What To Freeze Now

If the goal is to productionalize quickly, freeze the following as non-negotiable platform primitives:

1. `Sequence` block semantics
2. `compose` / `check`
3. gap/obligation discovery
4. `where` / `while`
5. capability registration and external invocation boundary
6. reader-scoped hoists
7. snapshot + replay

Do not keep reopening those unless you find a concrete contradiction.

## What To Stop Trying To Solve In One Pass

Do not force these into the first production slice:

1. full general-purpose contract algebra across every external system
2. full view grammar for every possible document shape
3. general event calculus
4. optimal scheduler language
5. universal distributed authority semantics

Those should become layered libraries or later specializations on top of the substrate.

## Production Slice That Looks Realistic

The fastest coherent product is not "everything." It is:

### 1. Shared workspace state

- typed paths
- append-only history
- gap detection
- websocket sync
- local persistence

### 2. Reader-driven views

- document projection for selected scopes
- form rendering from missing required fields
- explicit read/write visibility rules

### 3. Capability-backed gap filling

- a small set of stable tools
- explicit invocation records
- human approval where needed

### 4. Durable agent sessions

- snapshot, reconnect, resume
- simple due-run scheduling
- no claim yet of globally optimal multi-worker orchestration

That product is already aligned with the repo's strongest implemented ideas.

## Concrete Repo Reality Checks

These are important because they explain why intuition may currently feel more trustworthy than the written docs.

### 1. The kernel is stronger than the product shell

The core package is comparatively mature.
The contextgraph product layer is still sparse.

### 2. Some docs overclaim coverage

The repo contains multiple incompatible test/coverage narratives.
That is a process smell: the epistemic status of claims is not being tracked cleanly.

### 3. Narrative compression is mostly still conceptual

Narratives are named in the product story, but the actual implementation surface is still minimal.

### 4. The store is not yet a full event database

SQLite persistence exists, but the current store layer is still much closer to snapshot storage plus raw block append tables than to the final "model as DB" abstraction.

## Questions That Need Your Answer

These are the highest-value semantic decisions to force explicitly.

### 1. What is the minimal contract algebra?

Specifically:

- Are cross-call equivalences first-class constraints?
- Or are they just capability-local preserves/equations?
- Do you need quantified closure now, or can it wait?

### 2. What is the execution object?

Choose one primary unit:

- gap
- task
- invocation
- block
- plan branch

Right now the repo speaks all five dialects.

### 3. What is the canonical event model?

Pick one:

- every block is an event
- some blocks are events and some are state assertions
- events are derived from block lifecycle and changes

Without this, the event/query/projection story will stay mushy.

### 4. What is a reader allowed to mean?

Is a reader only:

- a projection/filter contract

or also:

- an editable document schema
- a retention contract
- a subscription contract
- a prompt contract

The repo currently trends toward "all of the above." That may be too much.

### 5. What does "the model becomes the DB" mean operationally?

The most useful precise interpretation is:

"the canonical persisted object is the append-only typed block log plus derived indexes and snapshots; all higher-level tables/views are projections."

If that is correct, many design decisions simplify.

## Recommended Next Artifact

Write one short spec that replaces hand-wavy unification with a hard boundary:

`SUBSTRATE_BOUNDARY.md`

It should define only:

1. block semantics
2. path/value/type model
3. obligations
4. capability boundary
5. projection boundary
6. persistence model

Then write a second short spec:

`PRODUCT_SLICE.md`

It should define only the first thing to ship:

1. what users see
2. what agents can do
3. what persistence guarantees exist
4. what is explicitly out of scope

If those two documents are clean, the rest of the repo can be evaluated against them instead of against drifting intuition.
