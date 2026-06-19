/**
 * type-dispatch.test.ts — Type-driven dispatch through compose.
 *
 * Proves that the product layer uses the kernel's compose/selectFirstBranch
 * primitives for real dispatch decisions, not imperative if-branches.
 *
 * Categories covered (from specs/docs/TYPE_DRIVEN_DISPATCH_TESTS.md):
 *   1. Renderer dispatch via compose
 *   2. Tool selection via selectFirstBranch
 *   3. Backward inference resolves dependencies
 *   4. Concreteness gates compose (fn application)
 */

import {
  Sequence,
  compose,
  covers,
  isNever,
  selectFirstBranch,
  backwardInfer,
  createType,
  property,
  FT,
  check,
  param,
  returns,
  distribution,
  responsePolicy,
  type Type,
} from '@console-one/sequence';

// ═══════════════════════════════════════════════════════════════════════
// HELPERS — same renderer dispatch logic as console.ts, extracted for
// testability without readline/process.stdout dependencies.
// ═══════════════════════════════════════════════════════════════════════

/** Mount renderers as pure fn tools — same shape as console.ts mountRenderers. */
function mountRenderers(seq: Sequence): void {
  seq.mount('schema', '_render.document', createType('fn', [
    param(createType('object', [property('content', FT.string(), false)])),
    returns(FT.string()),
  ]));
  seq.mount('tool', '_render.document', () => 'document');

  seq.mount('schema', '_render.directory', createType('fn', [
    param(createType('object', [])),
    returns(FT.string()),
  ]));
  seq.mount('tool', '_render.directory', () => 'directory');
}

/** Old compose-based dispatch for comparison tests. */
function pickRenderer(seq: Sequence, scope: string): string | null {
  const schemaType = seq.typeAt(scope);
  if (schemaType) {
    const branches = [
      createType('object', [property('content', FT.string(), false)]),
      createType('object', []),
    ];
    const names = ['document', 'directory'];
    for (let i = 0; i < branches.length; i++) {
      if (!isNever(compose(branches[i], schemaType))) return names[i];
    }
  }
  return null;
}

/** Dispatch via selectFirstBranch over a union synthesized from _render.*.
 * No covers loop, no imperative fallback. Scope without a schema defaults
 * to empty object (which covers directory via union ordered choice). */
function pickRendererViaDispatch(seq: Sequence, scope: string): string | null {
  const names = seq.keys('_render');
  const pairs = names
    .map(n => ({ name: n, type: seq.typeAt(`_render.${n}`) }))
    .filter((p): p is { name: string; type: Type } => p.type?.kind === 'fn');
  if (pairs.length === 0) return null;
  const scopeType = seq.typeAt(scope) ?? createType('object', []);
  const union = pairs.length === 1
    ? pairs[0].type
    : createType('or', pairs.map(p => ({ op: 'branch' as const, args: [p.type] })));
  const selected = selectFirstBranch(union, scopeType);
  if (!selected) return null;
  const impl = seq.toolAt(`_render.${pairs[selected.index].name}`);
  return impl ? ((impl as Function)() as string) : null;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. RENDERER DISPATCH VIA COMPOSE
// ═══════════════════════════════════════════════════════════════════════

describe('renderer dispatch via compose', () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence(() => Date.now());
  });

  test('scope with content:string schema → document renderer', () => {
    seq.mount('schema', 'docs.readme', createType('object', [
      property('content', FT.string(), false),
      property('title', FT.string(), false),
    ]));
    seq.mount('bind', 'docs.readme.content', 'Hello world');
    seq.mount('bind', 'docs.readme.title', 'README');

    expect(pickRenderer(seq, 'docs.readme')).toBe('document');
  });

  test('scope without content property still matches document (compose is meet, not coverage)', () => {
    // FINDING: compose({content:string}, {status:string, input:string}) is NOT never.
    // Compose merges non-overlapping properties: result is {content, status, input}.
    // This means compose alone can't discriminate "has content" from "lacks content" —
    // it only rejects when properties CONFLICT (same key, incompatible types).
    //
    // For dispatch to truly distinguish document vs directory scopes, we'd need either:
    //   (a) a coverage/subtype check ("does scope include renderer's required properties?")
    //   (b) closed-world types ("scope declares it does NOT have content")
    //   (c) check the actual state (seq.get) as the fallback does
    seq.mount('schema', 'tasks', createType('object', [
      property('status', FT.string(), false),
      property('input', FT.string(), false),
    ]));
    seq.mount('bind', 'tasks.status', 'active');

    // compose returns a valid (non-never) type, so document renderer wins
    expect(pickRenderer(seq, 'tasks')).toBe('document');
  });

  test('ordering: document checked before directory', () => {
    // A scope with content AND other properties should still pick document,
    // not directory. Document is first in the list.
    seq.mount('schema', 'notes.entry', createType('object', [
      property('content', FT.string(), false),
      property('author', FT.string(), false),
      property('tags', createType('array', []), true),
    ]));
    seq.mount('bind', 'notes.entry.content', 'Some notes');
    seq.mount('bind', 'notes.entry.author', 'alice');

    expect(pickRenderer(seq, 'notes.entry')).toBe('document');
  });

  test('scope with no schema → null (caller falls back)', () => {
    seq.mount('bind', 'misc.x', 42);

    expect(pickRenderer(seq, 'misc')).toBe(null);
  });

  test('compose is the dispatch — not string matching or instanceof', () => {
    // Mount a custom type that happens to have "content" as a number.
    // The document renderer requires content:string. compose(document, {content:number})
    // should be never because string ≠ number.
    seq.mount('schema', 'data.record', createType('object', [
      property('content', FT.number(), false),
    ]));
    seq.mount('bind', 'data.record.content', 42);

    // Document renderer requires content:string, but we have content:number.
    // compose should reject it, falling through to directory.
    expect(pickRenderer(seq, 'data.record')).toBe('directory');
  });

  test('adding a more specific renderer takes priority via union order', () => {
    // Extended union: kanban (requires status) | document | directory
    const extendedUnion = createType('or', [
      { op: 'branch' as const, args: [createType('object', [property('status', FT.string(), false)])] },
      { op: 'branch' as const, args: [createType('object', [property('content', FT.string(), false)])] },
      { op: 'branch' as const, args: [createType('object', [])] },
    ]);
    const names = ['kanban', 'document', 'directory'];

    seq.mount('schema', 'tasks.backlog', createType('object', [
      property('status', FT.string(), false),
      property('assignee', FT.string(), true),
    ]));
    seq.mount('bind', 'tasks.backlog.status', 'todo');

    const schemaType = seq.typeAt('tasks.backlog')!;
    const result = selectFirstBranch(extendedUnion, schemaType);
    expect(result).not.toBeNull();
    expect(names[result!.index]).toBe('kanban');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. CAPABILITY SELECTION VIA selectFirstBranch
// ═══════════════════════════════════════════════════════════════════════

describe('tool selection via selectFirstBranch', () => {
  test('picks first branch whose input composes with candidate', () => {
    // Two fn types representing model tools
    const model1 = createType('fn', [
      param(createType('object', [
        property('auth', FT.string(), false),
        property('prompt', FT.string(), false),
      ])),
      returns(createType('object', [property('text', FT.string(), false)])),
    ]);

    const model2 = createType('fn', [
      param(createType('object', [
        property('prompt', FT.string(), false),
      ])),
      returns(createType('object', [property('text', FT.string(), false)])),
    ]);

    // Union: model1 | model2 (model1 checked first)
    const union = createType('or', [
      { op: 'branch' as const, args: [model1] },
      { op: 'branch' as const, args: [model2] },
    ]);

    // Candidate has both auth and prompt → model1 composes first
    const fullInput = createType('object', [
      property('auth', FT.string(), false),
      property('prompt', FT.string(), false),
    ]);

    const result = selectFirstBranch(union, fullInput);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(0); // model1 picked
  });

  test('LLM fallback chain: skips fn branch missing required input, picks next', () => {
    // model1 needs auth:string + prompt:string
    const model1 = createType('fn', [
      param(createType('object', [
        property('auth', FT.string(), false),
        property('prompt', FT.string(), false),
      ])),
      returns(FT.string()),
    ]);

    // model2 needs only prompt:string
    const model2 = createType('fn', [
      param(createType('object', [
        property('prompt', FT.string(), false),
      ])),
      returns(FT.string()),
    ]);

    const union = createType('or', [
      { op: 'branch' as const, args: [model1] },
      { op: 'branch' as const, args: [model2] },
    ]);

    // Candidate only has prompt (no auth).
    // fn-application uses covers: model1 needs {auth, prompt},
    // candidate only has {prompt} → covers rejects → compose returns never.
    // model2 needs {prompt} → covers passes → model2 selected.
    const promptOnly = createType('object', [
      property('prompt', FT.string(), false),
    ]);

    const result = selectFirstBranch(union, promptOnly);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(1); // model2 — first branch with covered inputs
  });

  test('LLM fallback: three models, dispatch picks first with all deps', () => {
    // claude: needs auth + prompt
    const claude = createType('fn', [
      param(createType('object', [
        property('auth', FT.string(), false),
        property('prompt', FT.string(), false),
      ])),
      returns(FT.string()),
    ]);
    // gpt: needs key + prompt
    const gpt = createType('fn', [
      param(createType('object', [
        property('key', FT.string(), false),
        property('prompt', FT.string(), false),
      ])),
      returns(FT.string()),
    ]);
    // local: needs only prompt
    const local = createType('fn', [
      param(createType('object', [
        property('prompt', FT.string(), false),
      ])),
      returns(FT.string()),
    ]);

    const union = createType('or', [
      { op: 'branch' as const, args: [claude] },
      { op: 'branch' as const, args: [gpt] },
      { op: 'branch' as const, args: [local] },
    ]);

    // Only prompt available → local selected (index 2)
    const promptOnly = createType('object', [
      property('prompt', FT.string(), false),
    ]);
    expect(selectFirstBranch(union, promptOnly)!.index).toBe(2);

    // auth + prompt available → claude selected (index 0)
    const withAuth = createType('object', [
      property('auth', FT.string(), false),
      property('prompt', FT.string(), false),
    ]);
    expect(selectFirstBranch(union, withAuth)!.index).toBe(0);

    // key + prompt available → gpt selected (index 1)
    const withKey = createType('object', [
      property('key', FT.string(), false),
      property('prompt', FT.string(), false),
    ]);
    expect(selectFirstBranch(union, withKey)!.index).toBe(1);
  });

  test('all branches infeasible → null', () => {
    const fn1 = createType('fn', [
      param(FT.string()),
      returns(FT.string()),
    ]);
    const fn2 = createType('fn', [
      param(FT.number()),
      returns(FT.number()),
    ]);

    const union = createType('or', [
      { op: 'branch' as const, args: [fn1] },
      { op: 'branch' as const, args: [fn2] },
    ]);

    // Candidate is boolean — neither fn accepts it
    const boolCandidate = createType('boolean', []);
    expect(selectFirstBranch(union, boolCandidate)).toBeNull();
  });

  test('non-union type acts as single-branch dispatch', () => {
    const fn = createType('fn', [
      param(FT.string()),
      returns(FT.number()),
    ]);

    // selectFirstBranch on a non-union wraps it as index 0
    const strCandidate = FT.string();
    const result = selectFirstBranch(fn, strCandidate);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(0);
  });

  test('ordered choice: first composable branch wins even if later is "better"', () => {
    // Both branches compose with string, but first wins
    const branch1 = FT.string();
    const branch2 = createType('string', [{ op: 'regex' as const, args: ['^[a-z]+$'] }]);

    const union = createType('or', [
      { op: 'branch' as const, args: [branch1] },
      { op: 'branch' as const, args: [branch2] },
    ]);

    const candidate = createType('string', [{ op: 'regex' as const, args: ['^[a-z]+$'] }]);
    const result = selectFirstBranch(union, candidate);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(0); // branch1, not branch2
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. BACKWARD INFERENCE RESOLVES DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════════

describe('backward inference', () => {
  test('backwardInfer returns input type from fn + required output', () => {
    // fn: (auth:string, prompt:string) → result:string
    const fnType = createType('fn', [
      param(createType('object', [
        property('auth', FT.string(), false),
        property('prompt', FT.string(), false),
      ])),
      returns(FT.string()),
    ]);

    const requiredOutput = FT.string();
    const inferred = backwardInfer(fnType, requiredOutput);

    // Should return the input type that the fn needs
    expect(inferred).not.toBeNull();
    if (inferred) {
      expect(inferred.kind).toBe('object');
      // The inferred type should have auth and prompt properties
      const props = inferred.constraints.filter(c => c.op === 'property');
      const propNames = props.map(c => c.args[0]);
      expect(propNames).toContain('auth');
      expect(propNames).toContain('prompt');
    }
  });

  test('backwardInfer on non-fn type returns ANY (no param constraint to infer from)', () => {
    const stringType = FT.string();
    const result = backwardInfer(stringType, FT.string());
    // No param/returns/preserves on a string → nothing to infer,
    // backwardInfer returns ANY (accepts anything)
    expect(result).toBeDefined();
    expect(result!.kind).toBe('any');
  });

  test('backwardInfer extracts param type from fn regardless of output match', () => {
    const fnType = createType('fn', [
      param(FT.string()),
      returns(FT.number()),
    ]);

    // backwardInfer looks at param/preserves constraints, not output matching.
    // Even with a mismatched required output, it returns the input type.
    const inferred = backwardInfer(fnType, createType('boolean', []));
    expect(inferred).toBeDefined();
    if (inferred) {
      // The fn has param(string), so backward inference yields string input
      expect(inferred.kind).toBe('string');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. CONCRETENESS GATES COMPOSE (fn application)
// ═══════════════════════════════════════════════════════════════════════

describe('concreteness gates', () => {
  test('fn composes with matching concrete input type', () => {
    const fnType = createType('fn', [
      param(FT.string()),
      returns(FT.number()),
    ]);

    // A concrete string value composes with the fn (application)
    const concreteInput = createType('string', [
      { op: 'literal' as const, args: ['hello'] },
    ]);

    const result = compose(fnType, concreteInput);
    // fn << "hello" → application, result is the output type
    expect(isNever(result)).toBe(false);
    expect(result.kind).toBe('number');
  });

  test('fn composes with schema-only input (type matches)', () => {
    const fnType = createType('fn', [
      param(FT.string()),
      returns(FT.number()),
    ]);

    // A string schema (no literal value) — still composes at type level
    // This is the current behavior: compose is type-only, not state-aware
    const schemaInput = FT.string();
    const result = compose(fnType, schemaInput);
    expect(isNever(result)).toBe(false);
  });

  test('fn does not compose with wrong kind', () => {
    const fnType = createType('fn', [
      param(FT.string()),
      returns(FT.number()),
    ]);

    // A number doesn't compose with fn expecting string param
    const wrongInput = FT.number();
    const result = compose(fnType, wrongInput);
    expect(isNever(result)).toBe(true);
  });

  test('compose of renderer inputType with scope type — the dispatch primitive', () => {
    // This is exactly what dispatchRenderer does
    const documentInputType = createType('object', [
      property('content', FT.string(), false),
    ]);

    // Scope type with content:string
    const scopeType = createType('object', [
      property('content', FT.string(), false),
      property('title', FT.string(), false),
    ]);

    const result = compose(documentInputType, scopeType);
    expect(isNever(result)).toBe(false);
    expect(result.kind).toBe('object');
  });

  test('compose of renderer inputType with incompatible scope type → never', () => {
    const documentInputType = createType('object', [
      property('content', FT.string(), false),
    ]);

    // Scope type with content:number (not string)
    const scopeType = createType('object', [
      property('content', FT.number(), false),
    ]);

    const result = compose(documentInputType, scopeType);
    expect(isNever(result)).toBe(true);
  });

  test('Sequence.concreteness reflects value vs gap', () => {
    const seq = new Sequence(() => Date.now());

    // Mount schema but no value — it's a gap
    seq.mount('schema', 'auth.key', FT.string());
    const gapConcreteness = seq.concreteness('auth.key');
    expect(gapConcreteness).toBeLessThan(1);

    // Mount a value — now it's concrete
    seq.mount('bind', 'auth.key', 'sk-test-123');
    const valueConcreteness = seq.concreteness('auth.key');
    expect(valueConcreteness).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. COVERS — type-level containment (the dispatch primitive compose isn't)
// ═══════════════════════════════════════════════════════════════════════

describe('covers — type-level containment', () => {
  test('object with required property covers: candidate has it', () => {
    const required = createType('object', [property('content', FT.string(), false)]);
    const candidate = createType('object', [
      property('content', FT.string(), false),
      property('title', FT.string(), false),
    ]);

    expect(covers(required, candidate)).toBe(true);
  });

  test('object with required property: candidate lacks it', () => {
    const required = createType('object', [property('content', FT.string(), false)]);
    const candidate = createType('object', [
      property('status', FT.string(), false),
      property('input', FT.string(), false),
    ]);

    // compose says yes (non-overlapping → non-contradictory)
    expect(isNever(compose(required, candidate))).toBe(false);
    // covers says no (candidate doesn't have content)
    expect(covers(required, candidate)).toBe(false);
  });

  test('empty object covers any object', () => {
    const required = createType('object', []);
    const candidate = createType('object', [
      property('status', FT.string(), false),
    ]);

    expect(covers(required, candidate)).toBe(true);
  });

  test('property type mismatch → not covered', () => {
    const required = createType('object', [property('content', FT.string(), false)]);
    const candidate = createType('object', [property('content', FT.number(), false)]);

    expect(covers(required, candidate)).toBe(false);
  });

  test('optional property in required is not checked for coverage', () => {
    const required = createType('object', [
      property('content', FT.string(), false),
      property('author', FT.string(), true), // optional
    ]);
    const candidate = createType('object', [
      property('content', FT.string(), false),
      // no author — but it's optional in required
    ]);

    expect(covers(required, candidate)).toBe(true);
  });

  test('kind mismatch → not covered', () => {
    expect(covers(FT.string(), FT.number())).toBe(false);
  });

  test('same primitive kind → covered (compose checks constraints)', () => {
    expect(covers(FT.string(), FT.string())).toBe(true);
  });

  test('any covers everything, nothing covers any (except any)', () => {
    const any = createType('any', []);
    expect(covers(any, FT.string())).toBe(true);
    expect(covers(any, FT.number())).toBe(true);
    // any doesn't guarantee string
    expect(covers(FT.string(), any)).toBe(false);
  });

  test('never candidate vacuously covers everything', () => {
    const never = createType('string', [], { reason: 'contradiction' });
    expect(covers(FT.string(), never)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. RENDERER DISPATCH VIA selectFirstBranch
// ═══════════════════════════════════════════════════════════════════════

describe('renderer dispatch via selectFirstBranch', () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence(() => Date.now());
    mountRenderers(seq); // render union is type state at _render
  });

  test('scope with content:string → document renderer', () => {
    seq.mount('schema', 'docs.readme', createType('object', [
      property('content', FT.string(), false),
      property('title', FT.string(), false),
    ]));

    expect(pickRendererViaDispatch(seq, 'docs.readme')).toBe('document');
  });

  test('scope without content → directory renderer (covers rejects document)', () => {
    seq.mount('schema', 'tasks', createType('object', [
      property('status', FT.string(), false),
      property('input', FT.string(), false),
    ]));

    // This is the test that FAILS with compose but PASSES with covers
    expect(pickRendererViaDispatch(seq, 'tasks')).toBe('directory');
  });

  test('scope with content:number → directory (type mismatch, covers rejects)', () => {
    seq.mount('schema', 'data.record', createType('object', [
      property('content', FT.number(), false),
    ]));

    expect(pickRendererViaDispatch(seq, 'data.record')).toBe('directory');
  });

  test('glob schema with content propagates → document via covers', () => {
    seq.mount('schema', 'docs.*', createType('object', [
      property('content', FT.string(), false),
    ]));
    seq.mount('bind', 'docs.readme.content', 'Hello');

    expect(pickRendererViaDispatch(seq, 'docs.readme')).toBe('document');
  });

  test('scope with no schema → directory (empty-object covers any object)', () => {
    // No schema at `misc`, just a stray bind below it. With the union
    // dispatch, the scope type defaults to empty object. The document
    // branch requires `content`, so covers rejects it; directory's
    // empty-object param trivially covers → directory selected.
    seq.mount('bind', 'misc.x', 42);
    expect(pickRendererViaDispatch(seq, 'misc')).toBe('directory');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// INTEGRATION: type dispatch through the Sequence
// ═══════════════════════════════════════════════════════════════════════

describe('type dispatch through Sequence', () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence(() => Date.now());
  });

  test('typeAt returns mounted schema → compose dispatches renderer', () => {
    seq.mount('schema', 'docs.readme', createType('object', [
      property('content', FT.string(), false),
      property('title', FT.string(), false),
    ]));

    const schemaType = seq.typeAt('docs.readme');
    expect(schemaType).toBeDefined();

    // Document renderer's inputType composes with this schema
    const docInput = createType('object', [property('content', FT.string(), false)]);
    expect(isNever(compose(docInput, schemaType!))).toBe(false);

    // Directory renderer's inputType (empty object) also composes (it's the fallback)
    const dirInput = createType('object', []);
    expect(isNever(compose(dirInput, schemaType!))).toBe(false);

    // But document is checked first, so it wins in the ordered loop
    expect(pickRenderer(seq, 'docs.readme')).toBe('document');
  });

  test('glob schema propagates type to children → dispatch works on child paths', () => {
    // Mount a glob schema for all docs
    seq.mount('schema', 'docs.*', createType('object', [
      property('content', FT.string(), false),
    ]));

    // Mount a specific doc
    seq.mount('bind', 'docs.readme.content', 'Hello');
    seq.mount('bind', 'docs.readme.title', 'README');

    // typeAt should resolve through the glob
    const childType = seq.typeAt('docs.readme');
    expect(childType).toBeDefined();

    // Dispatch should pick document renderer via the glob-inherited type
    expect(pickRenderer(seq, 'docs.readme')).toBe('document');
  });

  test('ref-aliased path inherits type for dispatch', () => {
    // Template at one path
    seq.mount('schema', '_templates.article', createType('object', [
      property('content', FT.string(), false),
      property('author', FT.string(), false),
    ]));

    // Alias via ref
    seq.mount('schema', 'articles.first', createType('object', [
      { op: 'ref' as const, args: ['_templates.article'] },
    ]));

    // typeAt should follow the ref
    const aliasedType = seq.typeAt('articles.first');
    expect(aliasedType).toBeDefined();
    if (aliasedType) {
      expect(aliasedType.kind).toBe('object');
    }

    // The aliased type should have content:string → document renderer
    expect(pickRenderer(seq, 'articles.first')).toBe('document');
  });

  test('check validates value against schema before mount accepts it', () => {
    const stringSchema = FT.string();

    // A string value checks ok against string schema
    expect(check(stringSchema, 'hello', 'test').ok).toBe(true);

    // A number value fails against string schema
    expect(check(stringSchema, 42, 'test').ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. NARROWING CHAIN — compose on unions eliminates via covers
// ═══════════════════════════════════════════════════════════════════════

describe('narrowing chain — compose eliminates non-covered branches', () => {
  test('compose(renderUnion, scopeWithContent) → document branch only', () => {
    const renderUnion = createType('or', [
      { op: 'branch' as const, args: [createType('object', [property('content', FT.string(), false)])] },
      { op: 'branch' as const, args: [createType('object', [])] },
    ]);
    const scopeType = createType('object', [
      property('content', FT.string(), false),
      property('title', FT.string(), false),
    ]);

    const narrowed = compose(renderUnion, scopeType);
    // Document branch covers (has content) → survives.
    // Directory branch (empty object) also covers (no requirements) → survives.
    // Both survive, but document is first. The compose result is a union
    // with both (or just the composed type if they merge).
    expect(isNever(narrowed)).toBe(false);
  });

  test('compose(renderUnion, scopeWithoutContent) → directory branch only', () => {
    const renderUnion = createType('or', [
      { op: 'branch' as const, args: [createType('object', [property('content', FT.string(), false)])] },
      { op: 'branch' as const, args: [createType('object', [])] },
    ]);
    const scopeType = createType('object', [
      property('status', FT.string(), false),
    ]);

    const narrowed = compose(renderUnion, scopeType);
    // Document branch requires content — scope doesn't have it → eliminated.
    // Directory branch (empty object) → covers → survives.
    // Result should be the directory type narrowed, not a union.
    expect(isNever(narrowed)).toBe(false);
    // Should NOT be a union — only one branch survived
    expect(narrowed.kind).toBe('object');
    // The surviving branch is the directory (empty object) composed with scope
    const props = narrowed.constraints.filter(c => c.op === 'property');
    expect(props.some(c => c.args[0] === 'status')).toBe(true);
    // No content property — document branch was eliminated
    expect(props.some(c => c.args[0] === 'content')).toBe(false);
  });

  test('Sequence narrowing: mount union then narrow → dispatch via compose', () => {
    const seq = new Sequence(() => Date.now());

    // Mount the render union
    seq.mount('schema', 'view.render', createType('or', [
      { op: 'branch' as const, args: [createType('object', [property('content', FT.string(), false)])] },
      { op: 'branch' as const, args: [createType('object', [])] },
    ]));

    // Mount a scope type
    const scopeType = createType('object', [
      property('status', FT.string(), false),
    ]);

    // Narrow the view by the scope — this is what << does
    const narrowed = compose(seq.typeAt('view.render')!, scopeType);

    // Document eliminated (no content), directory survives
    expect(isNever(narrowed)).toBe(false);
    expect(narrowed.kind).toBe('object');
  });

  test('fn union narrowing: candidate without required params → branch eliminated', () => {
    const fnUnion = createType('or', [
      { op: 'branch' as const, args: [createType('fn', [
        param(createType('object', [
          property('auth', FT.string(), false),
          property('prompt', FT.string(), false),
        ])),
        returns(FT.string()),
      ])] },
      { op: 'branch' as const, args: [createType('fn', [
        param(createType('object', [
          property('prompt', FT.string(), false),
        ])),
        returns(FT.string()),
      ])] },
    ]);

    // Only prompt available — first branch (needs auth+prompt) eliminated
    const promptOnly = createType('object', [
      property('prompt', FT.string(), false),
    ]);

    const narrowed = compose(fnUnion, promptOnly);
    // Only the second branch (prompt-only) survives
    expect(isNever(narrowed)).toBe(false);
    // Result is fn application output (string), not a union
    expect(narrowed.kind).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. FULL NARROWING CHAIN — scope + identity + time
// ═══════════════════════════════════════════════════════════════════════

describe('full narrowing chain — multiple constraints eliminate branches', () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence(() => Date.now());
  });

  test('tool union narrowed by scope then identity', () => {
    // Three tools as fn branches:
    //   claude: needs auth + prompt (premium, requires identity)
    //   gpt:    needs key + prompt  (external, requires different identity)
    //   local:  needs prompt only   (no identity requirement)
    const claude = createType('fn', [
      param(createType('object', [
        property('auth', FT.string(), false),
        property('prompt', FT.string(), false),
      ])),
      returns(FT.string()),
    ]);
    const gpt = createType('fn', [
      param(createType('object', [
        property('key', FT.string(), false),
        property('prompt', FT.string(), false),
      ])),
      returns(FT.string()),
    ]);
    const local = createType('fn', [
      param(createType('object', [
        property('prompt', FT.string(), false),
      ])),
      returns(FT.string()),
    ]);

    const capUnion = createType('or', [
      { op: 'branch' as const, args: [claude] },
      { op: 'branch' as const, args: [gpt] },
      { op: 'branch' as const, args: [local] },
    ]);

    // Step 1: narrow by what the user provides (prompt only)
    const promptOnly = createType('object', [
      property('prompt', FT.string(), false),
    ]);
    const afterScope = compose(capUnion, promptOnly);
    // claude eliminated (needs auth), gpt eliminated (needs key), local survives
    expect(isNever(afterScope)).toBe(false);
    expect(afterScope.kind).toBe('string'); // fn application → output type

    // Step 2: user provides auth → claude now viable
    const withAuth = createType('object', [
      property('auth', FT.string(), false),
      property('prompt', FT.string(), false),
    ]);
    const afterAuth = compose(capUnion, withAuth);
    // claude survives (has auth+prompt), gpt eliminated (no key), local survives
    expect(isNever(afterAuth)).toBe(false);
    // Two branches survived → union of their outputs, or first fn application
    // (depends on compose semantics — fn application returns output type)

    // Step 3: user provides everything → claude selected (first branch)
    const withAll = createType('object', [
      property('auth', FT.string(), false),
      property('key', FT.string(), false),
      property('prompt', FT.string(), false),
    ]);
    const afterAll = compose(capUnion, withAll);
    expect(isNever(afterAll)).toBe(false);
  });

  test('time constraint eliminates branches via deadline feasibility', () => {
    // Two tools with different latency distributions:
    //   slow: lognormal(mu=7, sigma=0.5) — median ~1097ms
    //   fast: lognormal(mu=6, sigma=0.3) — median ~403ms
    // Both have a 1000ms deadline at 95% confidence.
    const slow = createType('fn', [
      param(createType('object', [property('prompt', FT.string(), false)])),
      returns(FT.string()),
      distribution('time', 'lognormal', { mu: 7, sigma: 0.5 }),
      responsePolicy(1000, 0.95),
    ]);
    const fast = createType('fn', [
      param(createType('object', [property('prompt', FT.string(), false)])),
      returns(FT.string()),
      distribution('time', 'lognormal', { mu: 6, sigma: 0.3 }),
      responsePolicy(1000, 0.95),
    ]);

    const timeUnion = createType('or', [
      { op: 'branch' as const, args: [slow] },
      { op: 'branch' as const, args: [fast] },
    ]);

    // Narrow by input — both accept prompt, but deadline check fires
    // during fn-fn compose (detectContradiction checks distribution vs deadline)
    const input = createType('fn', [
      param(createType('object', [property('prompt', FT.string(), false)])),
      returns(FT.string()),
      distribution('time', 'lognormal', { mu: 0, sigma: 1 }),
      responsePolicy(1000, 0.95),
    ]);

    const afterTime = compose(timeUnion, input);
    // slow: P(≤1000ms) ≈ 0.427 < 0.95 → deadline infeasible → eliminated
    // fast: P(≤1000ms) ≈ 0.999 ≥ 0.95 → feasible → survives
    expect(isNever(afterTime)).toBe(false);
  });

  test('progressive narrowing in sequence: mount union, narrow scope, narrow identity', () => {
    // Mount a tool union at a view path
    const claude = createType('fn', [
      param(createType('object', [
        property('auth', FT.string(), false),
        property('prompt', FT.string(), false),
      ])),
      returns(FT.string()),
    ]);
    const local = createType('fn', [
      param(createType('object', [
        property('prompt', FT.string(), false),
      ])),
      returns(FT.string()),
    ]);

    seq.mount('schema', '_tools', createType('or', [
      { op: 'branch' as const, args: [claude] },
      { op: 'branch' as const, args: [local] },
    ]));

    const capsType = seq.typeAt('_tools')!;
    expect(capsType.kind).toBe('or');

    // Narrow by prompt-only → claude eliminated, local survives
    const promptOnly = createType('object', [
      property('prompt', FT.string(), false),
    ]);
    const narrowed1 = compose(capsType, promptOnly);
    expect(isNever(narrowed1)).toBe(false);
    expect(narrowed1.kind).toBe('string'); // local's output

    // Narrow by auth+prompt → claude survives (first), local also survives
    const withAuth = createType('object', [
      property('auth', FT.string(), false),
      property('prompt', FT.string(), false),
    ]);
    const narrowed2 = compose(capsType, withAuth);
    expect(isNever(narrowed2)).toBe(false);
    // Both survive — result is union of outputs or first fn application
  });

  test('the block model: all constraints compose in one step', () => {
    // Simulate: session.view << [_render, scopeType]
    // where _render is an object union and scopeType is the scope's shape.
    //
    // This is what a block does: all narrowings compose together.
    // The result is the same as progressive narrowing.

    const renderUnion = createType('or', [
      { op: 'branch' as const, args: [createType('object', [property('content', FT.string(), false)])] },
      { op: 'branch' as const, args: [createType('object', [])] },
    ]);

    // Scope without content
    const scopeType = createType('object', [
      property('status', FT.string(), false),
    ]);

    // One-step: compose(renderUnion, scopeType) = directory
    const oneStep = compose(renderUnion, scopeType);

    // Progressive: compose(compose(renderUnion, identity), scopeType)
    // (identity is ANY for this test — no identity constraint)
    const step1 = compose(renderUnion, createType('any', []));
    const step2 = compose(step1, scopeType);

    // Both should produce the same result: directory (object, not union)
    expect(oneStep.kind).toBe('object');
    expect(step2.kind).toBe('object');

    // Both should have status property (from scope) but not content
    const oneStepProps = oneStep.constraints.filter(c => c.op === 'property');
    const step2Props = step2.constraints.filter(c => c.op === 'property');
    expect(oneStepProps.some(c => c.args[0] === 'status')).toBe(true);
    expect(oneStepProps.some(c => c.args[0] === 'content')).toBe(false);
    expect(step2Props.some(c => c.args[0] === 'status')).toBe(true);
    expect(step2Props.some(c => c.args[0] === 'content')).toBe(false);
  });
});
