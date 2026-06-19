/**
 * browser-entry.ts — Window shim for the legacy ui.html.
 *
 * The actual API lives in ./api.ts (`OfficeSpaceAPI` + factory). This
 * file is just a backward-compat bridge that exposes the API as
 * `window.officeSpace` for the existing ui.html shell to consume.
 *
 * New UIs (external repos, React apps, etc.) should NOT depend on this
 * file or on `window.officeSpace` — they should import the factory
 * directly:
 *
 *   import { createOfficeSpaceClient } from '@ft/contextgraph';
 *   const api = await createOfficeSpaceClient({ user, serverUrl });
 *
 * The `boot` here lazily-constructs the API on the user clicking
 * "connect," matching the existing ui.html flow which expects a global
 * to mutate. For non-legacy UIs that lifecycle is in the consumer.
 */

import { runBrowserEnv, type BrowserEnvHandle } from './env/browser';
import { wrapClient, type OfficeSpaceAPI } from '@console-one/sequenceutils/transport';
import type { ClientEvent } from '@console-one/sequenceutils/transport';

declare global {
  interface Window {
    officeSpace: WindowOfficeSpaceShim;
  }
}

/** The window shim's surface — superset of OfficeSpaceAPI with a
 *  legacy `boot()` entrypoint expected by ui.html's connect button. */
export interface WindowOfficeSpaceShim extends Omit<OfficeSpaceAPI, 'shutdown'> {
  /** Legacy boot. New UIs use createOfficeSpaceClient(config) directly. */
  boot(config: { user: string; serverUrl: string }): Promise<void>;
}

let handle: BrowserEnvHandle | null = null;
let api: OfficeSpaceAPI | null = null;
let currentUser: string | null = null;
let currentServerUrl: string | null = null;
const handlers: ((ev: ClientEvent) => void)[] = [];

function dispatch(ev: ClientEvent): void {
  for (const h of handlers) {
    try { h(ev); } catch {}
  }
}

const shim: WindowOfficeSpaceShim = {
  async boot(config) {
    if (handle) throw new Error('officeSpace.boot: already booted');
    currentUser = config.user;
    currentServerUrl = config.serverUrl;
    handle = await runBrowserEnv({
      user: config.user,
      serverUrl: config.serverUrl,
      transport: (globalThis as { WebSocket?: unknown }).WebSocket as never,
      // dispatch attached BEFORE boot so we don't miss the first
      // 'connected' event the ws fires synchronously on open.
      onEvent: dispatch,
    });
    api = wrapClient(handle.client, { user: config.user, serverUrl: config.serverUrl });
  },
  on(cb) {
    handlers.push(cb);
    return () => {
      const i = handlers.indexOf(cb);
      if (i >= 0) handlers.splice(i, 1);
    };
  },
  get status() {
    return api ? api.status : { connected: false, user: currentUser, serverUrl: currentServerUrl };
  },
  mount(text, opts) {
    if (!api) throw new Error('officeSpace.mount: not booted');
    api.mount(text, opts);
  },
  mountBlock(opts) {
    if (!api) throw new Error('officeSpace.mountBlock: not booted');
    api.mountBlock(opts);
  },
  declareType(path, kind) {
    if (!api) return { ok: false, reason: 'not booted' };
    return api.declareType(path, kind);
  },
  render(name) { return api ? api.render(name) : ''; },
  feed(scope) { return api ? api.feed(scope) : []; },
  planned(scope) { return api ? api.planned(scope) : []; },
  recent(scope) { return api ? api.recent(scope) : []; },
  get(path) { return api ? api.get(path) : undefined; },
  keys(prefix) { return api ? api.keys(prefix) : []; },
  gaps() { return api ? api.gaps() : []; },
  panels: {
    register(id, fn) {
      // Defer to the API once booted; before boot, we'd need to queue.
      // ui.html only calls register() in the connect-success handler so
      // this works in practice; if the timing changes, queue here.
      if (api) api.panels.register(id, fn);
    },
    resolve(id) { return api ? api.panels.resolve(id) : undefined; },
    list() { return api ? api.panels.list() : []; },
  },
};

(globalThis as { window?: unknown }).window = (globalThis as { window?: unknown }).window ?? globalThis;
(globalThis as { window: { officeSpace?: unknown } }).window.officeSpace = shim;
