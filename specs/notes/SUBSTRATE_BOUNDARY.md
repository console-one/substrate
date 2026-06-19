# Substrate Boundary

This document defines the part of the system that should be treated as platform, not product-specific policy.

## Purpose

The substrate exists to synchronize conflicting beliefs and actual state across shared computation.

It does not decide:

- UI structure
- planner strategy
- organizational workflow
- domain-specific contract libraries

It only provides the common state and reduction model those layers depend on.

## Core Objects

### 1. Block

A block is the atomic append-only write unit.

A block contains:

- entries
- timestamp
- author identity if available
- `where` gates
- `while` gates
- lifecycle status

### 2. Path

A path is the address of a claim in shared state.

Paths are stable identifiers for:

- values
- schemas
- capabilities
- policies
- lifecycle facts

### 3. Type

A type is a serializable constraint set over a path.

The substrate only needs:

- structural constraints
- literal constraints
- path-preserving function contracts
- lifecycle constraints

Higher-order domain semantics live above this layer.

### 4. Projection

Projection is derived state from the append-only block log.

Projection includes:

- current values
- current schemas
- capability markers
- policy markers
- dependency indexes

Projection is a cache over block history, not the source of truth.

### 5. Obligation

An obligation is a path whose declared type is not yet satisfied.

Obligations are derived, never manually tracked.

## Primitive Operations

### 1. Mount

`mount` is the only mutating operation.

Mount:

- appends a block
- checks `where`
- updates projection
- triggers cascade
- attempts resume
- checks `while`
- returns resulting changes and remaining gaps

### 2. Compose

`compose(a, b)` computes the tightest type/value consistent with both inputs.

This is the substrate's conflict-resolution primitive.

### 3. Check

`check(type, value)` determines whether a value satisfies a type and what is still missing.

### 4. Hoist

Hoist is the projection boundary.

It emits a receiver-scoped textual view of current state and obligations.

## Lifecycle Semantics

### 1. `where`

`where` is a mount-time gate.

If unsatisfied:

- the block is not applied
- the block remains visible as suspended intent
- unmet conditions are queryable

### 2. `while`

`while` is a lifetime gate.

If it becomes false after application:

- the affected block is invalidated
- invalidation is itself observable state

## Capability Boundary

Capabilities are paths with typed input/output contracts.

The substrate may know:

- the capability exists
- its declared contract
- what input would be needed to use it

The substrate does not need to know:

- where the implementation runs
- whether the provider is human, local process, remote worker, or model

Implementations are runtime attachments outside serialized state.

## Persistence Boundary

The canonical persisted object is:

- the append-only block history
- periodic snapshots of derived projection
- optional indexes/materializations derived from that history

All higher-level database views are secondary projections.

## Projection Boundary

Readers are projection contracts over substrate state.

A reader may specify:

- source subtree
- depth
- filter
- limit
- visibility context
- render mode

A reader does not change the underlying state model.

## Explicit Non-Goals

The substrate does not by itself define:

1. a full event calculus
2. a full query language
3. a full UI document grammar
4. a distributed scheduler
5. a global policy engine
6. domain-specific vertical libraries

Those consume the substrate. They are not the substrate.
