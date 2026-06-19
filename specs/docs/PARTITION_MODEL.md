# Partition Model

This document defines the authoritative partition model for the system.

It exists to solve one core problem:

one append-only typed substrate is correct, but one undifferentiated namespace is not.

The system needs a single reduction substrate with multiple semantic partitions.

## Purpose

The partition model separates:

1. durable facts
2. active computation
3. principal context
4. addressed obligations
5. delivery opportunity
6. receiver-specific presentation

These are all related, but they do not obey the same lifecycle, persistence, visibility, or indexing rules.

## Core Claim

There is one substrate.

That substrate is the append-only typed block system.

Within that substrate, every mount belongs to one semantic partition.

The partition is not cosmetic. It determines:

- authority
- persistence
- visibility
- resumability
- indexing
- lifecycle rules
- allowed references

## Partitions

### 1. `state`

`state` contains durable contested facts.

Examples:

- `state://contracts/acme/status`
- `state://artifacts/pkg.chat-service`
- `state://reports/q4/body`

Properties:

- authoritative
- persisted
- replayable
- shared across processes
- subject to conflict resolution and write policy

Question answered:

"What is true in shared world state?"

### 2. `process`

`process` contains active computation state.

Examples:

- `proc://p123/claims/gap-9`
- `proc://p123/plan/step-4/status`
- `proc://p123/pending-mounts/12`
- `proc://p123/lease/expiresAt`

Properties:

- authoritative while live
- may be persisted only if resumable by design
- scoped to an execution context
- includes claims, leases, in-flight assumptions, local rollback boundaries

Question answered:

"What is this computation currently doing?"

### 3. `identity`

`identity` contains principals, approval rules, visibility, and delegation.

Examples:

- `id://users/alice/roles`
- `id://agents/report-bot/tools`
- `id://org/acme/policies/visibility/contracts`
- `id://users/alice/delegations/report-bot`

Properties:

- authoritative
- persisted
- slow-changing relative to process state
- governs access, authorship, and approval

Question answered:

"Who may do, see, approve, or delegate what?"

### 4. `request`

`request` contains addressed obligations.

A request is not the same thing as a gap.

A gap means:

"something required is unresolved."

A request means:

"this unresolved matter has been addressed to some identity, process, or route under explicit terms."

Examples:

- `req://r55/targetIdentity = id://users/alice`
- `req://r55/subject = state://contracts/acme/approvals/legal`
- `req://r55/requiredAction = "approve"`
- `req://r55/deadline = 1712800000`

Properties:

- authoritative
- persisted
- routable
- claimable
- may outlive any particular process

Question answered:

"What is being asked, of whom, under what terms?"

### 5. `channel`

`channel` contains delivery opportunity and interaction-channel state.

Examples:

- `chan://users/alice/desktop/visible = true`
- `chan://users/alice/browser/firefox/interruptible = true`
- `chan://users/alice/browser/firefox/lastSeenAt`
- `chan://users/alice/email/reachable = true`

Properties:

- authoritative operational state
- persisted or soft-persisted depending on channel kind
- updated at interaction speed
- drives delivery, escalation, and interrupt policy

Question answered:

"Can this request be delivered effectively right now, through which surface?"

### 6. `projection`

`projection` contains receiver-specific rendered state.

Examples:

- `proj://session-abc/view/main`
- `proj://session-abc/view/request-r55`
- `proj://agent-42/prompt/current`

Properties:

- derived
- not authoritative
- recomputable from authoritative partitions plus projection policy
- may update at UI speed

Question answered:

"What should this receiver see right now?"

## Authority Rules

### Authoritative partitions

These are authoritative:

- `state`
- `process`
- `identity`
- `request`
- `channel`

### Non-authoritative partition

This is not authoritative:

- `projection`

The projection may be live, streamed, editable-through, and interactive, but it does not settle truth by itself.

## Persistence Rules

### Must persist

- `state`
- `identity`
- `request`

### Persist according to operational policy

- `channel`
- `process`

`channel` may be soft-state with timeouts.
`process` persists only when resumability is required.

### Never authoritative persistence

- `projection`

Cached projections may exist, but only as performance artifacts.

## Gap, Request, and Process

These must not collapse.

### Gap

A gap is a structural lack relative to a contract or schema.

It belongs to:

- `state`
- `process`
- occasionally `identity` or `request`

depending on where the unresolved obligation is declared.

### Request

A request is an addressed operational object created from a gap or other trigger.

Not every gap becomes a request.

### Process Claim

A process claim means some process has taken responsibility for attempting to resolve a request or gap.

Not every request is currently claimed.

## Promotion Rule

The default promotion rule is:

`gap` does not automatically imply `request`

A request is created only when:

1. a scheduler promotes it
2. a policy requires explicit routing
3. a human or agent explicitly addresses it
4. a gap crosses urgency or deadline thresholds

This prevents the system from exploding every unresolved structural detail into operational work items.

## Request Lifecycle

A request moves through these states:

1. `open`
2. `routed`
3. `delivered`
4. `seen`
5. `claimed`
6. `fulfilled`
7. `expired`
8. `cancelled`
9. `escalated`

### Definitions

`open`
The request exists but is not yet routed.

`routed`
The system has selected target identities, channels, or processes.

`delivered`
A delivery attempt succeeded on at least one channel.

`seen`
Some target surface or principal acknowledged visibility.

`claimed`
A process or principal has taken responsibility for resolution.

`fulfilled`
The underlying obligation is satisfied.

`expired`
The request exceeded deadline or lease.

`cancelled`
The request is no longer relevant.

`escalated`
The request has been re-routed or broadened due to non-fulfillment.

## Channel and Delivery

`channel` does not subsume `request`.

The relation between them is:

`DeliveryAttempt`

This may be represented as:

- a first-class object
- or a subgraph within `request`

but semantically it is the join between request and channel.

Examples:

- `req://r55/deliveries/1/channel = chan://users/alice/browser/firefox`
- `req://r55/deliveries/1/deliveredAt`
- `req://r55/deliveries/1/seenAt`
- `req://r55/deliveries/1/outcome = "seen"`

## Cross-Partition References

The system requires explicit cross-partition references.

Recommended URI-style forms:

- `state://...`
- `proc://...`
- `id://...`
- `req://...`
- `chan://...`
- `proj://...`
- `tool://...`

These may later compile to path prefixes, but semantically they are distinct reference classes.

## Allowed Reference Directions

These are the default allowed directions.

### `state`

May reference:

- `state`
- `identity`

Should not depend on:

- `projection`
- ephemeral `process`

except through explicit persisted outcomes.

### `process`

May reference:

- `state`
- `identity`
- `request`
- `channel`
- `process`

May emit:

- proposed state writes
- request claims
- delivery actions

### `identity`

May reference:

- `identity`
- `state`

Should not depend on:

- transient projection state

### `request`

May reference:

- `state`
- `identity`
- `channel`
- `request`

May be claimed by:

- `process`

### `channel`

May reference:

- `identity`
- `request`

Should not define durable shared facts outside delivery/presence concerns.

### `projection`

May reference everything.

Nothing authoritative should depend on `projection`.

## Join Model

The system's meaningful active work occurs at:

`request x process x state x identity x channel`

`projection` is derived from that join.

This resolves the earlier confusion:

- state alone is not enough
- process alone is not enough
- a gap alone is not enough
- a visible browser tab alone is not enough

Operationally meaningful work needs all of:

- something unresolved
- someone or something asked to resolve it
- some executing context attempting it
- some authority model
- some delivery opportunity

## Projection Semantics

`projection` is a live materialized lens, not a passive snapshot.

It may:

- update at UI speed
- hold local optimistic state
- stream deltas
- collect user edits
- emit writes, requests, or claims back into authoritative partitions

But:

it is still derived.

Edits made through a projection must land in one of:

- `state`
- `process`
- `request`
- `identity`
- `channel`

depending on the semantic meaning of the action.

## Edit Routing Rules

The system should route edits as follows:

### State edit

If the user changes a durable shared fact:

- write to `state`

Example:

- editing a contract clause

### Process edit

If the user changes in-flight computational intent:

- write to `process`

Example:

- pausing a running plan
- changing local process parameters

### Request edit

If the user responds to or modifies an addressed obligation:

- write to `request`

Example:

- approve
- reject
- defer
- reassign

### Identity edit

If the user changes authority or visibility:

- write to `identity`

Example:

- grant access
- delegate approval

### Channel edit

If the user changes interruptibility or attention routing:

- write to `channel`

Example:

- mute desktop alerts
- mark current device active

## Indexing Rules

The indexing strategy must respect partitions.

At minimum, indexes must distinguish:

1. durable dependency edges in `state`
2. claim/lease edges in `process`
3. authority/visibility edges in `identity`
4. routing/delivery edges in `request`
5. presence/interruptibility edges in `channel`

Without this distinction, the system cannot tell:

- durable data dependencies
- in-flight claims
- approval requirements
- delivery opportunities

apart from one another.

## Recommended Concrete Encoding

Implementation may use either:

1. prefixed paths
2. mount-level partition metadata
3. both

Examples:

- `state.contracts.acme.status`
- `proc.p123.claims.gap9`
- `id.users.alice.roles`
- `req.r55.targetIdentity`
- `chan.users.alice.desktop.visible`
- `proj.session123.main`

If prefixes are used, they are not enough by themselves.

The partition must also drive:

- persistence policy
- visibility policy
- lifecycle enforcement
- indexing behavior

## Non-Goals

This model does not require:

1. separate physical databases per partition
2. separate Sequence implementations per partition
3. immediate DSL surface syntax for every partition

It only requires semantic distinction in the substrate and its laws.

## Minimal Invariants

1. `projection` is never authoritative.
2. `request` is not equivalent to `gap`.
3. `channel` is not equivalent to `request`.
4. `process` claims do not by themselves become durable `state`.
5. `state` should not depend directly on ephemeral `projection`.
6. Every authoritative mount belongs to exactly one partition.
7. Cross-partition references must be explicit.

## Immediate Design Consequence

Before changing code, the system should be evaluated in terms of:

1. where a fact belongs
2. whether it is authoritative
3. how long it must live
4. who may see or change it
5. what partitions it may reference

If those answers are unclear, the mount is not yet well-modeled.
