# Repo Comparison

This compares:

- `ft` — the current substrate-first repo
- `~/lens-desktop/lens-desktop` — the older product-first repo

The purpose is to explain why they feel so different, why the migration loop happened, and what should actually be carried forward.

## Summary

The two repos are not competing implementations of the same thing.

They are optimized for different layers:

- `lens-desktop` already has a concrete product ontology
- `ft` has a cleaner state substrate

Your confusion is coming from trying to use the second as if it already implied the first.

## What `lens-desktop` Already Has

The old repo has a real product object model.

From [`docs/OPERATING_MODEL.md`](/Users/andrewchalmers/ft/../lens-desktop/lens-desktop/docs/OPERATING_MODEL.md):

- root/session/workspace scopes
- packages as installable artifacts
- tools as compiled package projections
- kits as partially-resolved package instantiations
- constants as bound inputs
- explicit package consumers
- UI pages that inspect and edit those things

That is why it could support a coherent install flow:

1. choose blueprint
2. create draft/workspace
3. compile projected tools
4. detect missing requirements
5. render typed form fields
6. provide values
7. commit package

That flow is product-coherent even if the implementation is hard to trace.

## Why `lens-desktop` Feels Opaque

The coherence is spread across too many layers.

The install/edit flow crosses:

- renderer component state in [`kitDetail.tsx`](/Users/andrewchalmers/ft/../lens-desktop/lens-desktop/src/renderer/src/home/panes/components/kitDetail.tsx)
- renderer orchestration in [`usePendingMerge.ts`](/Users/andrewchalmers/ft/../lens-desktop/lens-desktop/src/renderer/src/hooks/usePendingMerge.ts)
- IPC workflow routes in [`main.ts`](/Users/andrewchalmers/ft/../lens-desktop/lens-desktop/src/main/main.ts)
- draft/workspace projection logic in [`draftProjection.ts`](/Users/andrewchalmers/ft/../lens-desktop/lens-desktop/src/core/workflows/draftProjection.ts)
- workspace semantics in [`workspace.ts`](/Users/andrewchalmers/ft/../lens-desktop/lens-desktop/src/shared/type/workspace.ts)
- field rendering logic in [`fieldTypeForm.tsx`](/Users/andrewchalmers/ft/../lens-desktop/lens-desktop/src/renderer/src/home/panes/components/fieldTypeForm.tsx)

The product semantics are there, but they are not localized.

This is the main architectural problem in the old repo:

"coherent user flow, incoherent implementation boundaries."

## What `ft` Already Has

The current repo has a cleaner kernel boundary.

From [`packages/core/src/sequence.ts`](/Users/andrewchalmers/ft/packages/core/src/sequence.ts) and related files:

- append-only blocks
- projection as derived state
- `compose` / `check`
- `where` / `while`
- gaps and backward inference
- capability markers and external invocation
- reader-scoped hoists

This is a stronger substrate than the old repo's `Workspace` model.

## What `ft` Does Not Yet Have

It does not yet have the old repo's product ontology.

Specifically it does not yet settle:

- package vs tool vs kit vs consumer as first-class product objects
- the lifecycle of draft installation and edit
- the exact UI document/view grammar
- package compilation as a stable product concept
- the concrete workflow object users manipulate

That is why it feels abstract and hard to test from the UI backward.

This is the main architectural problem in the new repo:

"coherent substrate, underdefined product boundary."

## The Key Difference

### `lens-desktop`

Started from product flows and accumulated a general system underneath.

Result:

- better immediate UX semantics
- worse traceability
- hidden coupling

### `ft`

Started from a general kernel and expects product flows to emerge cleanly.

Result:

- better substrate semantics
- weaker product specificity
- endless deferral of concrete UI/workflow choices

## The False Choice

The choice is not:

1. revert fully to `lens-desktop`
2. keep building only `ft`

That would force you to pick between:

- product coherence with codebase opacity
- substrate coherence with product vagueness

The real move is:

extract the product ontology from `lens-desktop`, and re-express it on top of `ft`.

## What Should Be Preserved From `lens-desktop`

These are real product insights, not accidental implementation details:

1. The distinction between packages, tools, kits, and consumers
2. The install lifecycle as draft -> provide -> commit
3. Gap-driven typed forms for resolving kit inputs
4. Tool preview before commit
5. Consumer-specific projection / policy editing
6. Session/workspace separation as a user-facing concept

Those gave the old product its legibility.

## What Should Not Be Preserved From `lens-desktop`

These are implementation patterns that make the system hard to reason about:

1. Semantic logic spread across renderer hooks, IPC glue, and projection adapters
2. Product truth derived from ad hoc intermediate shapes like `fullBlockSchema` and `fieldCandidates`
3. UI behavior depending on subtle draft lifecycle races
4. Heavy dependence on custom projection translation layers to recover typed forms
5. Hidden coupling between compilation, persistence, and UI read models

## What This Means For Next Steps

The immediate job is not to solve the grand unified DSL.

The immediate job is to freeze a product ontology that `ft` will support.

At minimum, define:

1. `Blueprint`
2. `Kit`
3. `Package`
4. `Tool`
5. `Consumer`
6. `Workspace`
7. `Session`
8. `DraftInstall`

For each, define:

- persisted representation
- projection/view representation
- lifecycle states
- relationship to gaps

## Recommendation

Do not revert wholesale to `lens-desktop`.

Do not continue treating `ft` as though the product layer will simply fall out of the substrate.

Instead:

1. mine `lens-desktop` for the product ontology and user flow
2. implement that ontology explicitly on top of `ft`
3. keep `ft` as the state/conflict substrate
4. do not port over the old repo's projection glue and lifecycle tangles

## Concrete Interpretation

If you want a one-line resolution:

`lens-desktop` knew what the user was doing.
`ft` knows more clearly what the machine is doing.

You need the first as a product model and the second as the kernel.
