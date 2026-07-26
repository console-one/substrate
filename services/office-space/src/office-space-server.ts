/**
 * office-space-server.ts — the product's server entry point.
 *
 * Deletion-ledger STAGE 4: this module used to extend
 * `@console-one/sequenceutils/transport`'s v1-kernel ContextGraphServer,
 * pre-composing v1 policies/tools. The v2 server (src/v2/server.ts)
 * installs its own constitution from `@console-one/sequence/v2`
 * (writer authority, session lifecycle, holder release, auth caps,
 * base tools) — so the wrapper's whole job disappeared. This file
 * remains as the stable import path its consumers and tests use.
 */

export { ContextGraphServer } from './v2/server';
export type { ServerConfig, PriorSnapshot } from './v2/server';
