/**
 * rotation-recursive.test.ts — "All the way down" probe.
 *
 * The compression/federation/retention primitive applied recursively:
 * hot → warm → cold → frozen, all the same operation, no special
 * cases. After two chained rotations, the canonical path still
 * resolves (through chained refs) to the data wherever it now lives.
 *
 * Also covers the cross-author rejection: a non-holder cannot rotate
 * data they don't own — the kernel admission gate on schema mounts
 * (landed in the prior commit) enforces this on the redirect schema
 * mount. Without that gate, rotation would silently succeed for any
 * caller; with it, the lock semantics extend transitively.
 */

import {
  Sequence, FT, createType, property, key, law, or, eq, notExists, rotate,
} from '@console-one/sequence';

let seq: Sequence;
let now = 1000;

beforeEach(() => {
  seq = new Sequence(() => now);
});

function installLockedRange(prefix: string): void {
  seq.mount('schema', `${prefix}.*`, createType('object', [
    property('holder', FT.string(), true),
    key('id'),
    law({
      admission: true,
      reason: `writer-authority on ${prefix}.{id}.*`,
      check: or(
        notExists('$instancePath.holder'),
        eq('$instancePath.holder', '$author'),
      ),
    }),
  ]));
}

describe('generic rotation as the compression primitive', () => {
  test('rotate moves data + leaves transparent redirect', () => {
    installLockedRange('hot');

    seq.mount('bind', 'hot.foo.holder', 'alice', { author: 'alice' });
    seq.mount('bind', 'hot.foo.body', 'the-payload', { author: 'alice' });
    seq.mount('bind', 'hot.foo.size', 42, { author: 'alice' });

    expect(seq.get('hot.foo.body')).toBe('the-payload');
    expect(seq.get('hot.foo.size')).toBe(42);

    const result = rotate(seq, {
      source: 'hot.foo',
      destination: 'warm.foo',
      author: 'alice',
    });

    expect(result.ok).toBe(true);
    expect(result.rejectedPaths).toEqual([]);
    // The leaves we expect to have moved (sub-paths under hot.foo).
    expect(result.movedPaths.map(m => m.source).sort()).toEqual([
      'hot.foo.body',
      'hot.foo.holder',
      'hot.foo.size',
    ]);

    // Destination has the data.
    expect(seq.get('warm.foo.body')).toBe('the-payload');
    expect(seq.get('warm.foo.size')).toBe(42);

    // Canonical path still resolves through the redirect refs.
    expect(seq.get('hot.foo.body')).toBe('the-payload');
    expect(seq.get('hot.foo.size')).toBe(42);
  });

  test('rotation composes: hot → warm → cold, canonical reads still resolve through chained refs', () => {
    installLockedRange('hot');

    seq.mount('bind', 'hot.task.holder', 'alice', { author: 'alice' });
    seq.mount('bind', 'hot.task.body', 'work', { author: 'alice' });

    // First rotation: hot → warm.
    const r1 = rotate(seq, {
      source: 'hot.task',
      destination: 'warm.task',
      author: 'alice',
    });
    expect(r1.ok).toBe(true);
    expect(seq.get('hot.task.body')).toBe('work');
    expect(seq.get('warm.task.body')).toBe('work');

    // Second rotation: warm → cold (data moves further down the tier
    // chain). Canonical hot path still resolves — through warm ref
    // (still mounted) → through cold ref (just mounted).
    const r2 = rotate(seq, {
      source: 'warm.task',
      destination: 'cold.task',
      author: 'alice',
    });
    expect(r2.ok).toBe(true);

    // Cold has the data.
    expect(seq.get('cold.task.body')).toBe('work');
    // Warm reads route through cold.
    expect(seq.get('warm.task.body')).toBe('work');
    // Hot reads route through warm → cold.
    expect(seq.get('hot.task.body')).toBe('work');

    // Update the cold backing data — every layer above sees it via
    // the chained refs (proves it really IS routing, not snapshot).
    seq.mount('bind', 'cold.task.body', 'work-updated', { author: 'alice' });
    expect(seq.get('hot.task.body')).toBe('work-updated');
    expect(seq.get('warm.task.body')).toBe('work-updated');
    expect(seq.get('cold.task.body')).toBe('work-updated');
  });

  test('non-holder rotation is rejected by the source admission law', () => {
    installLockedRange('hot');
    seq.mount('bind', 'hot.foo.holder', 'alice', { author: 'alice' });
    seq.mount('bind', 'hot.foo.body', 'private', { author: 'alice' });

    // Bob tries to rotate alice's range — the redirect schema mount
    // and the source delete should both fail admission. Destination
    // mount may succeed (warm.* has no admission law installed), but
    // the source mounts fail, so rejectedPaths is non-empty and ok=false.
    const result = rotate(seq, {
      source: 'hot.foo',
      destination: 'warm.foo',
      author: 'bob',
    });

    expect(result.ok).toBe(false);
    expect(result.rejectedPaths.length).toBeGreaterThan(0);
    // Bob's redirect schema or delete on hot.* MUST be rejected — the
    // reason carries through from the writer-authority admission law.
    const reasons = result.rejectedPaths.map(r => r.reason).join(' ');
    expect(reasons.toLowerCase()).toMatch(/holder|writer-authority|admission/);

    // Source value is intact since admission rejected the redirect mount.
    expect(seq.get('hot.foo.body')).toBe('private');
  });

  test('rotation across the same lock holder works for federation-shaped destinations', () => {
    // Federation = "destination is a peer namespace" — not a special
    // case. Same rotate() call. Here the destination prefix is
    // _peers.archive (a path the lock holder can mount under, since
    // _peers.* has no admission law installed by default).
    installLockedRange('hot');
    seq.mount('bind', 'hot.x.holder', 'alice', { author: 'alice' });
    seq.mount('bind', 'hot.x.body', 'data', { author: 'alice' });

    const result = rotate(seq, {
      source: 'hot.x',
      destination: '_peers.archive.x',
      author: 'alice',
    });

    expect(result.ok).toBe(true);
    expect(seq.get('_peers.archive.x.body')).toBe('data');
    expect(seq.get('hot.x.body')).toBe('data'); // ref-walks through
  });
});
