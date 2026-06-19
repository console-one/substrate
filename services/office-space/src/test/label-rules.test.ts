/**
 * label-rules.test.ts — Backlink index for labeled blocks.
 *
 * Every mount with a block label produces an entry in the
 * inverted index at `_labels.{label}.{seq}`. Downstream classes
 * and tools query the index to find backlinked blocks for a
 * concept without needing to scan `_blocks.*` themselves.
 */

import { Sequence } from '@console-one/sequence';
import { registerLabelRules } from '@console-one/sequenceutils/policies';

describe('label backlink index', () => {
  function newSeq(): Sequence {
    const seq = new Sequence(() => Date.now());
    registerLabelRules(seq);
    return seq;
  }

  test('labeled mount produces an inverted-index entry', () => {
    const seq = newSeq();

    const result = seq.mount('bind', 'doc.draft', 'hello', { label: 'welcome-page' });
    expect(result.ok).toBe(true);

    // The block's label is visible at `_blocks.{identity}.{seq}.label`.
    expect(seq.get(`_blocks.${seq.identity}.${result.blockSeq}.label`)).toBe('welcome-page');

    // Backlink index preserves identity: `_labels.{label}.{id}.{seq}`.
    expect(seq.get(`_labels.welcome-page.${seq.identity}.${result.blockSeq}`)).toBe(true);
  });

  test('unlabeled mounts do not populate the index', () => {
    const seq = newSeq();
    const result = seq.mount('bind', 'doc.draft', 'hello');
    expect(seq.get(`_blocks.${seq.identity}.${result.blockSeq}.label`)).toBeUndefined();
    // No label → no index entry.
    expect(seq.keys('_labels')).toEqual([]);
  });

  test('multiple blocks sharing a label all show up under that label', () => {
    const seq = newSeq();
    const r1 = seq.mount('bind', 'a', 1, { label: 'contract-X' });
    const r2 = seq.mount('bind', 'b', 2, { label: 'contract-X' });
    const r3 = seq.mount('bind', 'c', 3, { label: 'contract-Y' });

    // `_labels.contract-X.{identity}.*` is the per-peer backlink set.
    const xBlocks = seq.keys(`_labels.contract-X.${seq.identity}`).sort();
    expect(xBlocks).toEqual([String(r1.blockSeq), String(r2.blockSeq)].sort());

    const yBlocks = seq.keys(`_labels.contract-Y.${seq.identity}`);
    expect(yBlocks).toEqual([String(r3.blockSeq)]);
  });

  test('concept backlinks: iterate all blocks tagged with a concept', () => {
    const seq = newSeq();
    seq.mount('bind', 'notes.a', 'first', { label: 'Q1-plan' });
    seq.mount('bind', 'notes.b', 'second', { label: 'Q1-plan' });
    seq.mount('bind', 'notes.c', 'third', { label: 'Q2-plan' });

    // Iterating `_labels.Q1-plan.*` gives the identities that
    // produced Q1-plan blocks; one level deeper gives the seqs.
    const q1Seqs = seq.keys(`_labels.Q1-plan.${seq.identity}`);
    expect(q1Seqs.length).toBe(2);
    const q2Seqs = seq.keys(`_labels.Q2-plan.${seq.identity}`);
    expect(q2Seqs.length).toBe(1);
  });
});
