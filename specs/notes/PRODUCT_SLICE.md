# Product Slice

This defines the first coherent product to ship from this repo.

## Product

A shared workspace where humans and agents operate on the same typed state, see the same unresolved obligations, and fill them through documents, forms, and typed tool invocations.

## User-Facing Promise

Users can:

1. connect to a shared workspace
2. see current state as scoped documents
3. see missing required data as explicit gaps/forms
4. make edits that become shared typed facts
5. watch agents and other clients update the same workspace in real time

## Included

### 1. Shared typed state

- append-only history
- current projection
- schema-backed validation
- suspension instead of silent rejection where appropriate

### 2. Sync

- websocket sync
- local persistence
- offline buffering
- replay on reconnect

### 3. Reader-driven views

- scoped projections
- visibility masking
- gap rendering inputs

### 4. Small capability surface

- explicit tool registrations
- explicit invocation results
- auditable tool effects

### 5. Durable agent sessions

- resumable local snapshots
- due-run metadata
- simple retry/resume loop

## Excluded From V1

The first product slice does not require:

1. full generalized contract algebra for every external system
2. a universal event query engine
3. globally optimal distributed scheduling
4. advanced narrative compression and memory compaction
5. formal community/distributed-authority semantics
6. every runtime target named in the requirements catalog

## Canonical Objects In V1

### 1. Workspace state

Typed paths and values that multiple participants can read and update.

### 2. Reader

A scoped document/view contract over workspace state.

### 3. Gap

An unresolved required claim that can be filled by a human or capability.

### 4. Capability

A typed external operation available to the workspace.

### 5. Session

A durable participant identity with local state and reconnect behavior.

## Minimal End-to-End Flow

1. Server boots a workspace from bootstrap plus snapshot
2. Client connects and receives a reader-scoped projection
3. User or agent mounts facts
4. Kernel updates projection and gaps
5. Relevant deltas stream to other participants
6. Local snapshots persist for reconnect/resume

## Success Criteria

The slice is coherent if all of the following are true:

1. A user can open a workspace and immediately see meaningful current state
2. Missing required information is explicit and queryable
3. Two participants can update the same scope and observe each other
4. An agent can resume from prior state and fill a bounded class of gaps
5. The persisted state model is stable enough to survive restart and reconnect

## Evaluation Standard

V1 should be judged by:

- clarity of the shared-state model
- correctness of projection/gap behavior
- stability of sync and persistence
- auditability of edits and tool effects

It should not be judged by whether the repo already solves every planned semantic layer.
