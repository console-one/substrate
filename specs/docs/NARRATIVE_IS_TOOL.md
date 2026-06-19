# Narrative IS Tool IS Derived

The substrate's load-bearing claim: there is one primitive — a claim with positions, narrowed by composition. Cascade fires when a position becomes concrete. There is no separate "function," "value," "narrative," or "rule." They are encodings of the same shape.

This document is the operational answer to: **what's the difference between a narrative and a tool?**

## The principle

A claim has positions. Each position has a type. Mounting at a position narrows it. When a claim has all-concrete positions, it is a value. When it has unfilled positions, it is a function from-the-unfilled to-the-completed-claim. The kind boundary is artificial.

```
narrative with {{user}} hole               =  function from user to completed text
fn type with param(T_in), returns(T_out)   =  function from T_in to claim at T_out
derived(rule, ...inputPaths)               =  function from input values to derived claim
```

All three are: **a claim that produces its value when its positions narrow**. The cascade is the same primitive.

## Today's encoding (debt)

The kernel currently has three distinct branches for the same shape:

| Encoding | Constraint | Cascade trigger | Result destination |
|---|---|---|---|
| Templated narrative | `template('text {{path}}')` | `path` mounts → re-render | schema's own value |
| Derived value | `derived(fnId, ...argPaths)` | argPath mounts → call impl | schema's own value |
| Fn-tool | `param + returns` (kind:'fn') + impl | bind input to fn path → call impl | `{fnPath}.result` |

The first two route through the same `fireDerived` cascade machinery. The third has a privileged shortcut in `applyEntry` (sequence.ts) that:

1. Detects when `entry.value` is being bound to a schema of `kind:'fn'`.
2. Looks up the impl in `implRegistry`.
3. Calls `impl(value)` synchronously (or awaits the Promise).
4. Mounts `.input` and `.result` as separate sub-paths.
5. Fires `runCapCompletion` for contract observations.

This shortcut contradicts the substrate's principle for the same reason the old `enforceContract` did: it makes a category of claim get "evaluated" by a separate runtime instead of being dispatched by the kernel's normal cascade.

## What's landed (2026-04-19)

`template(textWithHoles)` is the bridge. Mount a narrative as `kind:'string'` with a `template(...)` constraint and the same `fireDerived` machinery that drives `derived(...)` rules drives the narrative's narrowing. Tests in `packages/core/src/test/narrative-is-tool.test.ts`:

- A narrative with `{{user}}` and `{{place}}` holes shows the holes verbatim until they fill.
- Mounting `user = "alice"` narrows the narrative through cascade.
- Cascading narratives compose (one templated value feeds another).
- Filling all holes is operationally identical to "calling a function with all its arguments."

This proves the principle for the narrative half. The fn-tool encoding still has its shortcut.

## Migration path (multi-session)

The fn-kind shortcut should be retired the same way `enforceContract`'s constraint evaluation was — the work moves into the kernel evaluator and the special branch becomes redundant.

Concrete steps:

1. **Express tool impl as a derived rule.** Register the impl under a built-in `_capInvoke:{capPath}` handler. The schema gains an implicit `derived('_capInvoke:{capPath}', '{capPath}.input')` constraint.
2. **Bind-to-fn-path narrows the input position.** Instead of `applyEntry` short-circuiting to call the impl, the kernel mounts the value at `.input`. The cascade detects the derived rule, fires the impl, narrows the tool's value position.
3. **Result mounts via cascade.** No more bespoke `.result` plumbing. The tool's own path receives the result; the cascade mounts it like any other narrowed claim.
4. **Tool completion is just cascade.** `runCapCompletion` (already in place) becomes a normal observational law on the cascade event. No special "after-impl" hook.
5. **Async tool impls.** The async wrapper `enforceContract` retires when the cascade gains async support. Until then, async tools mount a "pending" placeholder synchronously and the resolved result arrives in a follow-up cascade tick.

After this lands, **a narrative-with-holes and a fn-tool are operationally indistinguishable**. Both are claims with positions. Both fire cascade rules to narrow their value. Their `template(...)` / `derived(...)` / `param+returns+impl` declarations are different syntaxes for the same primitive, dispatched by the same evaluator.

## Why bother

Three reasons.

**Coherence.** The substrate's whole point is that constraints ARE behavior, dispatched uniformly. A user reading a narrative's `{{user}}` injection and a user reading a tool's `param(...)` constraint should both reasonably expect the same kernel behavior on the same primitive — narrow this position; let the cascade resolve. Today they get different mechanisms.

**Composability.** A narrative can't easily be wrapped, decorated, or invoked through the same plumbing as a tool. A tool can't be partially filled and rendered for inspection like a narrative. Unification removes the artificial wall.

**Renderability.** A partially-narrowed narrative has a sensible string projection (the template with verbatim placeholders). A partially-narrowed tool is a registered impl with no inputs — opaque. Unifying lets tools be inspected as templates of their input/output types: a partially-bound tool renders as the description of what it would do once filled.

## Memory: this is debt of the same shape as enforceContract

`feedback_enforce_contract_is_debt` named the pattern: type DECLARATION operationally separated from kernel ENFORCEMENT. The fn-kind branch is the same pattern at a higher tier — type DECLARATION of a callable claim operationally separated from cascade NARROWING of a positioned claim. The migration plan is the same shape: move the work into the kernel evaluator, retire the wrapper.
