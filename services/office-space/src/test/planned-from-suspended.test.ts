/**
 * planned-from-suspended.test.ts — `planned()` reads suspended blocks,
 * not a `.fireAt` sidecar field.
 *
 * The substrate's own future-event primitive is a block with a `where`
 * clause containing `gt('_rt', T)`. The block sits in `seq.suspended()`
 * until the kernel's clock advances past T, at which point the
 * conjunction becomes true and the cascade resumes the block. THAT is
 * the firing.
 *
 * `client.planned()` was originally implemented as a leaf-walk for
 * paths ending in `.fireAt` — a parallel convention that ignored what
 * the substrate already named. This test documents the corrected
 * behavior: planned() queries suspended blocks directly.
 */

import { OfficeSpaceClient } from '@console-one/sequenceutils/transport';
import { Sequence } from '@console-one/sequence';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

describe('planned() reads suspended blocks (substrate-native)', () => {
  let dataDir: string;
  let client: OfficeSpaceClient;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'planned-'));
    // Inject a pre-constructed Sequence + a no-op WebSocket so the
    // client never touches the network. The substrate behavior is
    // entirely local; planned() is a read over seq.suspended().
    const noopWs: any = function () {
      return {
        addEventListener: () => {},
        removeEventListener: () => {},
        send: () => {},
        close: () => {},
        readyState: 0,
      };
    };
    client = new OfficeSpaceClient({
      user: 'alice',
      env: 'test',
      serverUrl: 'ws://localhost:0',
      dataDir,
      seq: new Sequence(),
      transport: noopWs,
    });
  });

  afterEach(async () => {
    client.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('mountBlock with where:gt(_rt,T) appears in planned()', () => {
    const future = Date.now() + 60_000;
    client.mountBlock({
      entries: [{ op: 'bind', path: 'tasks.standup.status', value: 'happening' }],
      where: [{ op: 'gt', args: ['_rt', future] }],
    });

    const planned = client.planned();
    expect(planned).toHaveLength(1);
    expect(planned[0].path).toBe('tasks.standup.status');
    expect(planned[0].fireAt).toBe(future);
    expect(planned[0].msUntil).toBeGreaterThan(0);
  });

  test('past-fireAt blocks are not surfaced (already resumed)', () => {
    const past = Date.now() - 60_000;
    // A past `_rt > T` admits immediately, so the block isn't
    // suspended — it applies directly. planned() shows nothing.
    client.mountBlock({
      entries: [{ op: 'bind', path: 'tasks.expired.status', value: 'done' }],
      where: [{ op: 'gt', args: ['_rt', past] }],
    });
    expect(client.planned()).toHaveLength(0);
  });

  test('multiple suspended blocks sort by fireAt ascending', () => {
    const t1 = Date.now() + 30_000;
    const t2 = Date.now() + 60_000;
    const t3 = Date.now() + 90_000;
    client.mountBlock({
      entries: [{ op: 'bind', path: 'b.b.status', value: 'on' }],
      where: [{ op: 'gt', args: ['_rt', t2] }],
    });
    client.mountBlock({
      entries: [{ op: 'bind', path: 'b.c.status', value: 'on' }],
      where: [{ op: 'gt', args: ['_rt', t3] }],
    });
    client.mountBlock({
      entries: [{ op: 'bind', path: 'b.a.status', value: 'on' }],
      where: [{ op: 'gt', args: ['_rt', t1] }],
    });

    const planned = client.planned();
    expect(planned.map(p => p.fireAt)).toEqual([t1, t2, t3]);
    expect(planned.map(p => p.path)).toEqual(['b.a.status', 'b.b.status', 'b.c.status']);
  });

  test('scopePrefix filters by primary entry path', () => {
    const future = Date.now() + 60_000;
    client.mountBlock({
      entries: [{ op: 'bind', path: 'tasks.alice.status', value: 'on' }],
      where: [{ op: 'gt', args: ['_rt', future] }],
    });
    client.mountBlock({
      entries: [{ op: 'bind', path: 'tasks.bob.status', value: 'on' }],
      where: [{ op: 'gt', args: ['_rt', future + 1000] }],
    });

    expect(client.planned({ scopePrefix: 'tasks.alice' })).toHaveLength(1);
    expect(client.planned({ scopePrefix: 'tasks.bob' })).toHaveLength(1);
    expect(client.planned({ scopePrefix: 'tasks' })).toHaveLength(2);
    expect(client.planned({ scopePrefix: 'projects' })).toHaveLength(0);
  });

  test('NO .fireAt sidecar field is required — a path with .fireAt does NOT appear in planned()', () => {
    // Old convention: mount `<path>.fireAt = T` and expect planned()
    // to surface it. That's gone — a sidecar field is not a substrate
    // claim about future timing. Only suspended blocks count.
    const future = Date.now() + 60_000;
    client.mount(`tasks.bogus.title = "Has fireAt sidecar"\n` +
      `tasks.bogus.fireAt = ${future}`);
    expect(client.planned()).toHaveLength(0);
  });
});
