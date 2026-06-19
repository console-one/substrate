# Sequence Simplification

Derived 2026-04-11 from first-principles analysis of the container/realization model.

## Core Model

Every path P has two tracks:

1. **container(P)** — the read contract. What must be true on read for the projection at P to count as complete. This is the type. It defines completeness criteria and IO shape for realizations.

2. **realizations(P)** — the event/history facts. Concrete values, impl availability, execution outcomes. What has actually happened at P.

The **binding** between them is the evolving state-machine head — the current projection frontier at P.

Semantics is bidirectional:
- container → realization: constrains valid projections/actions
- realization → container: narrows/refines the active read contract

## Gap Definition

A gap exists at P iff:
- container(P) requires a realizable read state, AND
- current realizations/events cannot produce any valid projection satisfying that container.

For function types specifically:
- fn type in container(P) = read-structure requirement
- Installed impl = one realization fact satisfying tool-availability
- Invocation/result evidence = additional realization facts; missing them can produce downstream gaps
- "fn schema + installed impl → no tool gap" is correct; execution gaps remain distinct

## Two Operations

`<<` — narrow the container. "This path has this shape." Schema-like. Constrains what can exist here. Takes effect at the next cycle step (deferred enforcement avoids self-reference).

`=` — derive a value satisfying the container. Triggers backward inference. Resolves into a sequence of `<<` mounts. Always at least one fixed point later than the derivation request.

`<<` is the primitive write. `=` is `<<` after derivation.

`bind`, `schema`, `tool`, `policy` — accidental ops that should not exist as separate statement types. What's being mounted (type, value, function, policy) is determined by the value itself, not by an op field.

## Core Loop (5 steps)

1. **Update** container(P) / realizations from new events
2. **Recompute** completeness per P
3. **Emit gaps** for incomplete P
4. **Execute** activated hooks for complete P; append realizations
5. **Repeat** to fixed point

Most machinery in the current implementation that doesn't directly support these five steps is accidental complexity.

## What This Means for the Current Codebase

### Accidental (should be eliminated)

- `StatementOp` as 6-way enum (`bind`/`schema`/`tool`/`policy`/`delete`/`invalidate`)
- `implRegistry` as a side channel separate from projection values
- `tools` Map as separate bookkeeping from schemas
- `_tools` as a maintained value list
- Type-checking within the same mount step (should defer to next cycle)
- `applyEntry` branching on 6 different ops
- `tool` as a statement op at all

### Essential (should remain)

- The append-only block log
- The projection (derived from blocks)
- The backward index (watches paths, fires on change)
- `fireLaws` BFS loop (step 4-5 of the core loop)
- `compose`/`backwardInfer`/`selectFirstBranch` (type operations)
- `where`/`while` gates (conditions on blocks)
- Partition reference rules

### The Interpretation

Everything reduces to two runtime modes:
1. **Dependency resolution** — when incomplete: find missing realizers for required containers
2. **Activation dispatch** — when complete: execute wired hooks, append new realizations

The scheduler is: dependency resolution when incomplete, activation dispatch when complete.

P is a hyperedge set. container(P) is first-order boundary conformance. Data/realizations are the porous aspects of that boundary. Tool-as-data satisfies availability without yet satisfying outcome — pointer vs outcome is determined by container(P) granularity, not by intrinsic tool type.

## Not Yet Implemented

This document describes the target model. The current implementation has the accidental complexity listed above. The fix is incremental:

1. Make `<<` and `=` the canonical ops (keep old ops as aliases)
2. Make function bind register impl (eliminate tool as separate concept)
3. Defer cross-enforcement to next cycle (don't type-check within same step)
4. Collapse `obligations()`/`gaps()` to: for each P, does container(P) have sufficient realizations?

Each step is backward compatible — old tests keep working via aliases.
