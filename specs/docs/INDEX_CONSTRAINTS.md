# Index Constraints

**Status:** Design, not yet implemented.
**Author context:** Synthesized from a long working session where the author repeatedly corrected me ("production rule," "forEach class instantiation," "multi-emit derived constraint") into this single framing: **index constraint, a generalization of `key()`**.

---

## Why this document exists

The kernel currently cannot express "when X happens, Y must exist" in ft text. Every stateful workflow — the contextgraph server's tick phases (promotion, routing, claiming, fulfillment, expiry), the spec folder's 117 requirement documents (live editing, agent loops, task queues, backlinks, distributed scheduling, etc.) — has to be written as imperative TypeScript that walks the kernel from outside. That violates the project's core invariant: *application features are type state, not kernel methods*.

The missing primitive has been named wrong many times. It is not "production rules," not "forEach on classes," not "multi-emit derived constraints." It is **an index constraint with lookup-or-create semantics**, which is a generalization of the `key()` constraint already in the kernel.

This document is the durable reference for that primitive. When context is wiped and a future session picks this up, this is the starting point.

---

## The primitive

### `key()` today

The kernel already has `key()` as a constraint on glob schemas:

```
sessions.* = { user: string, env: string, tokenExpiry: number } | key('user', 'env')
```

When you mount `sessions << { user: 'alice', env: 'acme', tokenExpiry: ... }`, the `key` constraint computes the destination path from the value's own fields. The instance lands at `sessions.alice.acme`. The next mount with the same `(user, env)` tuple lands at the same path (idempotent). The "uniqueness key" is a projection of the value's own properties.

This is **a degenerate index constraint: one free variable (the value being mounted), key projection = function of that value's fields**.

### Index constraint — the generalization

An **index constraint** is `key()` lifted out of a single value's properties and onto an arbitrary binding space. Instead of "the key is derived from the fields of the value being mounted," it's "the key is derived from a tuple of bindings projected from a where clause."

```
class Promotion
  indexed by (policy, subject)
  where policy  ∈ _policies.promotion.*
    ∧   subject ∈ glob(policy.pathPattern)
    ∧   valueAt(subject) == policy.triggerValue
{
  -- Constructor body: fires once per missed (policy, subject) tuple.
  -- The instance path is derived from the key tuple.
  req.{key(subject)}.subject        = subject
  req.{key(subject)}.requiredAction = policy.requiredAction
  req.{key(subject)}.deadline       = _rt + policy.deadlineMs
  req.{key(subject)}.priority       = policy.priority
  req.{key(subject)}.status         = "open"
  req.{key(subject)}.targetIdentity = first(id.users.* where role == policy.targetRole)
}
```

What this says: **there is a class `Promotion` whose instances are uniquely identified by `(policy, subject)` tuples that satisfy the where clause. For each unique tuple that does not yet have an instance, the kernel instantiates one by firing the constructor.** The constructor body writes facts at paths derived from the tuple. Re-evaluation on the same tuple is a no-op because the same paths are addressed with the same values and compose reduces them to identity.

### Three claims this makes

1. **The where clause is not a boolean.** It is a projection into a tuple space. Its type today is `() → bool`; its generalization is `() → Set<Tuple>` where each tuple is a binding of the free variables introduced by the clause. Today's zero-free-variable case is degenerate: it returns either `{()}` (one empty tuple — the unit value — fire once) or `{}` (no tuples — don't fire). That reduces to true/false. The general case has N free variables and returns N-tuples.

2. **A class with an index constraint is self-instantiating.** You don't manually mount instances of it. The kernel watches the binding space and instantiates an instance for every tuple the where clause produces that doesn't already have one.

3. **Idempotency is structural, not enforced.** Because the instance path is derived from the tuple, re-firing on the same tuple produces the same path with the same values. Compose handles the rest: same-value-at-same-path is a no-op. The kernel doesn't need to track which tuples have fired as a correctness concern — only as an optimization to skip redundant firings.

---

## Semantics in detail

### Binding space projection

A where clause introduces free variables via constraints that bind them:

```
where policy ∈ _policies.promotion.*            -- binds `policy` to each descendant
  ∧   subject ∈ glob(policy.pathPattern)        -- binds `subject`, depends on `policy`
  ∧   valueAt(subject) == policy.triggerValue   -- filter: not a binding, restricts the tuple set
```

Each `∈` is a binding form. Each `∧` with no free variable (filter predicates) restricts the tuple set to those satisfying the filter. The where clause's meaning is the Cartesian product of all binding sets, filtered by all predicates.

For the Promotion example, the tuple space is:
```
{ (policy, subject)
  | policy ∈ _policies.promotion.*
  ∧ subject matches policy.pathPattern
  ∧ valueAt(subject) == policy.triggerValue }
```

### Lookup-or-create

For each tuple in the set, the kernel checks: does an instance exist at the derived instance path? The derived path is a function of the tuple (the `indexed by` clause plus the `key()` derivation).

- **Exists → no-op.** The instance has already been created.
- **Missing → fire constructor.** The class's body runs with the tuple bindings in scope. The body's mount statements use the bindings to compute paths and values. The instance exists afterward.

This is `getOrMount(indexPath, constructor)` — a standard memoization pattern, but driven by the cascade and the lattice.

### Derived paths and path interpolation

The constructor body mounts at paths that reference bound variables:

```
req.{key(subject)}.subject = subject
```

The `{key(subject)}` is **runtime path interpolation**: replace the braces with the value of `key(subject)` at the time the constructor fires. `key(subject)` is a deterministic function (the same primitive that lives on glob schemas today) that maps a path string to a stable id. For path `state.contracts.acme.approval.legal` the id might be `contracts_acme_approval_legal` — the exact form depends on the `key` function chosen.

This is what "fan-out emission from a class body" is in my earlier framing: **the class's body writes to multiple paths, and the path prefixes are determined by the tuple bindings**. Each instance writes to its own prefix; different tuples produce different prefixes; no collision, no duplication.

### The cascade fires the constructor on input changes

The kernel's existing cascade machinery is almost all that's needed. When an input path changes (e.g. `state.contracts.acme.approval.legal = 'pending'`):
1. `fireLaws` walks the change through the backward index (as it does today)
2. The Promotion class's where clause is registered in the backward index keyed by its input prefixes (`_policies.promotion.*`, the glob for `policy.pathPattern`)
3. The cascade fires the class's re-evaluation
4. The kernel re-projects the tuple space, identifies new tuples, and fires the constructor for each

Existing backward-index entries (`cascade`, `resume`, `invariant`, `behavioral`, `conjunction`) do the first three steps already for simpler forms. The new piece is step 4: the tuple-set diff and constructor-per-new-tuple dispatch.

---

## Mapping from the contract-builder DSL

The user's earlier DSL from another system already had this shape:

```ts
contractBuilder
  .when(lookslike({ model: 'gpt-4.0' }), 'GPT-4-Used')
  .set('[translation:tokens]').toLessThan(GPTLIMIT_NUMBER)
  .per('[request:user]', '[request:day]')
  .as('gpt4-user-daily-tokens')
```

Direct mapping to the index constraint form:

| Contract builder | Index constraint |
|---|---|
| `.when(predicate)` | `where` clause predicate |
| `.per('[request:user]', '[request:day]')` | `indexed by (user, day)` — the key tuple |
| `.as('gpt4-user-daily-tokens')` | the named rule / derived instance prefix |
| `.set(...).toLessThan(X)` | constructor body: an assertion mounted at the instance path |
| `.elseWhen(...)` | another class, or a branched where clause in one class |

`.per(...)` is the index constraint. `.as(...)` is the instance naming. `.set(...)` is what goes in the class body. `.when(...)` is the predicate that filters the tuple space. The whole builder is **syntactic sugar over classes-with-index-constraints**. The user had this in mind before the project started.

An equivalent Office Space rule in the new form:

```
class GPT4DailyQuota
  indexed by (user, day)
  where request.model == "gpt-4.0"
    ∧   user ∈ request.user
    ∧   day  ∈ request.day
{
  quota.gpt4.daily.{user}.{day}.tokens << lt(GPT_LIMIT)
}
```

Same semantics. Different surface syntax. The kernel has ONE concept underneath.

---

## What this replaces

### The tick phases in `services/contextgraph/src/server.ts`

Every phase method in the current contextgraph server is a class-with-index-constraint written in the wrong language:

| Phase | Indexed by | Where | Body emits |
|---|---|---|---|
| **Promotion** | `(policy, subject)` | policy in `_policies.promotion.*`, subject in `glob(policy.pathPattern)` where value == triggerValue, no existing non-terminal req for subject | `req.{id}.*` fields |
| **Routing** | `(req)` | req in `req.*` where status in {open, routed} and targetIdentity defined | `req.{id}.status`, `req.{id}.deliveredVia`, `req.{id}.deliveries.1.*` |
| **Claiming** | `(req)` | req in `req.*` where status == delivered and no active claim | `proc.{p}.*`, `req.{id}.decisionTrace.*`, `req.{id}.status = claimed` |
| **Fulfillment** | `(req)` | req in `req.*` where status == claimed and response defined | `{req.subject}`, `req.{id}.status = fulfilled`, `proc.{p}.status = completed` |
| **Expiry** | `(req)` | req in `req.*` where status non-terminal and deadline < `_rt` | `req.{id}.status = expired`, `req.{id}.expiredAt = _rt` |

Each phase is ~10-30 lines of class definition in ft text, replacing ~50-150 lines of TypeScript per phase.

The current `mountTickPhases` method (the recent session's attempt) is tool closures with the same logic as the old imperative methods. It's the same anti-pattern. It should be **deleted entirely** once index constraints exist; the phases become `bootstrap.ft` (or a new `workflows.ft`) class definitions.

### The 117 spec files

Every spec that describes "when condition, entity exists" is directly expressible once index constraints land. The spec folder contents:

- `agent/local-rootloop.md`, `remote-rootloop.md` — class `AgentRoot indexed by (agentId) where agentId ∈ id.agents.* ...` with body constructing the agent's runtime state
- `narrativemodel/liveediting.md` — class `Edit indexed by (editor, version) where ...` with conflict-detection semantics in the body
- `taskmanagement/labelledtaskqueue.md` — class `Task indexed by (id) where id ∈ tasks.*` with status-transition guards (ALREADY expressible in part via the existing stdlib/taskqueue.ft, but full requirements need index constraints)
- `contextgraph/backlinks.md` — class `Backlink indexed by (target, source) where there is a forward ref from source to target ...`
- `eventeconomics/*`, `distributedsched/*`, `logicandoperations/*` — each is a set of classes with index constraints and bodies

Most specs need nothing more than this one primitive. A few need additional kernel features (e.g., distributed authority, historical queries), but index constraints are the foundation on which most become tractable.

---

## What the kernel needs to change

Minimal additions to realize index constraints. In decreasing order of certainty:

### 1. Constraints can bind variables

A new constraint op `bind_from` (or similar — naming is not the important part):

```ts
{ op: 'bind_from', args: ['policy', '_policies.promotion.*'] }
// Introduces free variable `policy`, binds it to each value at the glob.
```

This lives alongside existing constraint ops (`eq`, `gt`, `exists`, `producedBy`, `key`, etc.) in `type.ts`. It's a new op with its own semantics: it doesn't directly evaluate to true/false, it contributes to the binding space of its enclosing where clause.

### 2. Where clauses evaluate to a tuple set

Currently `evalConstraint` in `sequence.ts` returns a `boolean`. The generalization returns a `Set<Tuple>` — each tuple being a mapping from free-variable names to values. A where clause with zero `bind_from` constraints returns either `{()}` (the unit tuple, if other predicates pass) or `{}` (empty — no fire).

Where clauses with one `bind_from` return a set of 1-tuples, one per binding. With two, the Cartesian product filtered by predicates that reference both. Etc.

This is a rewrite of `evalConstraint`'s signature and recursive eval, but the structure follows naturally. Predicates that don't reference any free variable become whole-tuple-set filters; predicates that reference free variables are per-tuple filters applied during projection.

### 3. Mount entries support runtime path interpolation

The walker currently mounts at literal paths. The index-constraint generalization needs mount statements whose paths include variable references:

```
req.{key(subject)}.status = "open"
```

Where `{key(subject)}` is a placeholder that gets resolved at fire time against the current tuple's binding of `subject`. The walker parses this as a templated path; the mount machinery interpolates at apply time.

`key()` as a function (not just a glob-schema constraint) is needed — it takes a path string and returns a stable id. Today's `key()` is a constraint on a glob schema that instructs mount to derive the destination. The function form is the same logic reused as an expression.

### 4. The cascade fires the constructor on tuple-set delta

When `fireLaws` walks a changed path, and the path is in the watch set of a class's where clause, the kernel:
1. Re-projects the class's tuple space with the new state
2. Computes the delta: which tuples are new since the last projection, which are gone
3. For each new tuple, fires the class constructor with the bindings in scope
4. For each gone tuple, invalidates the corresponding instance (cascade-driven cleanup)

The existing `cascade` and `invariant` backward-index entries are analogous — they're just scalar/boolean rather than tuple-set. The new kind (or a generalization of the existing `cascade` kind to support tuple sets) fits the same dispatch loop.

### 5. The walker parses class definitions with `indexed by` and `where` binding forms

DSL surface additions:
- `class Name indexed by (var1, var2) where constraints { body }`
- `where var ∈ glob_expr` binding form
- `{var}` path interpolation inside body mount statements
- Class bodies can write to derived paths (instead of only `Name.fixed.path`)

This is a real walker extension. It's the largest piece of code in the whole build. But it's purely additive — existing class definitions (no `indexed by`, no binding forms) continue to work.

---

## Staged build plan

The build can be done in stages, each leaving the tests green:

### Stage 1 — One binding, fixed interpolation

- `bind_from` constraint op
- `evalConstraint` returns `Set<Tuple>` for clauses with free variables
- Walker parses `class Name indexed by (x) where x ∈ _policies.foo.*`
- Path interpolation for one variable: `target.{x}.field`
- Cascade fires constructor per new tuple from a one-variable binding space
- **Test**: migrate ONE phase (promotion) as a class, verify the existing tick.test.ts expectations hold. Delete `promoteGaps` method.

### Stage 2 — Multiple bindings and nested projections

- Two or more `bind_from` constraints in one where clause
- Tuple-set projection as Cartesian product with filter predicates
- Path interpolation for multiple variables
- **Test**: migrate routing and claiming. Both need multi-variable projections.

### Stage 3 — Tuple delta tracking in the backward index

- The backward index tracks per-class tuple sets, not just "did the constraint change"
- `fireLaws` computes the delta when inputs change and fires only for new tuples
- Existing tuples don't re-fire unnecessarily; gone tuples trigger invalidation cascades
- **Test**: deadline expiry — when `_rt` advances past a deadline, the tuple corresponding to that request disappears from the "non-expired" set; the cascade fires invalidation which the expiry class catches to set status. This is time-driven cleanup via the same primitive.

### Stage 4 — Migration of all phases and deletion of tick machinery

- Fulfillment and expiry migrated
- `tick()` becomes a no-op or deleted entirely
- `setInterval` tick timer deleted (everything is cascade-driven)
- `mountTickPhases` deleted
- `services/contextgraph/src/server.ts` loses 400-600 lines; `bootstrap.ft` or a new `workflows.ft` gains ~100 lines of class definitions
- **Test**: full contextgraph test suite green with no TypeScript phase implementations

### Stage 5 — Spec realization sweep

- Pick 5-10 specs from the spec folder that are pure-index-constraint workflows
- Write their class files
- Write the AC tests
- Run
- **Result**: spec realization count goes from 1/117 to 10-20/117 in one pass

---

## What this document does NOT claim

- **It does not claim `sequence.ts` will shrink immediately.** Stage 1 will add code (new constraint op, eval generalization) before deleting anything. Net shrinkage comes at Stage 4.
- **It does not claim all 117 specs are one-primitive away.** Some need distributed authority, historical queries, human-in-the-loop flows, etc. Index constraints are necessary-not-sufficient for most specs.
- **It does not claim the walker changes are small.** Parsing `class ... indexed by ... where ... ∈ ...` with runtime path interpolation is a real syntactic extension. The walker grows.
- **It does not claim this is the only missing primitive forever.** It's the NEXT primitive after which the tick phases and the common spec shapes become expressible.

---

## The path from today

The current session's `mountTickPhases()` attempt is **the same anti-pattern the current tick methods were**: TypeScript closures pretending to be type state. It should be reverted to the imperative methods (which at least are honestly named) and the real fix — index constraints — should be built on a clean baseline.

Revert procedure:
1. Restore `tick()` to the imperative body that calls the five phase methods
2. Restore the private methods `promoteGaps`, `routeRequests`, `createClaims`, `fulfillRequests`, `expireDeadlines`
3. Delete `mountTickPhases` and its closures
4. Run the tick tests; they should pass as they did at session start

Then: build index constraints per the stage plan above. Phase methods get deleted one at a time as each class replaces its corresponding method and passes the same tests.

---

## The one-sentence summary

**Index constraints generalize `key()` from "the key is derived from a single value's properties" to "the key is derived from a tuple projected by a where clause," with lookup-or-create semantics that fire a class constructor when a new tuple appears, emitting mount statements at runtime-interpolated paths derived from the tuple bindings — and this is the single missing primitive that makes the entire contextgraph tick, and most of the 117 spec documents, expressible in ft text as type state instead of in TypeScript as methods on the kernel's side.**
