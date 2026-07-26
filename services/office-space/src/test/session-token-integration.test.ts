/**
 * session-token-integration.test.ts — Session auth token wired
 * into the server's connect handshake.
 *
 * Spins up a real ContextGraphServer + real OfficeSpaceClient over
 * WebSocket. On session mount, the server mints a signed token
 * and writes it to `sessions.{user}.token`. These tests verify:
 *
 *   - Token lands at the expected path with the correct shape.
 *   - The token validates via `auth.validateSessionToken` using
 *     the same secret the server registered at start.
 *   - Tokens for different users are independent (no cross-leak).
 *   - Tampered token values fail validation through the tool.
 *   - Server restart with the same tokenSecret continues to
 *     validate tokens minted by the previous boot.
 *   - Server restart with a DIFFERENT tokenSecret invalidates
 *     prior tokens (the expected failure mode for rotation).
 *
 * Re-expressed on the v2 transport — deletion-ledger stage 4.
 */

import { ContextGraphServer } from '../office-space-server.js';
import { OfficeSpaceClient } from '../v2/client.js';
import { mintSessionToken, validateSessionToken, receiveCall, type SessionToken } from '@console-one/sequence/v2';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** Poll until `fn` returns truthy (the transport applies async). */
async function until<T>(fn: () => T, ms = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('session token — server integration', () => {
  const sharedSecret = 'integration-secret-'.repeat(4).slice(0, 64);
  let server: ContextGraphServer;
  let port: number;
  const tmpDirs: string[] = [];
  const clients: OfficeSpaceClient[] = [];

  beforeEach(async () => {
    server = new ContextGraphServer({
      port: 0,
      tokenSecret: sharedSecret,
    });
    port = await server.start();
  });

  afterEach(async () => {
    for (const c of clients) { try { c.shutdown(); } catch {} }
    clients.length = 0;
    await server.stop();
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

  function tempClient(user: string): OfficeSpaceClient {
    const dataDir = mkdtempSync(join(tmpdir(), `tok-int-${user}-`));
    tmpDirs.push(dataDir);
    const c = new OfficeSpaceClient({
      dataDir,
      serverUrl: `ws://localhost:${port}`,
      user,
      env: 'integration-test',
      heartbeatMs: 60_000,
    });
    clients.push(c);
    return c;
  }

  test('session mount produces a signed token at sessions.{user}.token', async () => {
    const client = tempClient('alice');
    await client.boot();

    const token = await until(() => server.seq!.get('sessions.alice.token')) as SessionToken;
    expect(token).toBeDefined();
    expect(token.user).toBe('alice');
    expect(typeof token.expiresAt).toBe('number');
    expect(typeof token.signature).toBe('string');
    // Signature is hex-encoded SHA256 output, should be 64 chars.
    expect(token.signature.length).toBe(64);
  });

  test('the minted token validates against the server secret', async () => {
    const client = tempClient('alice');
    await client.boot();

    const token = await until(() => server.seq!.get('sessions.alice.token')) as SessionToken;
    const result = validateSessionToken(token, sharedSecret);
    expect(result.ok).toBe(true);
    if (result.ok === true) expect(result.user).toBe('alice');
  });

  test('the minted token validates via the auth.validateSessionToken tool', async () => {
    const client = tempClient('alice');
    await client.boot();

    const token = await until(() => server.seq!.get('sessions.alice.token'));

    // v1 drove this through mount('bind', ...) + reading `.result`;
    // v2's call subset is receiveCall against seq.impls — the tool
    // path and I/O shape are unchanged (installAuthCaps wires
    // 'auth.validateSessionToken' to take { token } and return the
    // same AuthValidationResult shape validateSessionToken() does).
    const outcome = await receiveCall(server.seq!, 'auth.validateSessionToken', { token });
    const result = outcome.value as { ok: boolean; user?: string };
    expect(result.ok).toBe(true);
    expect(result.user).toBe('alice');
  });

  test('tokens for different users are independent and distinguishable', async () => {
    const alice = tempClient('alice');
    const bob = tempClient('bob');
    await Promise.all([alice.boot(), bob.boot()]);

    const aliceToken = await until(() => server.seq!.get('sessions.alice.token')) as SessionToken;
    const bobToken = await until(() => server.seq!.get('sessions.bob.token')) as SessionToken;

    expect(aliceToken.user).toBe('alice');
    expect(bobToken.user).toBe('bob');
    expect(aliceToken.signature).not.toBe(bobToken.signature);

    // Swapping signatures breaks both.
    const swappedA: SessionToken = { ...aliceToken, signature: bobToken.signature };
    const swappedB: SessionToken = { ...bobToken, signature: aliceToken.signature };
    expect(validateSessionToken(swappedA, sharedSecret).ok).toBe(false);
    expect(validateSessionToken(swappedB, sharedSecret).ok).toBe(false);
  });

  test('a tampered user field in the token is rejected by validation', async () => {
    const client = tempClient('alice');
    await client.boot();

    const token = await until(() => server.seq!.get('sessions.alice.token')) as SessionToken;
    const forged: SessionToken = { ...token, user: 'mallory' };
    const result = validateSessionToken(forged, sharedSecret);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('signature_mismatch');
  });

  test('a fresh server with the same secret validates tokens minted by the previous boot', async () => {
    // Mint via a token that a prior boot would have produced.
    const priorToken = mintSessionToken(
      'alice',
      Date.now() + 60 * 60 * 1000,
      sharedSecret,
    );

    // Current server (started with sharedSecret in beforeEach) should
    // accept the prior token — the secret is what matters, not the
    // process identity.
    const outcome = await receiveCall(server.seq!, 'auth.validateSessionToken', { token: priorToken });
    const result = outcome.value as { ok: boolean; user?: string };
    expect(result.ok).toBe(true);
    expect(result.user).toBe('alice');
  });

  test('a server with a different secret rejects tokens minted by the previous secret', async () => {
    const priorToken = mintSessionToken(
      'alice',
      Date.now() + 60 * 60 * 1000,
      sharedSecret,
    );

    // Start a fresh server with a different secret and verify it
    // rejects the prior token.
    const rotated = new ContextGraphServer({
      port: 0,
      tokenSecret: 'rotated-secret-'.repeat(4).slice(0, 64),
    });
    await rotated.start();
    try {
      const outcome = await receiveCall(rotated.seq!, 'auth.validateSessionToken', { token: priorToken });
      const result = outcome.value as { ok: boolean; reason?: string };
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('signature_mismatch');
    } finally {
      await rotated.stop();
    }
  });
});
