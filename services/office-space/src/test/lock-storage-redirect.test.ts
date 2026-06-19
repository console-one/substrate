/**
 * lock-storage-redirect.test.ts — Probe: does compression / federation
 * actually fall out of (writer-authority + ref + cascade), as I've
 * been claiming for four turns? This test puts the claim under load
 * with no new kernel code. If it fails, I find the actual gap.
 *
 * Scenario: a session owns a range via a writer-authority admission
 * law (same pattern as sessions.* in server.ts). The session mounts
 * a storage-policy ref pointing at a "hot" backing store. Reads
 * through the ref resolve to the hot store's data. The session then
 * updates the storage policy to point at a "cold" backing store
 * (the "compression" event). Reads now resolve to cold.
 *
 * Claim under test:
 *   - lock-on-range entails lock-on-storage-decision (non-owner
 *     cannot rewrite the storage pointer)
 *   - ref-walk transparently routes reads through the current
 *     pointer, before AND after the storage flip
 *   - dep-cascade fires on consumers when the pointer changes
 *
 * If the claim is true, no new "compression protocol" code is needed.
 * The substrate already does it.
 */

import {
  Sequence, FT, createType, property, key, law,
  or, eq, notExists,
} from '@console-one/sequence';

let seq: Sequence;
let now = 1000;

beforeEach(() => {
  seq = new Sequence(() => now);
});

/**
 * Set up the same writer-authority shape the server uses for
 * sessions.*, but on a generic `claims.*` prefix so this test
 * doesn't depend on the full ContextGraphServer boot.
 */
function installLockedRange(): void {
  seq.mount('schema', 'claims.*', createType('object', [
    property('holder', FT.string(), true),
    property('storage', FT.any(), true),  // ref-typed in practice
    key('id'),
    law({
      admission: true,
      reason: 'writer-authority: only current holder may modify claims.{id}.*',
      check: or(
        notExists('$instancePath.holder'),
        eq('$instancePath.holder', '$author'),
      ),
    }),
  ]));
}

describe('lock + ref + cascade compose into compression semantics', () => {
  test('owner can claim range; non-owner write is rejected (writer-authority)', () => {
    installLockedRange();

    // Alice claims claims.foo.
    const claim = seq.mount('bind', 'claims.foo.holder', 'alice', { author: 'alice' });
    expect(claim.ok).toBe(true);

    // Alice writes; admission allows.
    const ok = seq.mount('bind', 'claims.foo.body', 'hello', { author: 'alice' });
    expect(ok.ok).toBe(true);
    expect(seq.get('claims.foo.body')).toBe('hello');

    // Bob writes; admission rejects.
    const bad = seq.mount('bind', 'claims.foo.body', 'evil', { author: 'bob' });
    expect(bad.ok).toBe(false);
    expect(seq.get('claims.foo.body')).toBe('hello');
  });

  test('lock-on-range entails lock-on-storage-policy: only holder can mount the ref', () => {
    installLockedRange();
    seq.mount('bind', 'claims.foo.holder', 'alice', { author: 'alice' });

    // Alice mounts the storage policy as a ref to hot.foo. Same
    // admission law fires — claims.foo.storage IS under claims.foo.*,
    // so the holder rule applies to it identically.
    const aliceWrite = seq.mount('schema', 'claims.foo.storage', FT.ref('hot.foo'), { author: 'alice' });
    expect(aliceWrite.ok).toBe(true);

    // Bob tries to redirect alice's storage somewhere else — admission rejects.
    const bobWrite = seq.mount('schema', 'claims.foo.storage', FT.ref('evil.foo'), { author: 'bob' });
    expect(bobWrite.ok).toBe(false);
  });

  test('reads through the storage ref resolve to the backing store', () => {
    installLockedRange();
    seq.mount('bind', 'claims.foo.holder', 'alice', { author: 'alice' });

    // Backing store: hot.foo holds the actual data.
    seq.mount('bind', 'hot.foo', 'the-actual-data');

    // Alice mounts the storage policy as a ref to hot.foo.
    seq.mount('schema', 'claims.foo.storage', FT.ref('hot.foo'), { author: 'alice' });

    // Reads through the storage ref resolve to the backing store.
    expect(seq.get('claims.foo.storage')).toBe('the-actual-data');
  });

  test('owner flips storage policy to a different backing store; reads route through the new pointer', () => {
    installLockedRange();
    seq.mount('bind', 'claims.foo.holder', 'alice', { author: 'alice' });

    // Initial: hot store has the data, ref points there.
    seq.mount('bind', 'hot.foo', 'hot-value');
    seq.mount('schema', 'claims.foo.storage', FT.ref('hot.foo'), { author: 'alice' });
    expect(seq.get('claims.foo.storage')).toBe('hot-value');

    // "Compression event": alice mounts the moved data at cold.foo
    // and updates the storage policy to point at it.
    seq.mount('bind', 'cold.foo', 'hot-value');
    const flip = seq.mount('schema', 'claims.foo.storage', FT.ref('cold.foo'), { author: 'alice' });
    expect(flip.ok).toBe(true);

    // Reads now resolve through the NEW ref to cold.foo.
    expect(seq.get('claims.foo.storage')).toBe('hot-value');

    // Mutate cold.foo to something different — the ref-walk should
    // surface the cold value, proving resolution actually goes there
    // (not via stale hot).
    seq.mount('bind', 'cold.foo', 'cold-value-after-mutation');
    expect(seq.get('claims.foo.storage')).toBe('cold-value-after-mutation');

    // hot.foo unchanged but no longer reachable through claims.foo.
    expect(seq.get('hot.foo')).toBe('hot-value');
  });

  test('dependents see the storage flip via cascade', () => {
    installLockedRange();
    seq.mount('bind', 'claims.foo.holder', 'alice', { author: 'alice' });

    seq.mount('bind', 'hot.foo', 'h1');
    seq.mount('bind', 'cold.foo', 'c1');
    seq.mount('schema', 'claims.foo.storage', FT.ref('hot.foo'), { author: 'alice' });

    // A consumer mounts a derived path that depends on claims.foo.storage.
    // (Use a ref so the dep-graph treats it as a follower; derived would
    // need a registered fn tool, which is overkill for this probe.)
    seq.mount('schema', 'consumer.view', FT.ref('claims.foo.storage'));
    expect(seq.get('consumer.view')).toBe('h1');

    // Flip the storage policy. The change must propagate to consumer.view
    // via the same dep-cascade that fires on any mount.
    const flip = seq.mount('schema', 'claims.foo.storage', FT.ref('cold.foo'), { author: 'alice' });
    expect(flip.ok).toBe(true);
    expect(seq.get('consumer.view')).toBe('c1');
  });
});
