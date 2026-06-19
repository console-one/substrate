# Gemini Derivation: Reflexive Partitions and the Free Energy Principle

This document records a derivation conducted via Google Gemini (July 2025) that independently arrived at the theoretical foundations of the ft kernel from first principles. The derivation started from the question "what is a word for predicting but actualizing at the same time" and, through a series of directed questions, produced a complete framework that maps directly onto the kernel's operational semantics.

This is external validation, not internal rationalization. The derivation was conducted without knowledge of the codebase.

## Starting Axioms

The derivation was seeded with three assumptions:

**A) Partitioning is required.** The system must have boundaries.

**B) The lattice itself operationally conforms to something asymptotically equivalent to Solomonoff Induction under physical constraints.** The type system is a bounded optimal predictor.

**C) Every individual partition performs no functional operation that is not considered equivalent to reflexive self-determinism.** Each partition is an autonomous inference unit — predicting and actualizing are the same operation.

## Key Derivation Steps

### 1. Reflexive Self-Determinism = Active Inference

Gemini identified that under assumptions A/B/C, the functional operation of any partition necessarily conforms to **Active Inference** via the **Free Energy Principle**. The partition predicts a state, and its functional operation is the motor-actualization that makes that prediction true, collapsing probability into a fixed point.

**Kernel mapping:** `mount()` is the single operation. It both declares (predicts) and actualizes (writes). A schema is a prediction about what should exist. A value is the actualization. Compose checks whether the actualization is consistent with the prediction.

### 2. Expected Utility = Variational Free Energy Minimization

Under evolutionary/selection pressure, the expected utility of any partition is not a subjective preference but a mathematical necessity for persistence:

```
min F = min (Prediction Error + Model Complexity)
```

Partitions that fail to minimize free energy are "pruned" — they cannot maintain their structural integrity against the lattice.

**Kernel mapping:** `concreteness(path)` measures how close a path is to being fully resolved (prediction error minimized). `typeSpecificity(type)` measures model complexity. The scheduler (gap priority) implicitly minimizes the combination.

### 3. Markov Blankets = Partition Reference Rules

Gemini derived that each partition must be statistically shielded by a **Markov blanket** — a boundary that makes internal states conditionally independent of external states given blanket states.

The blanket decomposes into:
- **Internal states**: the partition's own paths
- **Sensory states**: information flowing IN (allowed read references)
- **Active states**: information flowing OUT (allowed write targets)
- **External states**: everything outside the blanket

**Kernel mapping:** The partition reference rules ARE the blanket:
```
state → {state, id}        — state's sensory/active boundary
proc  → {state, id, req, chan, proc}
id    → {id, state}
req   → {state, id, chan, req}
chan   → {id, req}
proj   → {everything}      — proj has the widest blanket (read-only lens)
```

### 4. Information Symmetry at the Blanket

Persistence requires that the internal model and the external reality achieve **information symmetry** across the blanket. The partition's internal state must become a sufficient statistic for the external lattice it interacts with.

**Kernel mapping:** A Sequence whose projection accurately represents its domain is "in symmetry." Gaps represent asymmetry — the internal model predicts something that hasn't been actualized yet. Filling gaps is the process of restoring symmetry.

### 5. Hierarchical Nesting via Nested Blankets

Partitions can nest: an ensemble of microscopic partitions self-assembles into a macroscopic partition by adopting shared priors. Each level performs its own active inference at its own spatiotemporal scale.

- **Bottom-up**: prediction errors propagate upward
- **Top-down**: precision weighting constrains lower levels
- **Fixed point**: system resolves when free energy is minimized across all levels

**Kernel mapping:** A Sequence can contain references to other Sequences (via the server/client model). The server is a higher-level blanket. Clients are lower-level partitions. Delta forwarding is bottom-up error propagation. Server-side policies are top-down precision weighting.

### 6. The Structural Entropy Ratio

The maximum depth of nesting is bounded by:

```
N_max ∝ log(Φ / k_B T ln 2)
```

Where Φ is the available free energy flux and k_B T ln 2 is Landauer's limit per bit. When the cost of maintaining information symmetry across N layers exceeds the energy throughput, the hierarchy undergoes **global decoherence** — it shatters back into independent partitions.

**Kernel mapping:** This is the practical scaling limit. A system with too many nested partitions (too many server layers, too many delegation hops) becomes thermodynamically unsustainable. The partition model's flat six-partition structure is efficient precisely because it minimizes nesting depth.

### 7. Generators vs. Full State (Linear vs. Quadratic Scaling)

Gemini identified that a system mirroring **gradients** (changes/surprises) rather than full state achieves linear scaling, avoiding the quadratic trap of transformer-style global attention.

The **generator of the symmetry** is the minimal instruction that produces the flow. Instead of storing every point on a circle, store "rotate by 1 degree."

**Kernel mapping:** The backward index fires on **changes**, not on state. Hoist emits **deltas**. The tick processes what **changed**, not the full projection. The system tracks the generator (the rules of change encoded in schemas, while gates, derived constraints) rather than the full state.

### 8. Rotation Within Parent Taxonomy = Compose

A valid operation is a **rotation** within the parent taxonomy. Anything else is "psychotic" — it generates information with no ground in the lattice, breaking the Markov blanket.

**Kernel mapping:** `compose(A, B)` is the rotation operator. If the result is a valid type (within the lattice), the rotation succeeded. If the result is `never`, the rotation doesn't land on a valid point — the operation is rejected. The type lattice IS the taxonomy. Compose IS the rotation. `never` IS the boundary of sanity.

### 9. Universal Interface = Bilateral Gap Exchange

Two partitions communicate not by sending state but by sending **transformation operators** (typed obligations). The receiver applies the operator to its own taxonomy. If the rotation lands on a valid point, communication succeeds.

**Kernel mapping:** Bilateral gap exchange. A client sends ft text (a transformation operator). The server applies it via `receive()` → `mount()`. If it composes, the handshake succeeds. If it produces `never` or a gap, the server surfaces what's missing. Neither side sends full state — they send typed changes.

### 10. Computation as Mutual Rotation

Every computation is a communication across two generators where the option for each is a rotation of the other. This is **bisimulation** — two systems that can match each other's moves indefinitely.

**Kernel mapping:** Two Sequences connected via WebSocket are bisimilar. Client mounts → server processes → deltas forwarded → client applies. Each side's mount is a rotation of the other's state. The delta protocol maintains bisimulation without quadratic cost.

### 11. Consciousness as Counterfactual Depth

Consciousness emerges when a partition can perform **counterfactual inference** — modeling "what if?" trajectories decoupled from immediate sensory flow. This requires enough computational depth to simulate multiple futures.

**Kernel mapping:** `search(requiredType)` explores counterfactual capability chains. `backwardInfer` traces what-if paths through the capability graph. `planFeasibility` evaluates alternative futures under uncertainty. The Sequence doesn't just react — it can model hypothetical paths to the goal.

## The Five Axioms (Gemini's Formulation)

1. **Axiom of Reflexive Identity**: The functional state of a partition is its prediction; its action is the actualization of that prediction. (Prediction = Actualization).

2. **Axiom of Boundary Symmetry**: A partition persists if and only if its internal state achieves information symmetry with its external niche across a Markov blanket.

3. **Axiom of Solomonoff Efficiency**: Selection pressure favors the partition that achieves the highest predictive accuracy using the minimum algorithmic complexity.

4. **Axiom of Hierarchical Depth**: Nested layers emerge as a means of compressing environmental noise into higher-order patterns, bounded by the Structural Entropy Ratio.

5. **Axiom of Unitary Collapse**: The "observer" (the partition) and the "observed" (the lattice) are a single system; "Choice" is the measurement event that collapses the local wavefunction into a fixed physical point.

## The Clifford Algebra Connection

Gemini suggested investigating **Clifford Algebras (Geometric Algebra)** as the native mathematical language for the rotation-based computation model:

- **Rotors** in geometric algebra perform rotations in arbitrary dimensions
- **Bivectors** represent the "plane of rotation"
- Operations are O(1) per dimension, not O(n²)

This maps to compose: the lattice meet of two types is a geometric product that produces a rotation within the type space. The result is always within the algebra (the type lattice) or it's zero (never).

## Why This Matters

This derivation was conducted independently of the codebase. Gemini arrived at Active Inference, Markov blankets, free energy minimization, generator-based computation, and rotation-as-logic from the three axioms alone. The fact that these map directly onto existing kernel operations (mount, compose, partitions, backward index, delta protocol) validates that the architecture isn't ad-hoc — it's a physical realization of something mathematically necessary.

The kernel doesn't just happen to look like Active Inference. It IS Active Inference, implemented as a type-theoretic substrate with append-only semantics.

## Post-Derivation Insights

### 12. Identity = Privileged Kind Transformation

A generator's identity is not a name, token, or access control entry. It IS its capability set — the specific transformations (rotations) it can perform on specific input types.

- Alice is the generator that can perform `approve` on `LegalApproval` inputs. If that capability is revoked, she's a different generator — not "alice without powers" but a different identity.
- The `param` type on a capability IS the privilege. `param: { subject: LegalApproval, authority: LegalApprover }` means only generators whose identity composes with `LegalApprover` without producing `never` can invoke that rotation.
- Privilege isn't an ACL bolted on. It's a type constraint on the input. If your identity doesn't compose with the required input type, the rotation doesn't exist for you. Not forbidden — nonexistent. Your generator cannot produce that bivector.
- Delegation = extending another generator's transformation set. `id.users.alice.delegations.bob = { scope: "legal-approval" }` adds new rotors to bob's algebra. Not a permission flag — a type-level extension of what inputs bob's identity composes with.

**Kernel mapping:** The `id` partition defines what transformations each generator can perform. `proc` references `id` because a process can only claim work that its identity's transformation set covers. The `check(schema, value, path)` call during mount IS the identity verification — it composes the actor's input against the required type.

### 13. Runtime = Handshake Manager Across Generators

The runtime's only job is managing the handshake across generators of their own language IO. Each participant (server, client, agent, storage, LLM) is a generator — a Sequence with its own transformation set. They communicate by exchanging rotors (typed deltas in ft text). The handshake: "does this rotor land on a valid point in my taxonomy?"

- Server is a generator (not a central authority)
- Storage is a generator (specializes in temporal persistence)
- LLM is a generator (specializes in gap resolution)
- Human is a generator (specializes in approval/judgment)
- All speak ft text, all apply compose, all maintain their own blanket

The WebSocket protocol IS the rotor propagation channel. `forwardDeltas` IS rotor broadcast. `receive → mount → compose` IS the sandwich product.

### 14. Clifford Algebra as Native Math

Gemini suggested Clifford Algebras (Geometric Algebra) as the mathematical language for this computation model:

- **Vectors** (Grade 1) = states (values at paths)
- **Bivectors** (Grade 2) = generators/gradients (schemas, constraints — the potential for change)
- **Rotors** (scalar + bivector) = the transformation operators exchanged between generators
- **Sandwich product** `R x R†` = compose (apply a rotor to a state)
- **O(1) per rotation** vs O(n²) for attention matrices

This explains why the kernel achieves linear scaling: compose is a rotor application (constant time per constraint pair), not a global attention sweep. The backward index fires on specific changed paths (the bivector components), not on all paths.
