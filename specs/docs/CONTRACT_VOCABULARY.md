# Contract Vocabulary

This is the substrate-side answer to "tools, throttling, observation-driven type narrowing." Every Sequence in the network is a service provider in a contract-based message-passing circuit. The vocabulary documented here is what makes that claim true. If a guardrail-shape policy can't be expressed using these primitives, this doc names what to add.

The probe at `services/contextgraph/src/test/contract-vocabulary-probe.test.ts` is the canonical "the substrate IS guardrail" test. It instantiates representative guardrail policies using only existing primitives. Add a test there before adding any new primitive.

## What "guardrail" means here

Reference is `@console-one/guardrail` at `~/publicpackages/guardrail`: a declarative temporal-constraint evaluation framework for API authorization. Its core abstractions:

| Guardrail primitive | Shape |
|---|---|
| Selector | extracts a value from a request (e.g., `model`, `user`, `day`) |
| Translation | composes selectors into derived values |
| Unit | metric template with `per: ['user', 'day']` partitioning |
| Submetric | bound metric reader |
| ResourceRelation | named predicate (`LESS_THAN`, etc.) |
| Constrainable | declarative rule (data) |
| Constraint | bound, executable rule |
| MetricDao | pluggable metric storage |
| C1APIAuthorizer | request gate |
| Scope | per-request eval context with event bus |
| SelectorSet | reactive dependency graph |

We do NOT consume guardrail. We make sure the substrate's vocabulary expresses these. Where it doesn't, we extend the substrate.

## Substrate analogues — how the kernel already covers the contract surface

| Guardrail primitive | Substrate idiom |
|---|---|
| Selector / Translation | `derived(fnId, ...argPaths)` constraint + dep-index |
| Unit / Submetric (with `per`) | path globs (`state.tool_instances.*`) + `partition()` declaration + `key('user', 'day')` |
| ResourceRelation | `gt`, `lt`, `eq`, `between`, `or`, `and`, `not`, `regex`, `oneOf`, `contains`, `matchesType`, `countGte` |
| Constrainable (data) | schema mount + `law({admission: true, check, reason})` |
| Constraint (executable) | the kernel's compiled admission-law evaluator (`runAdmissionLaws` in `packages/core/src/laws.ts`) |
| MetricDao | the Sequence projection itself — `seq.get(path)` reads, `seq.mount(...)` writes |
| C1APIAuthorizer | mount admission (kernel) + `enforceContract` (`packages/core/src/contract.ts`) |
| Scope (per-request eval ctx) | per-block cascade + `currentBlockEntries` + the `$author`/`$path`/`$time`/`$value`/`$instancePath` law-frame bindings |
| SelectorSet (reactive graph) | `_deps.{source}` and `_rdeps.{dependent}` — exposed as kernel-internals-as-values (CLAUDE.md design invariant 9) |

## Existing constraint constructors (what's in `packages/core/src/type.ts`)

- **Predicates**: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between`, `oneOf`, `contains`, `regex`, `exists`, `notExists`, `matchesType`, `countGte`
- **Logical**: `or`, `and`, `not`
- **Numeric bounds**: `min`, `max`
- **Identity / partition**: `key`, `partition`, `bindFrom`
- **Type / shape**: `property`, `element`, `arrayLength`, `param`, `returns`, `endpoint`, `auth`
- **Distributional**: `distribution`, `decay`, `cdfGte`, `concreteAt`
- **Aggregation hooks**: `derived`, `computable`, `producedBy`
- **Behavioral**: `law`, `indexSpec`
- **Contract runtime**: `quota`, `reliability`, `trace`
- **Arithmetic in expressions**: `add`, `mul`, `pm`, `call`

## Path-template extension (just landed — `packages/core/src/contract.ts`)

`quota`, `reliability`, and (TODO: `distribution`) accept `${name}` placeholders in any path argument. Substituted from the call's input record before path resolution. Idempotent + null-safe — missing bindings leave the placeholder verbatim so failures are obvious.

```ts
quota(
  '.usage.by.${user}.${day}.tokens',         // partitioned counter
  '.limits.tokens_per_day',                  // shared limit
  'tokens_estimate', 'tokens_used',
);

reliability('.reliability.by.${user}.${model}');   // per-(user, model) prior
```

ONE constraint declaration covers N partitions. The contract runtime substitutes per-call from `input` (e.g., `{ user: 'alice', day: '2026-04-19' }`), reads / writes / increments the right bucket. No caller pre-summing. No procedural quota lookup. No per-tool-per-bucket schema.

## Requirements — what the vocabulary needs to express

These are guardrail-equivalent (or richer) policy shapes the substrate must express. Each is checked against the probe; landing requires extending the probe with a passing test for the new shape.

### R1 — Single-path quota (counter < limit) ✓ landed
Existing `quota('.usage.tokens', '.limits.tokens_per_day', ...)`. Pre-check + post-update via `enforceContract`. Probe 4.

### R2 — Partitioned quota (per-bucket counter) ✓ landed
Path-template extension. `quota('.usage.by.${user}.${day}.tokens', limit, ...)`. Probe 5.

### R3 — Partitioned reliability (per-bucket Bayesian prior) ✓ landed
Same path-template mechanism on `reliability`. Per-(user, model) alpha/beta. Probe 6.

### R4 — Sliding-window quota (counter < limit over last N seconds, not since-mount) ✓ landed
`windowedQuota(usagePath, limitPath, windowMs, inputField, outputField?)` constructor in `type.ts`. The contract evaluator stores per-call entries at `{usagePath}._entries.{seq}` carrying `{ at, delta }`. Pre-check walks entries with `at >= now - windowMs` and sums them. Stale entries fall out naturally — no GC required for correctness. Probe in contract-vocabulary-probe ("R4 windowed quota").

### R5 — Cross-tool shared budget (quota group) ✓ landed
`quotaGroup(groupUsagePath, groupLimitPath?)` constructor in `type.ts`. Multiple tools with the same `quotaGroup` declaration contribute to the shared bucket; the admission pass rejects when the GROUP total + estimate would exceed the group limit, regardless of per-tool slack. Probe in contract-vocabulary-probe ("R5 quotaGroup").

### R6 — Empirical-bound constraints (constraint args READ from lawframe state) — NOT YET
"After 100 calls with 99% success, the tool's reliability claim narrows; consumers see the tightened type." Today `reliability` is a static constraint. Need: constraints that resolve their numeric args by reading from a lawframe path. Probably `reliabilityWhere(priorBase, condition)` that dynamically narrows based on accumulated alpha/beta crossing thresholds. The hard part is making the tool's TYPE narrow — not just the runtime check but the schema visible to introspection.

### R7 — Pattern-matched policy dispatch (`lookslike`) — partial
Today: ordered union + `covers/selectFirstBranch` handles dispatch. Probe 3 demonstrates the substrate has the primitive. What's missing: an idiomatic policy-by-input-shape lookup helper, like `whenInput(shape, then)` that compiles to ordered-choice. Sugar, not new mechanism.

### R8 — Atomic transactional commit (all constraints pass → commit; any fail → no commit) ✓ landed
The kernel does this already: `runAdmissionLaws` is all-or-nothing on the entry set; failure causes the block to NOT apply. Multi-entry blocks with cross-entry admission gates are atomic by construction.

### R9 — Per-request event bus (publish 'success' / 'break' from constraints) ✓ landed
The cascade IS the event bus. Each mount fires dep-cascade; observers (tools, indexSpec class bodies, reader contracts) receive the events. `MountResult.gaps[].reason` carries the rejection's reason verbatim.

### R10 — Pluggable storage abstraction (MetricDao) ✓ landed
The Sequence projection IS the storage abstraction. Snapshot via `priorSnapshot` config. Persistence via the storage tool (`fs.read/write` adapter). Cross-process via Sequence-node composition. No `MetricDao` interface needed — the substrate's read/write IS the interface.

### R11 — Versioned policy hot-reload (replace policies at runtime) ✓ landed
`version(n)` constructor in `type.ts`. When a tool's fn schema mounts with a `version` constraint, the kernel writes the version number to `_tools_version.{capPath}` so consumers can read which version of a tool they are running. Subsequent schema mounts replace the version atomically. Probe in contract-vocabulary-probe ("R11 version").

### R12 — Observation-driven type narrowing (ad-hoc deriver tools consume the lawframe and synthesize tighter constraints) — partial
The lawframe machinery exists (`_lawframes.{tool}._prior.{alpha,beta}`). What's missing: a registered "deriver" tool pattern that watches the lawframe via dep-index and mounts a tighter type at `_types.{tool}.input` whose admission narrows what the tool accepts. This would close the loop "use → observed bounds → tighter type → admission rejects out-of-bound future calls."

### R13 — Time-windowed selectors (day, hour, week buckets) ✓ landed
Built-in `${day}`, `${hour}`, `${minute}`, `${week}`, `${month}`, `${year}`, `${time}` placeholders are auto-resolved from the sequence's deterministic clock when the call's input doesn't supply them explicitly. So `quota('.usage.by.${user}.${day}.tokens', ...)` works without the caller computing the day. ISO formats; `${week}` produces `YYYY-Www`. Probe in contract-vocabulary-probe ("R13 time-bucket auto-binding").

### R14 — Resource-relation registry (named predicates with consistent semantics) ✓ landed
The substrate's `gt`, `lt`, etc. ARE the registered relations. They evaluate to booleans, can be composed via `or`/`and`/`not`, and the law evaluator dispatches by `op` name. New relations are added to `type.ts` + handled in `evalWithBindings`. Same shape as guardrail's `ResourceRelations` registry, just written as TS rather than JSON-keyed.

### R15 — Federation: tool-to-tool calls across processes — partial
Tool A in process P invokes tool B in process Q. Today: A mounts a fn-typed gap; cascade fires; if Q is subscribed via Sequence-node composition, the mount propagates over the wire; B's tool covers the gap; B's process invokes; result mounts back. The wire layer is there. What's missing: a federation-aware quota (gather quota state across peers before pre-check) — open design question whether to centralize at the parent or eventually-consistent at each tier.

## Discipline

- Before adding ANY constraint constructor: write a probe test that demonstrates the policy shape is currently inexpressible.
- Before consuming any external authorization library: open `feedback_sequence_should_be_guardrail.md` and confirm the gap can't be closed by extending the substrate first.
- Land vocabulary additions in `packages/core/src/type.ts` (constructors) + the kernel evaluator (`packages/core/src/laws.ts`) when possible. Avoid `packages/core/src/contract.ts` for new behavior — see the architectural-debt section below.
- Each new constructor needs: jsdoc with example, type signature, kernel-side handler, evaluator clause if it's a predicate, probe-test pass.

## Architectural debt: enforceContract is operationally separated from the type

**Migration status (2026-04-20):** Complete. `enforceContract` is deleted. All constraint EVALUATION lives in `packages/core/src/contractLaws.ts`; the kernel evaluator (`runAdmissionLaws` + `runCapCompletion` in `packages/core/src/sequence.ts` + `laws.ts`) dispatches every gate and observation natively when a fn-typed schema's input is mounted. Async tool impls compose through `MountResult.capCompletion` — a Promise the kernel populates and imperative callers await. Production code (`services/contextgraph/src/tool.ts`) uses the substrate path directly. Tests cover both paths (`contract-runtime.test.ts` tests the kernel evaluator; `contract-vocabulary-probe.test.ts` tests partitioned constraints via direct mount).

**What this section originally documented (kept for context):**

`packages/core/src/contract.ts` exports `enforceContract`, an imperative TypeScript runtime that:
1. Reads `quota` / `reliability` / `distribution` / `trace` constraints from a fn type.
2. Runs a pre-check (rejects on quota).
3. Calls an injected `invoke` function (the tool impl).
4. Runs post-updates (increments quota counters, updates reliability priors via Bayesian conjugate update, decays latency distributions, mounts the trace).

This separation is wrong. It contradicts the substrate's load-bearing claim — that constraints ARE behavior, evaluated by the kernel on every relevant mount, with no separate runtime. With `enforceContract` in the picture:

- A consumer reading the tool's fn type sees `quota(...)`, `reliability(...)` constraints and reasonably assumes the kernel enforces them on every mount through the tool's path. It does not — only `enforceContract` does. **(Now resolved for direct mounts: kernel admission natively dispatches quota; sync tool completion natively dispatches reliability + trace + distribution + quota update.)**
- The contract constraints are effectively configuration for an out-of-band runtime, not type-state. This is the engine separation the substrate exists to refute. **(Now resolved: contractLaws.ts is the single source of truth; contract.ts delegates.)**
- `enforceContract` is the kind of TypeScript-on-Sequence layer that `feedback_no_typescript_for_type_state` explicitly forbids. **(Partially resolved: enforceContract still exists as the async adapter, but has no constraint-evaluation logic of its own — it is purely lifecycle plumbing now.)**
- Tools that call tools without going through `enforceContract` (e.g., raw mounts) bypass the contract silently. The only thing keeping behavior coherent is the convention that all tool calls go through the wrapper. The substrate should make this guarantee structural, not conventional. **(Now resolved for sync tools: direct `seq.mount('bind', fnPath, input)` triggers admission with quota check, then fires the impl, then fires tool-completion observations.)**

### What it should be (target architecture)

A tool invocation IS `seq.mount('bind', cap_input_path, value)`. The kernel's existing machinery does the work:

1. **Quota → admission law.** Pre-mount admission already runs declared laws (`law({admission: true, check, reason})`) on every covered mount and rejects atomically. `quota` becomes a known constraint the admission evaluator handles natively (reads usage path, reads limit path, checks `usage + estimate <= limit`, rejects with a structured reason). No `enforceContract` indirection.

2. **Tool auto-wire fires the impl.** The kernel already auto-wires gaps with covering tools. After admission passes, the impl runs; its result is a normal mount at the output path; the cascade fires.

3. **Reliability prior → observational law on tool completion.** The substrate has observational laws — they fire on every fact change, do not gate, just observe. A `reliability` constraint on the fn type registers an observational law that watches the tool's result event (success / failure / latency) and Bayesian-conjugate-updates the prior at the resolved path. No `reliabilityPostUpdate` function.

4. **Latency / distribution → observational law on timestamp delta.** Same shape: `distribution('time', 'lognormal', {mu, sigma})` on the fn type registers an observational law that updates the parameters from the observed `(end - start)` of each invocation.

5. **Trace → observational law on call event.** `trace(template)` registers an observational law that mounts a structured record at the templated path on every tool completion.

After all of this lands, `enforceContract` is deleted. Its tests stay green because the OBSERVABLE behavior is identical — the gate still gates, the prior still updates, the trace still records — just done by the kernel evaluator dispatching declared laws on real mounts instead of an imperative wrapper reading the same declarations and faking the same effects.

### Kernel gaps (originally blocking, now mostly closed)

- ~~Admission laws today fire pre-mount; they don't see post-mount values. Quota's pre-check needs the new value (estimate); that's already in the entry being mounted, so this is expressible — the admission evaluator just needs to know about `quota` as a structured constraint with `usage_path` / `limit_path` / `input_field` semantics.~~ **Closed (2026-04-19).** `runAdmissionLaws` now natively dispatches `quota`, `windowedQuota`, and `quotaGroup` for any bind whose target schema is fn-typed. The estimate comes from the entry's value record.
- ~~Observational laws today fire on fact changes; they don't have a notion of "tool-call completed with success/failure and latency T." The kernel needs a structural tool-completion event that fires observational laws with the call context.~~ **Closed (2026-04-19).** `runCapCompletion` (in `contractLaws.ts`) is the structural event. The kernel sync fn-invocation in `sequence.ts` fires it after impl completion (success / error), carrying basePath, input, output, latencyMs, status. Reliability / quota-update / trace / distribution observations dispatch from there.
- ~~Tool auto-wire and admission are not currently composed (admission gates writes; tool auto-wire fires impls; the two aren't on the same firing path). Composing them is a small kernel change.~~ **Closed for sync tools (2026-04-19).** Block-level admission gates the tool input bind; if it admits, applyEntry's fn-invocation branch fires the impl on the same firing path. They are now composed.
- Async-aware cascade: tool impls are async; current cascade is sync. Either the tool mounts a "pending" placeholder synchronously and the result mount is a separate async block, or the cascade gains async support. Either way the contract constraints work the same. **Still open.** The async wrapper (`enforceContract`) remains as the bridge for async HTTP tools. When async-aware cascade lands, the wrapper disappears.

### Migration discipline

- New contract-class constraint constructors (windowedQuota, quotaGroup, circuitBreaker, etc. — see R4–R15 above) must NOT add behavior to `enforceContract`. They MUST be implemented as kernel-evaluator dispatch (admission for gates, observational for updates).
- Existing behavior in `enforceContract` is frozen — no new features added there. Bugs fixed only.
- The migration of existing constraints (`quota`, `reliability`, `distribution`, `trace`) from `enforceContract` to kernel-evaluator dispatch is a tracked architectural-debt cleanup, not a refactor blocked on anything.
- Until the migration completes, `enforceContract` exists as a transitional shim. Code calling it should be aware it is NOT the substrate's principled shape. Treating its presence as "this is how tool invocation works" perpetuates the debt.
