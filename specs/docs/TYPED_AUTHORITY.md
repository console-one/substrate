# Typed Authority via Identity Preservation

## Principle

**Access control is type incompatibility.** There is no separate authority layer, no tool registry, no `Tool` class, no router fn, no "kinds on hand" context passed into backward inference. Secrets, credentials, and authority facts are ordinary typed values in the identity partition, governed by the same `identity()` fn-type constraint that governs any other round-trip preservation pattern.

## Identity is preservation by name

Two uses of the word "identity" in this codebase are the same concept at different scales, and earlier design discussion drifted because this wasn't made explicit.

1. **Fn-type constraint `identity()` in `packages/core/src/compose.ts`** — value-level preservation through a function pair. `setReport<name, body>({id: name, body: s2}): Value` where for all t > t(set), `getReport(Value) = {name, body: s2}`. Parametric, round-trip preservation between a setter and its inverse getter. Originally discussed under the label "generics"; later moved to "identity" because it captures round-trip fidelity, not just parametric shape.

2. **`identity` partition in `PARTITION_MODEL.md` §3** — principals, approval rules, visibility, delegation. "Who may do, see, approve, or delegate what?" Slow-changing authority facts preserved across time. Example paths: `id://users/alice/roles`, `id://agents/report-bot/tools`, `id://users/alice/delegations/report-bot`.

These are the same pattern applied at different scales. The `identity` partition holds the facts typed by `identity()` preservation constraints on named principal state. `grant(alice, role)` is a setter; `getRole(alice)` is a getter; the round-trip preserves across time unless explicitly updated. Principal identity is preservation-by-name.

## Why secrets need no dedicated primitive

A secret is a typed authority fact. There is no `Constant` class, no `Secret` primitive, no new entity kind.

A typed key is a function pair:

```
setX(caller, name, value): Ref
getX(caller, Ref): value
```

with `identity()` constraints tying `caller`, `name`, and `value` across the round-trip. A different caller's authored type will not unify with the Ref's `caller` slot, so `compose(getX, {caller': other, ref})` fails. **That type-level failure IS the access check.**

Backward inference walks this naturally: want `value`, find `getX`, need `Ref` of matching shape whose `caller` unifies with your author, compose or gap. Routing across authority boundaries is the same walk — if your scope doesn't hold the right `Ref`, backward inference can chain through whoever does, provided the chain composes by type end-to-end. There is nothing to invent.

Tools that currently hide their key requirements inside an impl closure (`openai.chat` reaches into `config.apiKey` out-of-band) will need to have those keys lifted into **explicit typed input parameters** when the site lands. A tool with a hidden prerequisite is a tool whose type lies.

## Explicit non-goals

The following are things this memo explicitly does NOT introduce:

- **No `Tool` class.** A tool is a mounted coherent function. The `tool` mount op still exists as legacy cruft and should be collapsed into `bind` with a fn value in a separate pass.
- **No `Constant` record type.** Secrets are typed values governed by `identity()`, not a new entity.
- **No router fn** that dereferences on behalf of a less-authorized caller. The "router" is backward inference finding a type-compatible chain.
- **No "kinds on hand" context** as a separate parameter to `backwardInfer`. The caller's current state IS the context.
- **No new constraint kind for partition.** Partitions are a semantic consequence of type dimensions, not a stored tag.
- **No first-class organization concept.** Org policies are predicates layered on existing constraints, not a privileged field.
- **No encryption primitive at the kernel level.** Encryption is a persistence policy for the identity partition. The type model doesn't change.

## Known implementation gap

`partitionOf(path: string)` in `packages/core/src/sequence.ts` currently matches partition by path prefix (`id.*` → `id`, `proc.*` → `proc`, etc.). PARTITION_MODEL.md §"Recommended Concrete Encoding" (line 555) is explicit that prefixes are a surface encoding and the partition must *also* drive persistence, visibility, lifecycle, and indexing policy:

> If prefixes are used, they are not enough by themselves. The partition must also drive:
> - persistence policy
> - visibility policy
> - lifecycle enforcement
> - indexing behavior

The current implementation matches the surface but not the policy consequences. A future cleanup pass should either:

1. Derive partition from type constraints (so a mount without the prefix still lands correctly based on what its type says it is), OR
2. Enforce the partition's policy rules from the model doc at every mount, not just the prefix check.

This doesn't block current work. It WILL block any production authority story, because without partition-driven persistence/visibility, a secret mounted in the identity partition doesn't actually get identity-partition persistence policy — it gets whatever the Sequence's default is. Noting here so future work against real authority doesn't pretend the gap isn't there.

## Landing sites (future, not now)

The typed-key pattern will land at the first tool genuinely blocked by needing authority. Candidates when they come up:

1. **Session auth tokens** — once the server goes non-localhost, each session needs a signed token. `sessions.{user}.tokenExpiry` already exists as half the shape. Issuance is a setter, validation is a getter, `identity()` ties the session's author to the token's claims.
2. **HTTP fetch against authed external APIs** — when something in the agent loop needs to hit github/openai/anthropic with a real key. The existing `http.fetch` tool takes arbitrary URLs without auth; authed variants would take a typed key as an explicit input parameter.
3. **AWS credentials for real S3 / DynamoDB** — when the Lambda env's `S3Storage` stub gets swapped for `@aws-sdk/client-s3`. The SDK's client is instantiated with credentials; those credentials become a typed key in the identity partition.

None of these are currently blocked. The pattern stays design-level consensus until one of them pulls on it. When it does, the first line of work is: **express the tool's hidden prerequisite as an explicit typed input parameter**, then land the setter/getter pair with `identity()` constraints, then let backward inference resolve the rest.

## Decision

Discussed, not landing. No code change in this pass. This memo captures the agreement so that whoever picks up the first real authority requirement can proceed directly from here without re-deriving the model.

---

*Related: `PARTITION_MODEL.md` for partition semantics. `packages/core/src/compose.ts` `backwardInferIdentity` for the preservation-chaining mechanics. `services/contextgraph/src/openai.ts` for a tool that currently hides its key inside an impl closure — a prime candidate for the typed-key treatment if it survives its `TODO: DELETE THIS FILE` marker.*
