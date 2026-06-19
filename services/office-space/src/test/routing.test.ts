/**
 * routing.test.ts — Content-addressed session routing.
 *
 * Verifies the server records `sessions.{user}.holder = {identity}`
 * when a client mounts session state, and clears it on clean
 * disconnect. This is the routing table that downstream forwarding
 * (Stage 2+) will use to locate the live env holding each user's
 * session.
 */

import { ContextGraphServer } from '../office-space-server.js';
import WebSocket from 'ws';

async function connectAs(
  port: number,
  user: string,
  env: string,
): Promise<{ ws: WebSocket; messages: string[]; waitFor: (substr: string) => Promise<string> }> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const messages: string[] = [];
  const awaiters: { substr: string; resolve: (text: string) => void }[] = [];
  ws.on('message', (raw) => {
    const text = raw.toString();
    messages.push(text);
    for (let i = awaiters.length - 1; i >= 0; i--) {
      if (text.includes(awaiters[i].substr)) {
        awaiters[i].resolve(text);
        awaiters.splice(i, 1);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (e) => reject(e));
  });
  ws.send(
    `sessions.${user}.user = "${user}"\n` +
    `sessions.${user}.env = "${env}"\n` +
    `sessions.${user}.heartbeat = ${Date.now()}`
  );
  const waitFor = (substr: string): Promise<string> => {
    const already = messages.find(m => m.includes(substr));
    if (already) return Promise.resolve(already);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for "${substr}"`)), 3000);
      awaiters.push({
        substr,
        resolve: (text) => { clearTimeout(timer); resolve(text); },
      });
    });
  };
  return { ws, messages, waitFor };
}

describe('session routing table', () => {
  let server: ContextGraphServer;
  let port: number;

  beforeEach(async () => {
    server = new ContextGraphServer({ port: 0, dbPath: ':memory:' });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  test('first client to mount sessions.{user}.* becomes holder', async () => {
    const c = await connectAs(port, 'alice', 'unix');

    // Wait for the server to have processed our session mount and
    // recorded the holder. Tick once if needed to flush.
    await c.waitFor('sessions.alice.holder');

    const seq = server.seq!;
    const holder = seq.get('sessions.alice.holder') as string | undefined;
    expect(typeof holder).toBe('string');
    // Server generates ids of shape `c_{timestamp}_{suffix}` —
    // underscores (see server.ts clientId comment).
    expect(holder).toMatch(/^id\.sessions\.c_/);

    c.ws.close();
  });

  test('same client re-mounting does not change the holder', async () => {
    const c = await connectAs(port, 'alice', 'unix');
    await c.waitFor('sessions.alice.holder');

    const seq = server.seq!;
    const firstHolder = seq.get('sessions.alice.holder') as string;

    // Re-mount the session (simulates a heartbeat or state update).
    c.ws.send(`sessions.alice.heartbeat = ${Date.now()}`);
    await new Promise((r) => setTimeout(r, 50));

    const secondHolder = seq.get('sessions.alice.holder') as string;
    expect(secondHolder).toBe(firstHolder);

    c.ws.close();
  });

  test('clean disconnect revokes the session commitment and clears the holder', async () => {
    const c = await connectAs(port, 'alice', 'unix');
    await c.waitFor('sessions.alice.holder');

    const seq = server.seq!;
    expect(seq.get('sessions.alice.holder')).toBeTruthy();

    c.ws.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(seq.get('sessions.alice.holder')).toBeUndefined();
  });

  test('two clients with different users get independent holders', async () => {
    const a = await connectAs(port, 'alice', 'unix');
    const b = await connectAs(port, 'bob', 'lambda');
    await a.waitFor('sessions.alice.holder');
    await b.waitFor('sessions.bob.holder');

    const seq = server.seq!;
    const aliceHolder = seq.get('sessions.alice.holder') as string;
    const bobHolder = seq.get('sessions.bob.holder') as string;
    expect(typeof aliceHolder).toBe('string');
    expect(typeof bobHolder).toBe('string');
    expect(aliceHolder).not.toBe(bobHolder);

    a.ws.close();
    b.ws.close();
  });

  test('second client takes over an unheld session', async () => {
    const a = await connectAs(port, 'alice', 'unix');
    await a.waitFor('sessions.alice.holder');
    const seq = server.seq!;
    const firstHolder = seq.get('sessions.alice.holder') as string;

    a.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(seq.get('sessions.alice.holder')).toBeUndefined();

    const b = await connectAs(port, 'alice', 'unix');
    await b.waitFor('sessions.alice.holder');
    const secondHolder = seq.get('sessions.alice.holder') as string;
    expect(typeof secondHolder).toBe('string');
    expect(secondHolder).not.toBe(firstHolder);

    b.ws.close();
  });

  test('writer-authority: second client cannot write to an active session held by another', async () => {
    // Client A claims alice's session.
    const a = await connectAs(port, 'alice', 'unix');
    await a.waitFor('sessions.alice.holder');
    const seq = server.seq!;
    const aHolder = seq.get('sessions.alice.holder') as string;
    expect(typeof aHolder).toBe('string');

    // Client B tries to write to alice's session while A still holds.
    // B gets its own clientId (distinct from A's) and sends a mount
    // targeting sessions.alice.*. The admission law reads the current
    // holder, compares to B's author, and rejects since A still holds.
    const b = await connectAs(port, 'alice', 'unix');
    // B's mount has already gone through on connect — because the
    // server sends a welcome hoist, it completes the open handshake.
    // B's INITIAL session mount attempt happens in connectAs;
    // if the admission law rejects it, B's mount on the server seq
    // won't touch sessions.alice, and the holder stays A.
    await new Promise((r) => setTimeout(r, 200));

    const holderAfter = seq.get('sessions.alice.holder') as string;
    expect(holderAfter).toBe(aHolder);

    // B's own identity is still recorded (connection-level bookkeeping
    // under id.sessions.*), but sessions.alice.* writes from B were
    // gated by the writer-authority law.
    a.ws.close();
    b.ws.close();
  });
});
