/**
 * scripts/trace-index-demo.ts — Block log as queryable collection,
 * identity-scoped for distributed trace.
 *
 * Demonstrates the shape the SEQUENCE_NODES.md trace primitive was
 * pointing at: `_blocks.{identity}.{seq}.*` is type state readable
 * by `indexSpec` classes. A consumer declares its interest as a
 * class with a where-clause over the dimensions it cares about
 * (time, author, label, paths); the kernel's existing cascade
 * maintains the consumer's result set; read-back is through
 * ordinary `keys()` + `get()`.
 *
 * The identity prefix is what makes this distributed-safe: when a
 * peer's `_blocks.{peerId}.*` lands on a receiver via emission, it
 * doesn't collide with the receiver's own `_blocks.{myId}.*` —
 * every kernel counts its blocks from 1 but the identity namespace
 * keeps them distinct.
 *
 * Single-process demos here for clarity; the same bindings work
 * against a receiver's block log populated from peer deltas.
 *
 * Run:
 *   npx tsx scripts/trace-index-demo.ts
 */

import { Sequence, createType, indexSpec, bindFrom, eq, gt, exists } from '@ft/core';

function hr(label: string): void {
  process.stdout.write(`\n─── ${label} ${'─'.repeat(60 - label.length - 4)}\n`);
}

function main(): void {
  let clockValue = 1000;
  const clock = (): number => {
    clockValue += 1;
    return clockValue;
  };
  const seq = new Sequence(clock, undefined, 'alpha');  // stable identity for the demo
  process.stdout.write(`sequence identity: ${seq.identity}\n`);

  // ─── DEMO 1: index blocks by author (identity-scoped) ────────
  // Every block with an author gets a pointer recorded at
  // `_indexes.byAuthor.{author}.{identity}.{seq} = {blockTime}`.
  // Preserving identity in the index key means when a consumer
  // observes multiple peers' logs, entries are attributable.

  hr('Demo 1: index blocks by author');

  seq.mount('schema', '_indexes.byAuthor', createType('any', [
    indexSpec({
      indexedBy: ['id', 's', 'a'],
      where: [
        bindFrom('id', '_blocks.*'),            // identity (peer) level
        bindFrom('s', '_blocks.{id}.*'),        // seq within that identity
        bindFrom('a', '_blocks.{id}.{s}.author'),
      ],
      // Flag-style inverted index (same pattern as label-rules.ts):
      // write `true` at the compound key; consumers read the block's
      // actual metadata via `get('_blocks.{id}.{s}.time')` etc.
      // Value interpolation is string-substitution, not path-deref —
      // so `value: '_blocks.{id}.{s}.time'` would store the literal
      // string, not the time value.
      body: [
        { op: 'bind', path: '_indexes.byAuthor.{a}.{id}.{s}', value: true },
      ],
    }),
  ]));

  seq.mount('bind', 'chat.a', 'hi from alice', { author: 'alice' });
  seq.mount('bind', 'chat.b', 'hi from bob', { author: 'bob' });
  seq.mount('bind', 'chat.c', 'another from alice', { author: 'alice' });
  seq.mount('bind', 'chat.d', 'unsigned mount');  // no author — won't appear

  const authors = seq.keys('_indexes.byAuthor');
  process.stdout.write(`authors recorded: [${authors.join(', ')}]\n`);
  for (const author of authors) {
    const peers = seq.keys(`_indexes.byAuthor.${author}`);
    for (const peer of peers) {
      const blockSeqs = seq.keys(`_indexes.byAuthor.${author}.${peer}`);
      process.stdout.write(`  ${author} (peer ${peer}): blocks [${blockSeqs.join(', ')}]\n`);
      for (const s of blockSeqs) {
        const time = seq.get(`_blocks.${peer}.${s}.time`);  // read metadata via block log
        process.stdout.write(`    block ${s} at time ${time}\n`);
      }
    }
  }

  // ─── DEMO 2: time-range cursor via gt ────────────────────────
  // "Give me blocks applied after cursor T" is a where clause with
  // `gt('_blocks.{id}.{s}.time', cursor)`. The cursor is a scalar
  // mounted at a path — update it to "advance" through the log.

  hr('Demo 2: time-range cursor (gt)');

  seq.mount('bind', '_cursors.fresh.since', clockValue);
  process.stdout.write(`cursor: _cursors.fresh.since = ${seq.get('_cursors.fresh.since')}\n`);

  seq.mount('schema', '_indexes.freshBlocks', createType('any', [
    indexSpec({
      indexedBy: ['id', 's'],
      where: [
        bindFrom('id', '_blocks.*'),
        bindFrom('s', '_blocks.{id}.*'),
        // Only blocks with an author — excludes the index-class's
        // own body mounts (which carry no author). Without this,
        // the gt-on-time filter matches every block recursively
        // including the index's own output, and the fixpoint runs
        // forever (self-feedback: every body mount is a new block
        // with a fresh time, passes the filter, fires the body).
        exists('_blocks.{id}.{s}.author'),
        gt('_blocks.{id}.{s}.time', '_cursors.fresh.since'),
      ],
      body: [
        { op: 'bind', path: '_indexes.freshBlocks.{id}.{s}', value: true },
      ],
    }),
  ]));

  const listFresh = (): string => {
    const out: string[] = [];
    for (const id of seq.keys('_indexes.freshBlocks')) {
      for (const s of seq.keys(`_indexes.freshBlocks.${id}`)) {
        out.push(`${id}/${s}`);
      }
    }
    return out.join(', ') || '(empty)';
  };

  process.stdout.write(`before new mounts — fresh: ${listFresh()}\n`);

  seq.mount('bind', 'chat.e', 'recent message', { author: 'alice' });
  seq.mount('bind', 'chat.f', 'another recent', { author: 'bob' });

  process.stdout.write(`after new mounts  — fresh: ${listFresh()}\n`);

  const newCursor = clockValue;
  seq.mount('bind', '_cursors.fresh.since', newCursor);
  process.stdout.write(`cursor advanced to ${newCursor}\n`);
  process.stdout.write(`after cursor advance — fresh: ${listFresh()}\n`);

  seq.mount('bind', 'chat.g', 'post-advance', { author: 'charlie' });
  process.stdout.write(`after one more mount — fresh: ${listFresh()}\n`);
  process.stdout.write(
    '  (note: entries written earlier stay present after the cursor\n' +
    '   advances — indexSpec bodies are additive, not retractive.\n' +
    '   Retraction requires a separate pattern — not demoed here.)\n',
  );

  // ─── DEMO 3: filter by label ─────────────────────────────────

  hr('Demo 3: filter by label');

  seq.mount('schema', '_indexes.chatOnly', createType('any', [
    indexSpec({
      indexedBy: ['id', 's'],
      where: [
        bindFrom('id', '_blocks.*'),
        bindFrom('s', '_blocks.{id}.*'),
        eq('_blocks.{id}.{s}.label', 'chat'),
      ],
      body: [
        { op: 'bind', path: '_indexes.chatOnly.{id}.{s}', value: true },
      ],
    }),
  ]));

  seq.mount('bind', 'chat.h', 'labeled chat', { author: 'alice', label: 'chat' });
  seq.mount('bind', 'report.x', 'labeled report', { author: 'alice', label: 'report' });
  seq.mount('bind', 'chat.i', 'another chat', { author: 'bob', label: 'chat' });

  for (const id of seq.keys('_indexes.chatOnly')) {
    for (const s of seq.keys(`_indexes.chatOnly.${id}`)) {
      const author = seq.get(`_blocks.${id}.${s}.author`);
      process.stdout.write(`  chat block ${id}/${s} — author: ${author}\n`);
    }
  }

  hr('Done');
  process.stdout.write(
    '\nindexSpec + `_blocks.{identity}.{seq}.*` + the cascade is\n' +
    'the whole primitive. Same bindings work whether the block log\n' +
    'is one peer\'s own or populated from many peers\' emissions —\n' +
    'the identity prefix keeps attribution intact. Composes with\n' +
    'any constraint in the where vocabulary (gt/lt/eq/regex/exists).\n',
  );
}

main();
