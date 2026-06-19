# Theoretical Foundations

This document captures the theoretical alignment between the ft kernel's operational semantics and established frameworks from Bayesian inference, active inference, and information-theoretic planning. These are not aspirational design goals — they are properties that emerge from the kernel's existing structure.

Any implementation that contradicts these foundations is wrong. Any extension that violates them should be rejected.

## Core Thesis

The Sequence is a bounded inference-control unit. Compose is Bayesian update. Gaps are hypotheses. Tools are candidate evidence-generating actions. The scheduler's job is selecting actions that minimize expected future surprise (uncertainty about goal achievement) under resource constraints.

## Bayes Theorem in the Kernel

Bayes: `P(hypothesis | evidence) = P(evidence | hypothesis) * P(hypothesis) / P(evidence)`

| Bayes | Kernel | Location |
|-------|--------|----------|
| P(hypothesis) — prior | `prior('reliability', 'beta', {alpha, beta})` on a tool type | type.ts |
| P(evidence \| hypothesis) — likelihood | `distribution('time', 'lognormal', {mu, sigma})` evaluated via `cdf()` | compose.ts |
| P(hypothesis \| evidence) — posterior | Result of `conjugateUpdate(family, params, observation)` | compose.ts |
| P(evidence) — marginal | `concreteness(path)` — total probability a path has a value, integrating over all tools | sequence.ts |
| Evidence test | `compose(schema, value)` — does the value satisfy the schema? | compose.ts |
| Hypothesis rejection | `compose → never` — evidence contradicts hypothesis | compose.ts |

The CDF and conjugate updates are two sides of the same theorem:
- CDF evaluates the **likelihood**: given current belief about a tool, what is P(it meets the deadline)?
- Conjugate update revises the **prior**: given observed outcome, update belief about the tool.
- The posterior becomes the new prior for the next evaluation.

## Compose IS Bayesian Update

`compose(A, B)` produces the tightest type consistent with both A and B. This is the lattice meet. In Bayesian terms:

- A = prior (the schema — what we expect)
- B = evidence (the value — what we observed)
- compose(A, B) = posterior (the tightened type — what we now know)
- never = posterior-zero (evidence contradicts the prior — hypothesis rejected)

A **gap** (schema without value) is a prior with no evidence yet — a hypothesis about what should exist. A **concrete value** is maximal evidence — the posterior collapses to a point. Filling a gap is accumulating evidence until the posterior is concrete.

This is not an analogy. It is what the code does. `detectContradiction` in compose.ts evaluates whether the posterior probability of meeting a constraint is above threshold. `selectFirstBranch` tests each hypothesis (union branch) against the evidence (input) and returns the first that isn't rejected.

## Partitions as Markov Blankets

The partition reference rules (PARTITION_MODEL.md) define which partitions can observe which:

```
state  → {state, id}
proc   → {state, id, req, chan, proc}
id     → {id, state}
req    → {state, id, chan, req}
chan   → {id, req}
proj   → {everything}
```

These are conditional independence constraints. `state` cannot reference `proc` — state beliefs are conditionally independent of process beliefs given the allowed intermediaries. This IS a Markov blanket structure:

- Each partition's **internal states** are its own paths
- Its **blanket** (sensory + active states) are the partitions it can reference
- It is conditionally independent of everything outside its blanket

The partition model was designed for operational correctness (durable facts shouldn't depend on ephemeral process state). The Markov blanket property is emergent — it falls out of the reference direction rules.

### Implication

Every partition is a bounded inference-control unit. It updates its own beliefs (values) based on evidence from its blanket (allowed references). It cannot be influenced by, or influence, anything outside its blanket except through explicit cross-partition mounts in allowed directions.

## Gap Resolution as Action Selection

A gap is an unresolved obligation — a schema without a satisfying value. The system has tools that could fill gaps. Selecting which tool to invoke is the planning/scheduling problem.

Under active inference, action selection minimizes **Expected Free Energy (EFE)**:

```
G(policy) = epistemic_term + pragmatic_term + complexity_term
```

In the kernel:

| EFE Component | Kernel Mechanism | What it measures |
|---------------|-----------------|------------------|
| Epistemic (information gain) | `distribution` constraints + `cdf()` | How much uncertainty does this tool resolve? |
| Pragmatic (preference satisfaction) | `responsePolicy(timeout, confidence)` + deadline constraints | Does this tool meet the goal within constraints? |
| Complexity (model/action cost) | Partition boundary crossings, token budgets, externalization cost | How expensive is this action in terms of boundary coupling? |

The current implementation (`selectFirstBranch`) is a greedy heuristic: first feasible branch wins. A true EFE-minimizing planner would score each branch by the joint `epistemic + pragmatic - complexity` and pick the best. The infrastructure supports this — the distributions, deadlines, and partition boundaries provide all three terms. The planner is a mounted tool that can be replaced with a better one without changing the kernel.

## Tools as Hypotheses

A tool is a function type: given input of type I, produce output of type O with preservation constraints, temporal bounds, and distributional guarantees.

In Bayesian terms, a tool is a **hypothesis about how to obtain evidence**:
- "If I invoke tool C with input X, I'll get output Y with probability P"
- This is P(Y | C, X) — the likelihood of the output given the tool and input

`backwardInfer(toolType, requiredOutput)` asks: "what input evidence would I need to make this hypothesis viable?" This is backward chaining through the likelihood model.

`search(requiredType)` explores the hypothesis space: "which sequence of tools maximizes P(goal achieved)?" This is planning over the belief tree.

## Teleological Evidence

The goal type is not a description of what exists — it is a description of what SHOULD exist. Every mount of a value is an attempt to make part of the goal true. The gap between current state and goal is the set of hypotheses that need evidence.

Lattice narrowing is not just type refinement. It is **making hypotheses true by accumulating evidence**. The scheduler selects actions (tool invocations) that are expected to produce evidence (output values) that narrow the gap (reduce the distance between current state and goal type).

This is "teleological evidence" — evidence pursued not because it's interesting but because it's needed to satisfy a goal. The goal type is the prior preference over outcomes. The planner minimizes expected free energy relative to that preference.

## Probabilistic Feasibility in Compose

When a function type carries all three:
1. `distribution('time', family, params)` — completion time distribution
2. `responsePolicy(timeout, confidence)` — required P(completion) threshold
3. Optional `temporal('lt', '_rt', deadline)` — hard time bound

Compose evaluates `cdf(family, availableTime, params)`. If P(completion ≤ deadline) < confidence, compose returns `never`. The branch is eliminated.

This is opt-in: absent any of the three, behavior is unchanged. This is not an ad-hoc runtime check — it is compose evaluating a richer conjunct on the type claim. The confidence/deadline are constraints in the type, and compose handles them the same way it handles `min(50)` vs `literal(10)`.

### Plan-Level Feasibility

For multi-step plans, `planFeasibility()` (compose.ts) computes the joint probability under an explicit dependency model:

- **independent**: Fenton-Wilkinson approximation (sum of lognormals)
- **worst_case_bound**: comonotonic (perfectly correlated, per-step budget = deadline/n)
- **shared_factor / copula**: require explicit parameters, fail to worst_case if absent

Guard conditions (non-negotiable):
1. Never infer plan-level from per-step probabilities multiplied together
2. Dependency model is required (missing → fail closed to worst_case_bound)
3. Weakly identified model → status = "uncertain"
4. Every decision emits a structured trace
5. Below threshold → hard reject

`planFeasibility` is a standalone evaluator, not part of compose. This is intentional: compose is the structural/deterministic verifier. Probabilistic plan evaluation is assumption-heavy (requires dependency model, calibration, evidence history) and should read those assumptions from mounted state, not from implicit pair-handler logic.

## On Distribution Composition in Pair Handlers

A natural question: should the `distribution` pair handler convolve same-property distributions (e.g., sum two time distributions when composing sequential tools)?

**Current answer: no.** Convolution requires an explicit dependency model (independent, shared_factor, etc.). Hardcoding a specific convolution rule in the pair handler would:
1. Embed hidden assumptions in core satisfiability
2. Risk double-counting when types are composed in different orders or reused
3. Conflate structural verification with probabilistic prediction

The right architecture: compose stays algebraic and assumption-light. Probabilistic evaluation is a separate step that reads the dependency model from mounted state. The Sequence orchestrates both.

**Future direction:** If the dependency model is itself a mounted type (not a string parameter), and composition rules are mounted tools (not hardcoded pair handlers), then distribution composition COULD become native to compose — but only when the composition rule is explicitly part of the type claim, not implicitly assumed.

## Credits and Resource Pricing

Under EFE minimization with resource constraints, the optimal prices for resources (tokens, latency, attention, data egress) are **Lagrange multipliers** — shadow prices that emerge from the optimization, not design choices.

Credits should only exist in the ontology if EFE cannot be reasonably computed without them performing normalization across dimensions. Specifically:
- If partitions can compute EFE locally from their own state + blanket observations → credits are redundant
- If partitions need cross-boundary price signals to make locally optimal decisions → credits are the multipliers

For a single-server system, credits are unnecessary. For multi-agent coordination where partitions must make independent decisions about shared resources, credits become the coordination mechanism.

## What This Means for Implementation

1. **Don't change compose.** It is already the Bayesian update operator. Keep it algebraic, assumption-light, and predictable.

2. **Don't build a separate planner module.** The planner is gap handler selection — a tool that maps the current gap set to an ordered handler chain. A better planner is a better mounted tool, not a different architecture.

3. **Don't hardcode planning math into the kernel.** Distribution composition, EFE computation, and policy optimization are all tools that can be mounted and replaced. The kernel provides the substrate (types, compose, priors, distributions, partitions) and the execution model (mount, cascade, invalidate). Planning happens ON the substrate, not IN it.

4. **Don't invent new concepts when existing primitives suffice.** "Confidence gate" is just a conjunct on the type claim. "Plan feasibility" is just compose over a richer type. "Crediting" is just Lagrange multipliers for resource constraints. The kernel's power is that these all reduce to the same operation (mount + compose) on the same data structure (Sequence).

5. **The next planner improvement is a mounted tool.** When observed data is sufficient to compute EFE meaningfully (posterior distributions from real usage, not just priors), mount a planner tool that scores branches by expected free energy instead of greedy first-match. The kernel doesn't change. The planner changes.

## Test Evidence

These theoretical properties are backed by passing tests:

- **Compose as Bayesian update**: `compose.test.ts` — 76 tests including probabilistic deadline feasibility
- **Probabilistic branch elimination**: `routing.test.ts` — 22 tests including time-aware branch fallthrough
- **Plan-level feasibility guards**: `plan-feasibility.test.ts` — 23 tests including multi-step ≠ per-step, dependency model enforcement, monotonicity
- **Partition reference rules**: `partition.test.ts` — 38 tests
- **Live tool selection via compose**: `tick.test.ts` — 20 tests including same-quota-different-latency key selection, decision traces in req partition

Total: 444 core + 33 contextgraph = 477 tests.
