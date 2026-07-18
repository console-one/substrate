/**
 * http-stub.ts — Browser-bundle stub for Node `http`.
 *
 * The sequenceutils transport index re-exports ContextGraphServer,
 * which imports `createServer` from 'http'. The browser entry never
 * starts a server, but the import has to resolve at bundle time.
 */

export function createServer(_handler?: unknown): never {
  throw new Error(
    'http-stub: createServer is not available in the browser. ' +
    'The transport server only runs in Node.'
  );
}

export type Server = never;

export default { createServer };
