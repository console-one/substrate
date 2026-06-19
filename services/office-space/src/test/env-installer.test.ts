/**
 * env-installer.test.ts — Kit installer end-to-end.
 *
 * Validation, install + list + uninstall, three source kinds
 * (ftInline, ft via storage, url via fetch), and the path that
 * records `_kits.{id}` as type state. Module source kind is
 * exercised separately from the test file since dynamic import
 * in Jest needs a real module path.
 */

import { Sequence } from '@console-one/sequence';
import {
  KitInstaller,
  NodeKitResolver,
  validateKitManifest,
  KitValidationError,
  type KitManifest,
  type KitResolver,
} from '../env/installer';
import { NodeStorage } from '@console-one/sequenceutils/transport';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, mkdirSync } from 'fs';

describe('kit installer — validation', () => {
  test('rejects missing id', () => {
    expect(() => validateKitManifest({ version: '1.0', provides: {}, source: { kind: 'ftInline', content: '--' } }))
      .toThrow(KitValidationError);
  });

  test('rejects missing version', () => {
    expect(() => validateKitManifest({ id: 'k', provides: {}, source: { kind: 'ftInline', content: '--' } }))
      .toThrow(KitValidationError);
  });

  test('rejects unknown source kind', () => {
    expect(() => validateKitManifest({
      id: 'k', version: '1', provides: {}, source: { kind: 'nope' },
    })).toThrow(KitValidationError);
  });

  test('rejects ftInline with empty content', () => {
    expect(() => validateKitManifest({
      id: 'k', version: '1', provides: {}, source: { kind: 'ftInline', content: '' },
    })).toThrow(KitValidationError);
  });

  test('accepts a well-formed manifest', () => {
    const m = validateKitManifest({
      id: 'taskqueue',
      version: '0.1.0',
      description: 'basic task queue',
      provides: { classes: ['Task'], tools: ['tasks.create'] },
      source: { kind: 'ftInline', content: 'tasks.seeded = true' },
    });
    expect(m.id).toBe('taskqueue');
    expect(m.source.kind).toBe('ftInline');
  });
});

describe('kit installer — ftInline source', () => {
  function makeInstaller(): KitInstaller {
    // ftInline doesn't need any resolver dependencies, but the
    // constructor demands a KitResolver — stub one that throws
    // on every method so we notice if dispatch slips.
    const stub: KitResolver = {
      readFt: async () => { throw new Error('readFt unexpected for ftInline'); },
      fetchUrl: async () => { throw new Error('fetchUrl unexpected for ftInline'); },
      loadModule: async () => { throw new Error('loadModule unexpected for ftInline'); },
    };
    return new KitInstaller(stub);
  }

  test('installs inline ft text, mounts the content, records _kits.{id}', async () => {
    const seq = new Sequence();
    const installer = makeInstaller();

    const manifest: KitManifest = {
      id: 'hello',
      version: '1.0.0',
      provides: {},
      source: { kind: 'ftInline', content: 'greeting = "hi"\nmood = "peaceful"' },
    };
    const result = await installer.install(seq, manifest);

    expect(result.ok).toBe(true);
    expect(result.id).toBe('hello');
    expect(result.mountCount).toBeGreaterThan(0);

    // The content landed
    expect(seq.get('greeting')).toBe('hi');
    expect(seq.get('mood')).toBe('peaceful');

    // The installation record landed
    expect(seq.get('_kits.hello.id')).toBe('hello');
    expect(seq.get('_kits.hello.version')).toBe('1.0.0');
    expect(typeof seq.get('_kits.hello.installedAt')).toBe('number');
    expect(seq.get('_kits.hello.source.kind')).toBe('ftInline');
  });

  test('installed kit shows up in list()', async () => {
    const seq = new Sequence();
    const installer = makeInstaller();
    await installer.install(seq, {
      id: 'k1', version: '1', provides: {}, source: { kind: 'ftInline', content: 'a = 1' },
      description: 'first kit',
    });
    await installer.install(seq, {
      id: 'k2', version: '2', provides: {}, source: { kind: 'ftInline', content: 'b = 2' },
    });

    const installed = installer.list(seq);
    expect(installed.length).toBe(2);
    const ids = installed.map((k) => k.id).sort();
    expect(ids).toEqual(['k1', 'k2']);
    const k1 = installed.find((k) => k.id === 'k1')!;
    expect(k1.version).toBe('1');
    expect(k1.description).toBe('first kit');
  });

  test('uninstall drops the kit from list()', async () => {
    const seq = new Sequence();
    const installer = makeInstaller();
    await installer.install(seq, {
      id: 'removable', version: '1', provides: {}, source: { kind: 'ftInline', content: 'x = 1' },
    });
    expect(installer.list(seq).length).toBe(1);

    await installer.uninstall(seq, 'removable');
    expect(installer.list(seq).length).toBe(0);
    expect(seq.get('_kits.removable.id')).toBeUndefined();
  });

  test('install failure does not record the kit', async () => {
    const seq = new Sequence();
    const installer = makeInstaller();
    // Invalid ft syntax will throw inside receive().
    const result = await installer.install(seq, {
      id: 'broken', version: '1', provides: {}, source: { kind: 'ftInline', content: 'invalid :: syntax :: here' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(seq.get('_kits.broken.id')).toBeUndefined();
  });
});

describe('kit installer — ft source via NodeStorage', () => {
  let root: string;
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });

  test('reads an ft file from storage and mounts its contents', async () => {
    root = join(tmpdir(), `installer-ft-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const storage = new NodeStorage(root);
    await storage.write('kits/taskqueue.ft', `
task.seed = "hello"
task.count = 0
`);

    const seq = new Sequence();
    const installer = new KitInstaller(new NodeKitResolver(storage));
    const result = await installer.install(seq, {
      id: 'taskqueue',
      version: '0.1',
      provides: { classes: ['Task'] },
      source: { kind: 'ft', storageKey: 'kits/taskqueue.ft' },
    });

    expect(result.ok).toBe(true);
    expect(seq.get('task.seed')).toBe('hello');
    expect(seq.get('task.count')).toBe(0);
    expect(seq.get('_kits.taskqueue.source.kind')).toBe('ft');
  });

  test('missing ft source reports install failure with the storage error', async () => {
    root = join(tmpdir(), `installer-miss-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const storage = new NodeStorage(root);
    const seq = new Sequence();
    const installer = new KitInstaller(new NodeKitResolver(storage));
    const result = await installer.install(seq, {
      id: 'ghost',
      version: '1',
      provides: {},
      source: { kind: 'ft', storageKey: 'does-not-exist.ft' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(seq.get('_kits.ghost.id')).toBeUndefined();
  });

  test('path-traversal in storageKey is rejected by NodeStorage', async () => {
    root = join(tmpdir(), `installer-trav-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const storage = new NodeStorage(root);
    const seq = new Sequence();
    const installer = new KitInstaller(new NodeKitResolver(storage));
    const result = await installer.install(seq, {
      id: 'sneak',
      version: '1',
      provides: {},
      source: { kind: 'ft', storageKey: '../../../etc/passwd' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/path traversal/);
  });
});

describe('kit installer — url source with stub fetchUrl', () => {
  test('fetched body is mounted', async () => {
    const resolver: KitResolver = {
      readFt: async () => { throw new Error('no'); },
      fetchUrl: async (url) => `remote.fetched = "${url}"`,
      loadModule: async () => { throw new Error('no'); },
    };
    const seq = new Sequence();
    const installer = new KitInstaller(resolver);
    const result = await installer.install(seq, {
      id: 'remote',
      version: '1',
      provides: {},
      source: { kind: 'url', url: 'https://example.com/kit.ft' },
    });
    expect(result.ok).toBe(true);
    expect(seq.get('remote.fetched')).toBe('https://example.com/kit.ft');
  });

  test('url fetch failure records install error, no _kits record', async () => {
    const resolver: KitResolver = {
      readFt: async () => { throw new Error('no'); },
      fetchUrl: async () => { throw new Error('connection refused'); },
      loadModule: async () => { throw new Error('no'); },
    };
    const seq = new Sequence();
    const installer = new KitInstaller(resolver);
    const result = await installer.install(seq, {
      id: 'offline',
      version: '1',
      provides: {},
      source: { kind: 'url', url: 'https://unreachable.test/' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/connection refused/);
    expect(seq.get('_kits.offline.id')).toBeUndefined();
  });
});
