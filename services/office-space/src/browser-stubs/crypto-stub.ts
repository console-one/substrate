/**
 * crypto-stub.ts — Browser-bundle stub for Node `crypto`.
 *
 * @console-one/sequence/v2 stdlib and the sequenceutils auth module
 * reach `crypto` for HMAC session tokens (mint/validate/secret). In
 * the browser those run server-side only — the client receives already-
 * minted tokens as facts. Property access throws loudly.
 */

function notAvailable(name: string): never {
  throw new Error(
    `crypto.${name}: not available in the browser. ` +
    `Session tokens are minted and validated server-side.`,
  );
}

export function createHmac(_alg: unknown, _key: unknown): never {
  return notAvailable('createHmac');
}
export function randomBytes(_n: unknown): never {
  return notAvailable('randomBytes');
}
export function timingSafeEqual(_a: unknown, _b: unknown): never {
  return notAvailable('timingSafeEqual');
}

export default new Proxy(
  {},
  {
    get(_t, prop) {
      return notAvailable(String(prop));
    },
  },
);
