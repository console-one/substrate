/**
 * specs-coverage.test.ts — cross-references the indexgeneration,
 * backlinks, and typeindexing requirement specs against the
 * primitives that already exist in the kernel (indexSpec + bindFrom +
 * label-rules + identity-scoped block log). Acceptance criteria that
 * the current primitives satisfy become passing tests. ACs that
 * genuinely need new code are `test.todo` with the exact R#
 * reference, so the gap list stays visible without pretending the
 * test is broken.
 *
 * Specs:
 *   - packages/core/specs/requirements/contextgraph/indexgeneration.md
 *   - packages/core/specs/requirements/contextgraph/backlinks.md
 *   - packages/core/specs/requirements/contextgraph/typeindexing.md
 */

import { Sequence, createType, indexSpec, bindFrom, eq } from '@console-one/sequence';

// ─── indexgeneration.md ─────────────────────────────────────────────

describe('indexgeneration — structural predicate + incremental index', () => {
  // Helper: register a predicate that matches subtrees with fields
  // {name, provider}. Index lives at `_indexes.models.*`.
  function registerModelsIndex(seq: Sequence): void {
    seq.mount('schema', '_indexes.models', createType('any', [
      indexSpec({
        indexedBy: ['subject'],
        where: [
          bindFrom('subject', 'catalog.*'),
          bindFrom('name', 'catalog.{subject}.name'),
          bindFrom('provider', 'catalog.{subject}.provider'),
        ],
        body: [
          { op: 'bind', path: '_indexes.models.{subject}', value: true },
        ],
      }),
    ]));
  }

  test('AC1 [R1,R2]: predicate matches subtrees with required fields; extras allowed', () => {
    const seq = new Sequence();
    // Three subtrees satisfy the predicate, one doesn't (missing provider).
    seq.mount('bind', 'catalog.gpt4.name', 'gpt4');
    seq.mount('bind', 'catalog.gpt4.provider', 'openai');
    seq.mount('bind', 'catalog.gpt4.maxTokens', 128000);        // extra field ok
    seq.mount('bind', 'catalog.claude.name', 'claude');
    seq.mount('bind', 'catalog.claude.provider', 'anthropic');
    seq.mount('bind', 'catalog.mistral.name', 'mistral');
    seq.mount('bind', 'catalog.mistral.provider', 'mistral');
    seq.mount('bind', 'catalog.orphan.name', 'orphan');         // missing provider

    registerModelsIndex(seq);

    const matches = seq.keys('_indexes.models').sort();
    expect(matches).toEqual(['claude', 'gpt4', 'mistral']);
  });

  // AC3 [R4] — SURFACED GAP: indexSpec bodies are additive, not
  // retractive. When a tuple stops satisfying the where clause, its
  // body mount persists. Writing this test as a hard assertion
  // exposed it; the trace-index demo's "cursor advanced" note
  // already flagged the same shape. Retraction is a separate
  // primitive the kernel doesn't have yet.
  test.todo('AC3 [R4]: removal on predicate break — requires indexSpec body retraction primitive');

  test('AC5 [R6]: predicate created against existing tree populates immediately', () => {
    const seq = new Sequence();
    // Tree exists first.
    for (let i = 0; i < 25; i++) {
      seq.mount('bind', `catalog.m${i}.name`, `n${i}`);
      seq.mount('bind', `catalog.m${i}.provider`, i % 2 === 0 ? 'openai' : 'anthropic');
    }
    // Predicate created after.
    registerModelsIndex(seq);
    expect(seq.keys('_indexes.models').length).toBe(25);
  });

  test('AC4 [R5]: subtype refinement filters parent index, not full tree', () => {
    // R5 says a subtype predicate's query *uses* the parent index. The
    // kernel provides this structurally: you layer a second indexSpec
    // whose where binds the parent index as the source glob. We prove
    // the composition works.
    const seq = new Sequence();
    registerModelsIndex(seq);

    seq.mount('bind', 'catalog.a.name', 'a'); seq.mount('bind', 'catalog.a.provider', 'openai');
    seq.mount('bind', 'catalog.b.name', 'b'); seq.mount('bind', 'catalog.b.provider', 'openai');
    seq.mount('bind', 'catalog.c.name', 'c'); seq.mount('bind', 'catalog.c.provider', 'anthropic');

    // Subtype: models whose provider == openai, but enumerated over
    // the parent index rather than catalog.*.
    seq.mount('schema', '_indexes.models_openai', createType('any', [
      indexSpec({
        indexedBy: ['subject'],
        where: [
          bindFrom('subject', '_indexes.models.*'),
          eq('catalog.{subject}.provider', 'openai'),
        ],
        body: [
          { op: 'bind', path: '_indexes.models_openai.{subject}', value: true },
        ],
      }),
    ]));

    expect(seq.keys('_indexes.models_openai').sort()).toEqual(['a', 'b']);
  });

  // AC2 [R3] — incremental re-evaluation scoped to overlapping fields.
  // The kernel's backward index already does this (deps are keyed on
  // referenced paths; an unrelated mutation fires zero dependent
  // bodies). Proving it directly would require instrumenting the
  // evaluator to count re-evaluations — doable but orthogonal to the
  // spec's user-visible behavior. Omit here; covered by chat-
  // convergence timing (10 concurrent mounts, 1.3s) which would be
  // orders of magnitude slower without incremental maintenance.

  // AC6 [R7] — utilization tracking. GENUINE GAP: no query counter
  // anywhere on proj.values[_indexes.*] accesses.
  test.todo('AC6 [R7]: utilization tracking — requires new code (per-index read counter)');

  // AC7 [R8] — deactivation + reactivation with retained data.
  // GENUINE GAP: indexSpec has no deactivation flag; deleting the
  // schema would drop index state.
  test.todo('AC7 [R8]: predicate deactivation — requires new code (deactivation flag + catch-up)');
});


// ─── backlinks.md ───────────────────────────────────────────────────

// backlinks — RETIRED at deletion-ledger stage 4: the inverted label
// index was v1 block-label machinery (registerLabelRules, sequenceutils/
// policies). v2 carries labels as ordinary cells (label groups resolve
// via electLabel; references are facts) — there is no block-label op to
// index. The requirement's product need (find what references a
// concept) is served by the cell graph's ref axis + declared concerns.

describe('typeindexing — reverse index over type catalog', () => {
  test('AC1 [R1,R2]: a mounted tool\'s input type is retrievable and serializable', () => {
    const seq = new Sequence();
    const queryInput = createType('object', []); // shape irrelevant for the AC
    seq.mount('schema', 'tools.searchTool.input', queryInput);

    const retrieved = seq.typeAt('tools.searchTool.input');
    expect(retrieved).toBeTruthy();
    // Types are pure data; JSON round-trip is the serialization test.
    const roundTripped = JSON.parse(JSON.stringify(retrieved));
    expect(roundTripped).toEqual(retrieved);
  });

  test('AC2 [R3,R4]: reverse index maintained automatically via indexSpec', () => {
    // The reverse index "type T → tools that accept T" can be built
    // by naming the input-type by a declared tag, then indexing all
    // tools by that tag. This proves the mechanism; a richer
    // structural match (R5) is the genuine gap.
    const seq = new Sequence();
    seq.mount('bind', 'tools.searchTool.inputTypeName', 'QueryInput');
    seq.mount('bind', 'tools.filterTool.inputTypeName', 'QueryInput');
    seq.mount('bind', 'tools.rankTool.inputTypeName', 'ResultList');

    seq.mount('schema', '_indexes.typeToTools', createType('any', [
      indexSpec({
        indexedBy: ['tool', 'typeName'],
        where: [
          bindFrom('tool', 'tools.*'),
          bindFrom('typeName', 'tools.{tool}.inputTypeName'),
        ],
        body: [
          { op: 'bind', path: '_indexes.typeToTools.{typeName}.{tool}', value: true },
        ],
      }),
    ]));

    expect(seq.keys('_indexes.typeToTools.QueryInput').sort()).toEqual(['filterTool', 'searchTool']);
    expect(seq.keys('_indexes.typeToTools.ResultList')).toEqual(['rankTool']);
    // R4 removal half blocked by same additive-body issue — see
    // indexgeneration AC3 todo above. Forward maintenance works; the
    // reverse direction is a single primitive (retraction) shared
    // across all indexSpec specs.
  });

  test('AC4 [R6]: types scoped to their defining partition by default', () => {
    // Path prefix IS the partition for visibility. A type defined at
    // `partA.Config` isn't returned by `typeAt('partB.Config')`. This
    // is the structural guarantee the spec asks for at the default
    // level; explicit cross-partition hoisting (R7/AC5) is genuine
    // gap below.
    const seq = new Sequence();
    seq.mount('schema', 'partA.Config', createType('object', []));
    expect(seq.typeAt('partA.Config')).toBeTruthy();
    expect(seq.typeAt('partB.Config')).toBeUndefined();
  });

  // AC3 [R5] — structural subtype match in reverse index. A query for
  // subtype returns tools that accept supertype. GENUINE GAP: indexSpec
  // matches exact type-name tag here. A kernel-level structural match
  // (`covers(cand, req)`) exists but isn't plumbed into a reverse
  // index yet.
  test.todo('AC3 [R5]: subtype reverse-index match via covers() — requires new code');

  // AC5 [R7] — explicit type hoisting from sub-partition to parent.
  // GENUINE GAP: no "hoist this type upward" operation. Would need
  // either a ref-alias pattern or a hoisting constraint op.
  test.todo('AC5 [R7]: explicit type hoisting (partition export) — requires new code');

  // AC6 [R8] — compression of type for prompt context.
  // GENUINE GAP: no structural-signature compressor. compose.ts has
  // concreteness metrics but no field-names-and-types-only serializer.
  test.todo('AC6 [R8]: type compression for prompts — requires new code');
});
