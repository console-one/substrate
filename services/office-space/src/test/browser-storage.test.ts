/**
 * browser-storage.test.ts — BrowserStorage (MemoryBackend path).
 *
 * Runs entirely against the Map-backed in-memory backend. Real
 * IndexedDB tests belong in a Playwright integration suite; the
 * logic being validated here is the BrowserStorage layer itself:
 * trusted-prefix scoping, read cache, error shape on missing key,
 * the three IStorage methods that actually get called at runtime.
 */

import { BrowserStorage, resetAllBrowserStorage } from '@console-one/sequenceutils/transport';

describe('BrowserStorage (memory backend)', () => {
  afterEach(() => {
    resetAllBrowserStorage();
  });

  test('write → read round-trips a key', async () => {
    const s = new BrowserStorage({ dbName: 'rw', forceMemory: true });
    await s.write('notes/hello.md', '# hi\n');
    expect(await s.read('notes/hello.md')).toBe('# hi\n');
  });

  test('read on missing key throws ENOENT-shaped error', async () => {
    const s = new BrowserStorage({ dbName: 'missing', forceMemory: true });
    await expect(s.read('nope.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('has / exists both reflect presence', async () => {
    const s = new BrowserStorage({ dbName: 'has', forceMemory: true });
    expect(await s.has('k')).toBe(false);
    expect(await s.exists('k')).toBe(false);
    await s.write('k', 'v');
    expect(await s.has('k')).toBe(true);
    expect(await s.exists('k')).toBe(true);
  });

  test('delete removes the key and invalidates the cache', async () => {
    const s = new BrowserStorage({ dbName: 'del', forceMemory: true });
    await s.write('k', 'v1');
    expect(await s.read('k')).toBe('v1');   // populates cache
    await s.delete('k');
    expect(await s.has('k')).toBe(false);
    await expect(s.read('k')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('write invalidates the read cache so subsequent reads see the new value', async () => {
    const s = new BrowserStorage({ dbName: 'cache-invalid', forceMemory: true });
    await s.write('k', 'first');
    expect(await s.read('k')).toBe('first');
    await s.write('k', 'second');
    expect(await s.read('k')).toBe('second');
  });

  test('append concatenates, creating the key if missing', async () => {
    const s = new BrowserStorage({ dbName: 'append', forceMemory: true });
    await s.append('log.ft', 'line1\n');
    await s.append('log.ft', 'line2\n');
    expect(await s.read('log.ft')).toBe('line1\nline2\n');
  });

  test('list returns only keys under the requested prefix', async () => {
    const s = new BrowserStorage({ dbName: 'list', forceMemory: true });
    await s.write('notes/a.md', 'a');
    await s.write('notes/b.md', 'b');
    await s.write('other/c.md', 'c');
    const keys = await s.list('notes/');
    expect(keys.sort()).toEqual(['notes/a.md', 'notes/b.md']);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Trusted-prefix scoping: two BrowserStorage instances sharing the
  // same dbName but with different rootPrefix values don't collide,
  // and callers can't escape their root with .. segments (which get
  // normalized out, same semantic as NodeStorage's throw-on-traversal
  // except IndexedDB has no filesystem traversal to throw on).
  // ═══════════════════════════════════════════════════════════════════

  test('rootPrefix scopes keys so two instances on the same db don\'t collide', async () => {
    const a = new BrowserStorage({ dbName: 'scoped', rootPrefix: 'alice', forceMemory: true });
    const b = new BrowserStorage({ dbName: 'scoped', rootPrefix: 'bob', forceMemory: true });
    await a.write('inbox.ft', 'alice-message');
    await b.write('inbox.ft', 'bob-message');
    expect(await a.read('inbox.ft')).toBe('alice-message');
    expect(await b.read('inbox.ft')).toBe('bob-message');
  });

  test('rootPrefix list only returns keys under that prefix, not sibling prefixes', async () => {
    const a = new BrowserStorage({ dbName: 'scoped-list', rootPrefix: 'alice', forceMemory: true });
    const b = new BrowserStorage({ dbName: 'scoped-list', rootPrefix: 'bob', forceMemory: true });
    await a.write('note1.md', 'a1');
    await a.write('note2.md', 'a2');
    await b.write('note3.md', 'b3');
    const aKeys = await a.list('');
    expect(aKeys.sort()).toEqual(['note1.md', 'note2.md']);
  });

  test('path traversal (..) is normalized out, not thrown — key ends up scoped inside the prefix', async () => {
    const s = new BrowserStorage({ dbName: 'traversal', rootPrefix: 'scope', forceMemory: true });
    await s.write('../outside.txt', 'payload');
    // After normalization: `../outside.txt` becomes `outside.txt` inside the prefix.
    // Reading via either form resolves the same key — `..` is stripped on read too.
    expect(await s.read('outside.txt')).toBe('payload');
    expect(await s.read('../outside.txt')).toBe('payload');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Memory backend module-globality: two BrowserStorage instances
  // naming the same db see the same state, matching the real
  // IndexedDB "db name identifies the store" invariant. The reset
  // helper clears them between tests.
  // ═══════════════════════════════════════════════════════════════════

  test('two instances with the same dbName share state', async () => {
    const s1 = new BrowserStorage({ dbName: 'shared', forceMemory: true });
    await s1.write('k', 'v');
    const s2 = new BrowserStorage({ dbName: 'shared', forceMemory: true });
    expect(await s2.read('k')).toBe('v');
  });

  test('different dbNames are isolated', async () => {
    const a = new BrowserStorage({ dbName: 'iso-a', forceMemory: true });
    const b = new BrowserStorage({ dbName: 'iso-b', forceMemory: true });
    await a.write('k', 'a-value');
    await b.write('k', 'b-value');
    expect(await a.read('k')).toBe('a-value');
    expect(await b.read('k')).toBe('b-value');
  });

  test('resetAllBrowserStorage clears the module-global memory', async () => {
    const s = new BrowserStorage({ dbName: 'reset', forceMemory: true });
    await s.write('k', 'v');
    resetAllBrowserStorage();
    expect(await s.has('k')).toBe(false);
  });
});
