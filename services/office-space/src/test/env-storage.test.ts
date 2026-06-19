/**
 * env-storage.test.ts — NodeStorage policy enforcement.
 *
 * Trusted-root scoping, path-traversal rejection, read-cache
 * behavior, and the rest of IStorage's contract. The Storage class
 * is lifted from lens-desktop's LocalStorage and is shared across
 * the Unix, Docker, and Lambda envs, so these tests exercise
 * properties every Node-backed env will depend on.
 */

import { NodeStorage } from '@console-one/sequenceutils/transport';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';

describe('NodeStorage', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `node-storage-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });

  test('write then read round-trips UTF-8 content', async () => {
    const s = new NodeStorage(root);
    await s.write('hello.txt', 'world');
    expect(await s.read('hello.txt')).toBe('world');
  });

  test('write creates parent directories automatically', async () => {
    const s = new NodeStorage(root);
    await s.write('a/b/c/deep.txt', 'content');
    expect(existsSync(join(root, 'a/b/c/deep.txt'))).toBe(true);
  });

  test('has/exists return true for written files, false for missing', async () => {
    const s = new NodeStorage(root);
    await s.write('present.txt', 'yes');
    expect(await s.has('present.txt')).toBe(true);
    expect(await s.exists('present.txt')).toBe(true);
    expect(await s.has('missing.txt')).toBe(false);
    expect(await s.exists('missing.txt')).toBe(false);
  });

  test('delete removes a file and clears the cache entry', async () => {
    const s = new NodeStorage(root);
    await s.write('temp.txt', 'data');
    await s.read('temp.txt'); // warm the cache
    await s.delete('temp.txt');
    expect(await s.has('temp.txt')).toBe(false);
    await expect(s.read('temp.txt')).rejects.toThrow();
  });

  test('list returns keys relative to the prefix', async () => {
    const s = new NodeStorage(root);
    await s.write('docs/a.md', 'a');
    await s.write('docs/b.md', 'b');
    await s.write('docs/c.md', 'c');
    const keys = await s.list('docs');
    expect(keys.sort()).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md']);
  });

  test('list returns an empty array when the directory is missing', async () => {
    const s = new NodeStorage(root);
    const keys = await s.list('does/not/exist');
    expect(keys).toEqual([]);
  });

  test('append concatenates to an existing file', async () => {
    const s = new NodeStorage(root);
    await s.write('log.txt', 'line 1\n');
    await s.append('log.txt', 'line 2\n');
    expect(await s.read('log.txt')).toBe('line 1\nline 2\n');
  });

  test('mkdir creates directories recursively', async () => {
    const s = new NodeStorage(root);
    await s.mkdir('a/b/c');
    expect(existsSync(join(root, 'a/b/c'))).toBe(true);
  });

  test('trusted root: path traversal with .. throws', async () => {
    const s = new NodeStorage(root);
    await expect(s.read('../../../etc/passwd')).rejects.toThrow(/path traversal/);
    await expect(s.write('../escape.txt', 'x')).rejects.toThrow(/path traversal/);
    await expect(s.delete('../etc/passwd')).rejects.toThrow(/path traversal/);
  });

  test('trusted root: absolute paths stay within root', async () => {
    // `join(root, '/abs/path')` on POSIX yields `root/abs/path`, not
    // `/abs/path` — so this is a safe write inside the root.
    const s = new NodeStorage(root);
    await s.write('/nested/leading-slash.txt', 'ok');
    expect(existsSync(join(root, 'nested', 'leading-slash.txt'))).toBe(true);
  });

  test('read-cache: second read is served from cache, not disk', async () => {
    const s = new NodeStorage(root);
    await s.write('cached.txt', 'first');
    expect(await s.read('cached.txt')).toBe('first');

    // Mutate the file OUTSIDE the storage class — cache still returns
    // the first value because nothing has invalidated it. This is the
    // intentional hot-file caching policy.
    writeFileSync(join(root, 'cached.txt'), 'second');
    expect(await s.read('cached.txt')).toBe('first');

    // Explicit cache clear surfaces the new value on the next read.
    s.clearCache('cached.txt');
    expect(await s.read('cached.txt')).toBe('second');
  });

  test('read-cache: write invalidates by replacement, read returns new value', async () => {
    const s = new NodeStorage(root);
    await s.write('mutable.txt', 'v1');
    expect(await s.read('mutable.txt')).toBe('v1');
    await s.write('mutable.txt', 'v2');
    expect(await s.read('mutable.txt')).toBe('v2');
  });

  test('read-cache: external delete drops the stale entry on next read', async () => {
    const s = new NodeStorage(root);
    await s.write('ephemeral.txt', 'once');
    await s.read('ephemeral.txt'); // warm cache
    rmSync(join(root, 'ephemeral.txt'));
    // The cache entry is dropped because the stat fails; the next
    // read attempt falls through to fs.readFile, which also fails.
    await expect(s.read('ephemeral.txt')).rejects.toThrow();
  });

  test('root getter returns the constructor-supplied trusted root', () => {
    const s = new NodeStorage(root);
    expect(s.root).toBe(root);
  });
});
