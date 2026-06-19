/**
 * session-token.test.ts — Session auth token primitive.
 *
 * First landing site for the typed-authority pattern. Tests cover:
 *   - round-trip mint → validate returns the asserted user
 *   - forged signature rejected (any tamper breaks it)
 *   - expired token rejected (expiry is enforced independent of sig)
 *   - malformed input rejected without throwing
 *   - tokens for different users are distinguishable
 *   - partitionOf on the secret schema reports 'id' (type-declared)
 *   - tool wiring — mintSessionToken / validateSessionToken mounted
 *     as fn-typed schemas with local impls via registerAuthCaps
 *
 * Not tested here (follow-up commit): integration into server's
 * connect handshake. These tests exercise the primitive standalone.
 */

import { Sequence, partitionOf } from '@console-one/sequence';
import {
  mintSessionToken,
  validateSessionToken,
  generateTokenSecret,
  registerAuthCaps,
  type SessionToken,
} from '@console-one/sequenceutils/transport';

describe('session token — mint/validate primitive', () => {
  const secret = 'deadbeef'.repeat(16); // 128-char hex, fixed for reproducibility
  const now = 1_700_000_000_000;
  const oneHour = 60 * 60 * 1000;

  test('mint → validate round-trips the user identity', () => {
    const token = mintSessionToken('alice', now + oneHour, secret);
    const result = validateSessionToken(token, secret, now);
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.user).toBe('alice');
      expect(result.expiresAt).toBe(now + oneHour);
    }
  });

  test('tampered user field breaks the signature', () => {
    const token = mintSessionToken('alice', now + oneHour, secret);
    const forged: SessionToken = { ...token, user: 'mallory' };
    const result = validateSessionToken(forged, secret, now);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('signature_mismatch');
  });

  test('tampered expiresAt field breaks the signature', () => {
    const token = mintSessionToken('alice', now + oneHour, secret);
    const forged: SessionToken = { ...token, expiresAt: now + 100 * oneHour };
    const result = validateSessionToken(forged, secret, now);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('signature_mismatch');
  });

  test('expired token rejected even with valid signature', () => {
    const token = mintSessionToken('alice', now - 1, secret);  // already expired
    const result = validateSessionToken(token, secret, now);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('expired');
  });

  test('token minted with a different secret fails validation', () => {
    const token = mintSessionToken('alice', now + oneHour, secret);
    const wrongSecret = 'cafebabe'.repeat(16);
    const result = validateSessionToken(token, wrongSecret, now);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('signature_mismatch');
  });

  test('malformed inputs rejected without throwing', () => {
    for (const bad of [null, undefined, 'string', 42, [], {}, { user: 'alice' }]) {
      const result = validateSessionToken(bad, secret, now);
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.reason).toBe('malformed');
    }
  });

  test('tokens for different users are distinguishable', () => {
    const a = mintSessionToken('alice', now + oneHour, secret);
    const b = mintSessionToken('bob', now + oneHour, secret);
    expect(a.signature).not.toBe(b.signature);
    const ra = validateSessionToken(a, secret, now);
    const rb = validateSessionToken(b, secret, now);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    if (ra.ok === true) expect(ra.user).toBe('alice');
    if (rb.ok === true) expect(rb.user).toBe('bob');
  });

  test('swapping signatures between users is rejected', () => {
    const a = mintSessionToken('alice', now + oneHour, secret);
    const b = mintSessionToken('bob', now + oneHour, secret);
    const swapped: SessionToken = { ...a, signature: b.signature };
    const result = validateSessionToken(swapped, secret, now);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('signature_mismatch');
  });

  test('empty user or non-finite expiresAt rejected at mint time', () => {
    expect(() => mintSessionToken('', now + oneHour, secret)).toThrow(/non-empty/);
    expect(() => mintSessionToken('alice', NaN, secret)).toThrow(/finite/);
    expect(() => mintSessionToken('alice', Infinity, secret)).toThrow(/finite/);
  });

  test('generateTokenSecret produces a non-trivial secret', () => {
    const s1 = generateTokenSecret();
    const s2 = generateTokenSecret();
    expect(s1.length).toBeGreaterThan(32);
    expect(s1).not.toBe(s2);  // 2^512 collision probability
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tool wiring — registerAuthCaps
// ═══════════════════════════════════════════════════════════════════════

describe('session token — registerAuthCaps', () => {
  const now = 1_700_000_000_000;
  const oneHour = 60 * 60 * 1000;

  test('mounts id.server.token_secret with partition(id) declared', () => {
    const seq = new Sequence(() => now);
    const { secret } = registerAuthCaps(seq, { secret: 'testsecret'.repeat(8) });
    expect(seq.get('id.server.token_secret')).toBe(secret);
    const schema = seq.typeAt('id.server.token_secret');
    // The type-aware partitionOf from f172ebb reports id for this
    // path because the schema declares partition('id').
    expect(partitionOf('id.server.token_secret', schema)).toBe('id');
  });

  test('mints a token via the auth.mintSessionToken tool', () => {
    const seq = new Sequence(() => now);
    registerAuthCaps(seq, { secret: 'testsecret'.repeat(8) });
    // Invoke the mint tool by binding an input to its fn-typed path.
    // Phase A of the tool-op collapse made bind-with-non-function
    // on an fn schema invoke the registered impl.
    seq.mount('bind', 'auth.mintSessionToken', { user: 'alice', expiresAt: now + oneHour });
    const token = seq.get('auth.mintSessionToken.result') as SessionToken;
    expect(token).toBeDefined();
    expect(token.user).toBe('alice');
    expect(token.expiresAt).toBe(now + oneHour);
    expect(typeof token.signature).toBe('string');
  });

  test('validates a token via the auth.validateSessionToken tool', () => {
    const seq = new Sequence(() => now);
    const { secret } = registerAuthCaps(seq, { secret: 'testsecret'.repeat(8) });
    const token = mintSessionToken('alice', now + oneHour, secret);
    seq.mount('bind', 'auth.validateSessionToken', { token });
    const result = seq.get('auth.validateSessionToken.result') as any;
    expect(result.ok).toBe(true);
    expect(result.user).toBe('alice');
  });

  test('mint via tool and validate via tool round-trip end-to-end', () => {
    const seq = new Sequence(() => now);
    registerAuthCaps(seq, { secret: 'testsecret'.repeat(8) });

    seq.mount('bind', 'auth.mintSessionToken', { user: 'bob', expiresAt: now + oneHour });
    const token = seq.get('auth.mintSessionToken.result');

    seq.mount('bind', 'auth.validateSessionToken', { token });
    const result = seq.get('auth.validateSessionToken.result') as any;
    expect(result.ok).toBe(true);
    expect(result.user).toBe('bob');
  });

  test('validate via tool rejects a forged token', () => {
    const seq = new Sequence(() => now);
    const { secret } = registerAuthCaps(seq, { secret: 'testsecret'.repeat(8) });
    const token = mintSessionToken('alice', now + oneHour, secret);
    const forged = { ...token, user: 'mallory' };
    seq.mount('bind', 'auth.validateSessionToken', { token: forged });
    const result = seq.get('auth.validateSessionToken.result') as any;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  test('omitting config.secret generates a random secret at registration', () => {
    const a = new Sequence(() => now);
    const b = new Sequence(() => now);
    const { secret: secretA } = registerAuthCaps(a);
    const { secret: secretB } = registerAuthCaps(b);
    expect(secretA).not.toBe(secretB);
    // Tokens from A must NOT validate against B's secret.
    const tokenFromA = mintSessionToken('alice', now + oneHour, secretA);
    const result = validateSessionToken(tokenFromA, secretB, now);
    expect(result.ok).toBe(false);
  });
});
