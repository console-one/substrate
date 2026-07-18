/**
 * fs-stub.ts — Browser-bundle stub for Node `fs`.
 *
 * Two import shapes have to resolve at bundle time:
 *   - NAMED (`import { readFileSync } from 'fs'`) — the sequenceutils
 *     client's Node-default snapshot path. Never taken in the browser:
 *     the caller always injects an `IStorage` (BrowserStorage).
 *   - DEFAULT (`import nodeFs from 'fs'`) — @console-one/sequence/v2
 *     env/storage.ts (NodeStorage), which defers every property access
 *     to call time. The browser never constructs a NodeStorage.
 *
 * Any call through this stub means an injection went wrong; throw
 * loudly rather than silently faking filesystem behavior.
 */

function notAvailable(name: string): never {
  throw new Error(
    `fs.${name}: not available in the browser. ` +
    `This code path should be unreachable — pass an IStorage (BrowserStorage).`,
  );
}

export function readFileSync(_path: unknown, _enc?: unknown): string {
  return notAvailable('readFileSync');
}
export function writeFileSync(_path: unknown, _data: unknown): void {
  return notAvailable('writeFileSync');
}
export function existsSync(_path: unknown): boolean {
  // Returning `false` keeps `if (existsSync(dir)) mkdirSync(dir)` dead
  // without throwing on entry.
  return false;
}
export function mkdirSync(_path: unknown, _opts?: unknown): void {
  return notAvailable('mkdirSync');
}

/** Named `promises` for `import { promises } from 'fs'` (the
 *  sequenceutils NodeStorage) — throws on any method access. */
export const promises = new Proxy(
  {},
  {
    get(_t, prop) {
      return notAvailable(`promises.${String(prop)}`);
    },
  },
);

/** Default export for `import nodeFs from 'fs'` consumers — every
 *  property access throws (mirrors vite's node-builtin stub). */
export default new Proxy(
  {},
  {
    get(_t, prop) {
      return notAvailable(String(prop));
    },
  },
);
