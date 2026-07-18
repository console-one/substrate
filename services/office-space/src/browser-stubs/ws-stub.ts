/**
 * ws-stub.ts — Browser-bundle stub for the Node `ws` package.
 *
 * The sequenceutils client imports `NodeWebSocket from 'ws'` at module
 * scope as a default transport fallback; the transport server imports
 * `WebSocketServer`. In the browser env the caller always passes
 * `transport: WebSocket` (the browser global) and never starts a
 * server — but the imports still have to resolve at bundle time.
 */

export default class WsStub {
  constructor(_url: string) {
    throw new Error(
      'ws-stub: the Node `ws` package is not available in the browser. ' +
      'Pass `transport: WebSocket` to runBrowserEnv / OfficeSpaceClient.'
    );
  }
}

export class WebSocket extends WsStub {}

export class WebSocketServer {
  constructor(_opts?: unknown) {
    throw new Error(
      'ws-stub: WebSocketServer is not available in the browser. ' +
      'The transport server only runs in Node.'
    );
  }
}
