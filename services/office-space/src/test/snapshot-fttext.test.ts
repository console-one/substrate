/**
 * snapshot-fttext.test.ts — Incoherence #3.
 *
 * Asserts the OfficeSpaceClient snapshot round-trips through ft text
 * via hoist + receive — same protocol as the wire. No JSON codec on
 * the kernel state.
 *
 * Verifies:
 *   - Client mounts state, saves snapshot, shuts down
 *   - A new client on the same dataDir loads the snapshot
 *   - Loaded state matches what was saved
 *   - The on-disk file is ft text, not JSON
 *   - Sidecar meta.json carries lastServerSeq + pendingBuffer (the
 *     things that aren't part of the Sequence's own state)
 */

import { OfficeSpaceClient } from '@console-one/sequenceutils/transport';
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('client snapshot as ft text (incoherence #3)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'snap-test-'));
  });

  afterEach(() => {
    try { rmSync(dataDir, { recursive: true }); } catch {}
  });

  test('snapshot round-trips through ft text', () => {
    // First client: mount some state and shut down.
    const c1 = new OfficeSpaceClient({
      dataDir,
      serverUrl: 'ws://localhost:0', // we don't actually connect
      user: 'alice',
      env: 'test',
    });
    c1.mount('hello = "world"');
    c1.mount('counter = 42');
    c1.mount('nested.deep.value = "kept"');
    expect(c1.get('hello')).toBe('world');
    expect(c1.get('counter')).toBe(42);
    expect(c1.get('nested.deep.value')).toBe('kept');
    c1.shutdown();

    // Verify the snapshot file on disk is ft text, not JSON.
    const ftPath = join(dataDir, 'snapshot.ft');
    expect(existsSync(ftPath)).toBe(true);
    const text = readFileSync(ftPath, 'utf-8');
    expect(text).toContain('hello');
    expect(text).toContain('world');
    expect(text).toContain('counter');
    expect(text).toContain('42');
    // ft text uses `path = value` lines, not JSON objects
    expect(text.startsWith('{')).toBe(false);

    // Second client: same dataDir, should load the snapshot.
    const c2 = new OfficeSpaceClient({
      dataDir,
      serverUrl: 'ws://localhost:0',
      user: 'alice',
      env: 'test',
    });
    expect(c2.get('hello')).toBe('world');
    expect(c2.get('counter')).toBe(42);
    expect(c2.get('nested.deep.value')).toBe('kept');
    c2.shutdown();
  });

  test('sidecar meta carries connection bookkeeping, not state', () => {
    const c1 = new OfficeSpaceClient({
      dataDir,
      serverUrl: 'ws://localhost:0',
      user: 'bob',
      env: 'test',
    });
    c1.mount('thing = "value"');
    c1.shutdown();

    const metaPath = join(dataDir, 'meta.json');
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    expect(typeof meta.savedAt).toBe('number');
    expect(meta).toHaveProperty('lastServerSeq');
    expect(meta).toHaveProperty('pendingBuffer');
    // The state itself is NOT in meta.json — that's in snapshot.ft.
    expect(JSON.stringify(meta)).not.toContain('"value"');
  });

  test('legacy snapshot.json is ignored (clean break)', () => {
    // Write an old-format snapshot.json. The new client doesn't read it.
    const legacyPath = join(dataDir, 'snapshot.json');
    writeFileSync(legacyPath, JSON.stringify({
      entries: [{ op: 'bind', path: 'legacy', value: 'should-not-load' }],
    }));

    const c = new OfficeSpaceClient({
      dataDir,
      serverUrl: 'ws://localhost:0',
      user: 'eve',
      env: 'test',
    });
    expect(c.get('legacy')).toBeUndefined();
    c.shutdown();
  });
});
