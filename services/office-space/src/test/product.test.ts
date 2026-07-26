import { ContextGraphServer } from '../office-space-server.js';
import { OfficeSpaceClient } from '../v2/client.js';
import type { Sequence } from '@console-one/sequence/v2';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Re-expressed on the v2 transport — deletion-ledger stage 4.

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cg-test-'));
  return join(dir, 'test.db');
}

/** Poll until `fn` returns truthy (the transport applies async). */
async function until<T>(fn: () => T, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function createClient(port: number): Promise<{
  send: (ft: string) => void;
  waitForRender: (match?: string, timeout?: number) => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const messages: string[] = [];
    ws.on('message', (raw: any) => messages.push(raw.toString()));
    ws.on('open', () => resolve({
      send: (ft: string) => ws.send(ft),
      waitForRender: (match?: string, timeout = 5000) =>
        until(() => messages.find((t) => !match || t.includes(match)), timeout),
      close: () => ws.close(),
    }));
    ws.on('error', reject);
  });
}

describe('Context Graph — boot() environment model', () => {
  let server: ContextGraphServer;
  let port: number;
  let dbPath: string;

  // v2 has no bootstrap.ft — the v1 constitution parsed a file at boot;
  // v2 installs rules-as-data and lets the product register its own
  // fixture facts. `org.name` / `workspace` are the boot-state this
  // suite's "bootstrap tools" test asserts, provided explicitly here
  // (ENGINE-GAP-MAP rule: needs new code per case bypassed abstraction —
  // this is the ONE fixture, not a shadow bootstrap file).
  const registerFixture = (seq: Sequence): void => {
    seq.insert({ path: 'org.name', value: 'Acme Ltd' });
    seq.insert({ path: 'workspace', value: 'main' });
  };

  beforeEach(async () => {
    dbPath = tmpDb();
    server = new ContextGraphServer({ port: 0, dbPath, register: registerFixture });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    try { rmSync(dbPath, { force: true }); } catch {}
  });

  test('server renders bootstrap tools on connect', async () => {
    const c = await createClient(port);
    const initial = await c.waitForRender('workspace');
    expect(initial).toContain('org.name');
    expect(initial).toContain('workspace');
    c.close();
  });

  test('client writes ft text, server state updates and renders back', async () => {
    const c = await createClient(port);
    await c.waitForRender('workspace');

    c.send('hello = "world"');
    const after = await c.waitForRender('hello');
    expect(after).toContain('hello');
    expect(after).toContain('world');
    c.close();
  });

  test('state persists across server restart', async () => {
    const c1 = await createClient(port);
    await c1.waitForRender('workspace');

    c1.send('persistent.data = "survives restart"');
    await c1.waitForRender('survives restart');
    c1.close();

    // Stop and restart server with same dbPath — the journal (the ft
    // delta log, per-partition) replays before the socket reopens.
    await server.stop();
    server = new ContextGraphServer({ port: 0, dbPath, register: registerFixture });
    port = await server.start();

    // Real assertion (v2 gives direct kernel access, unlike the v1
    // test's punted "at least boots clean" comment): the persisted
    // value is actually there post-restart.
    expect(server.seq!.get('persistent.data')).toBe('survives restart');

    const c2 = await createClient(port);
    const view = await c2.waitForRender('workspace');
    expect(view).toContain('workspace');
    c2.close();
  });

  test('two clients see each other\'s edits', async () => {
    const c1 = await createClient(port);
    const c2 = await createClient(port);
    await c1.waitForRender('workspace');
    await c2.waitForRender('workspace');

    // Client 1 writes
    c1.send('shared.note = "from client 1"');
    await c1.waitForRender('from client 1');

    // Client 2 should receive the broadcast
    const c2view = await c2.waitForRender('from client 1');
    expect(c2view).toContain('shared.note');

    c1.close();
    c2.close();
  });

  test('multiple clients write concurrently to the same Sequence', async () => {
    // v2 installs no domain schema by default (no bootstrap.ft to
    // declare a taskqueue type) — tasks.* accepts any value the same
    // way `hello = "world"` above does. The field/value shapes below
    // are kept as-is (they mirror the product's real usage) even
    // though nothing here can reject an out-of-shape write anymore.
    const c1 = await createClient(port);
    const c2 = await createClient(port);
    await c1.waitForRender('workspace');
    await c2.waitForRender('workspace');

    c1.send('tasks.alice.input = "review code"\ntasks.alice.status = "pending"');
    c2.send('tasks.bob.input = "write tests"\ntasks.bob.status = "pending"');

    const r1 = await c1.waitForRender('review code');
    const r2 = await c2.waitForRender('write tests');
    expect(r1).toContain('tasks.alice');
    expect(r2).toContain('tasks.bob');

    c1.close();
    c2.close();
  });

  test('typed collection: task fields are present in render', async () => {
    const c = await createClient(port);
    await c.waitForRender('workspace');

    c.send('tasks.t1.input = "Ship v1"');
    const r1 = await c.waitForRender('Ship v1');
    expect(r1).toContain('tasks.t1.input');

    c.send('tasks.t1.status = "active"');
    const r2 = await c.waitForRender('active');
    expect(r2).toContain('tasks.t1.status');

    c.send('tasks.t1.assignee = "alice"');
    const r3 = await c.waitForRender('alice');
    expect(r3).toContain('tasks.t1.assignee');

    c.close();
  });

  test('two clients share typed task data', async () => {
    const c1 = await createClient(port);
    const c2 = await createClient(port);
    await c1.waitForRender('workspace');
    await c2.waitForRender('workspace');

    // Client 1 creates a task
    c1.send('tasks.deploy.title = "Deploy to prod"');
    c1.send('tasks.deploy.status = "open"');
    c1.send('tasks.deploy.assignee = "bob"');
    await c1.waitForRender('bob');

    // Client 2 should see it
    const c2view = await c2.waitForRender('Deploy to prod');
    expect(c2view).toContain('tasks.deploy.title');
    expect(c2view).toContain('Deploy to prod');

    // Client 2 updates the status
    c2.send('tasks.deploy.status = "done"');
    await c2.waitForRender('done');

    // Client 1 sees the update
    const c1view = await c1.waitForRender('done');
    expect(c1view).toContain('done');

    c1.close();
    c2.close();
  });

  test('schedule and memory collections work alongside tasks', async () => {
    const c = await createClient(port);
    await c.waitForRender('workspace');

    c.send('schedule.standup.time = "09:00"');
    c.send('schedule.standup.event = "Daily standup"');
    const schedView = await c.waitForRender('Daily standup');
    expect(schedView).toContain('schedule.standup');

    c.send('memory.arch.topic = "database"');
    c.send('memory.arch.content = "Use SQLite for local persistence"');
    const memView = await c.waitForRender('SQLite');
    expect(memView).toContain('memory.arch');

    c.close();
  });

  test('session mounts via direct path', async () => {
    const c = await createClient(port);
    await c.waitForRender('workspace');

    // Mount a session at a concrete path
    c.send('sessions.alice.user = "alice"');
    c.send('sessions.alice.env = "browser"');
    const view = await c.waitForRender('alice');
    expect(view).toContain('sessions.alice');

    c.close();
  });

  test('two envs see each other through the workspace', async () => {
    const human = await createClient(port);
    const agent = await createClient(port);
    await human.waitForRender('workspace');
    await agent.waitForRender('workspace');

    // Human creates a task
    human.send('tasks.deploy.title = "Ship v2"');
    human.send('tasks.deploy.status = "open"');
    await human.waitForRender('Ship v2');

    // Agent sees it
    const agentView = await agent.waitForRender('Ship v2');
    expect(agentView).toContain('tasks.deploy');

    // Agent fills the task
    agent.send('tasks.deploy.status = "done"');
    await agent.waitForRender('done');

    // Human sees the agent's update
    const humanView = await human.waitForRender('done');
    expect(humanView).toContain('done');

    human.close();
    agent.close();
  });

  test('offline client buffers and syncs on connect', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'os-test-'));

    const client = new OfficeSpaceClient({
      dataDir,
      serverUrl: `ws://localhost:${port}`,
      user: 'offline-test',
      env: 'test',
      heartbeatMs: 60000,
    });

    // Mount locally while disconnected — v2's mount() applies to the
    // client's own kernel first (always local), then sends or buffers.
    await client.mount('local.note = "written offline"');
    expect(client.get('local.note')).toBe('written offline');

    // Boot connects and syncs
    await client.boot();

    // Verify the server received the buffered mount
    const c = await createClient(port);
    const view = await c.waitForRender('written offline');
    expect(view).toContain('local.note');

    c.close();
    client.shutdown();

    try { rmSync(dataDir, { recursive: true }); } catch {}
  });

  test('permanent agent runs execution cycle and reports results', async () => {
    const { PermanentAgent } = await import('../agent.js');
    const agent = new PermanentAgent({
      agentId: 'agent_smith',
      serverUrl: `ws://localhost:${port}`,
      dataDir: mkdtempSync(join(tmpdir(), 'agent-test-')),
    });
    const result = await agent.run();
    expect(['complete', 'longwait']).toContain(result.stopReason);
    expect(result.gapsFilled).toBe(0); // no tools registered
    // The agent's state was pushed to the server like any session's.
    await until(() => server.seq!.getCell('agents.agent_smith.lastRun')?.value);
    expect(server.seq!.getCell('agents.agent_smith.stopReason')?.value).toBe(result.stopReason);
  });

  test('reader contract mounts as observable state', async () => {
    const c = await createClient(port);
    await c.waitForRender('workspace');

    c.send('readers.panel.source = "tasks.*"');
    const view = await c.waitForRender('tasks.*');
    expect(view).toContain('readers.panel.source');

    c.close();
  });
});
