#!/usr/bin/env node
/**
 * scripts/build-web.cjs — esbuild bundler for the browser entry.
 *
 * Produces `dist-web/bundle.js` — the single file the server serves
 * at /bundle.js alongside ui.html. The server's HTTP handler has an
 * explicit route for it; no static-file tree walking.
 *
 * Node-only imports (`ws`, `fs`, `path`) are aliased to stubs in
 * src/browser-stubs/. The `client.ts` paths that reach those imports
 * are unreachable in the browser env (the caller always injects
 * `transport: WebSocket` and `persistence: BrowserStorage`), but the
 * imports still have to resolve at bundle time.
 *
 * Pass --watch to rebuild on source changes — useful while iterating
 * on ui.html or browser-entry.ts.
 */

const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const STUBS = path.join(ROOT, 'src', 'browser-stubs');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: [path.join(ROOT, 'src', 'browser-entry.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  outfile: path.join(ROOT, 'dist-web', 'bundle.js'),
  sourcemap: true,
  logLevel: 'info',
  alias: {
    // Node `ws` package — replaced by a throwing default export.
    // Reached only if the caller forgot to pass transport: WebSocket.
    'ws': path.join(STUBS, 'ws-stub.ts'),
    // Node `fs` — only reached on the Node-default snapshot code
    // path inside client.ts, which is guarded out in the browser.
    'fs': path.join(STUBS, 'fs-stub.ts'),
    // Node `path` — same story, `join()` guarded out but has to
    // import successfully.
    'path': path.join(STUBS, 'path-stub.ts'),
  },
  // `better-sqlite3` is a native Node addon used by the server-side
  // persistence layer. Nothing in the browser entry's import graph
  // should reach it, but mark as external as defense in depth so
  // bundler doesn't even try to resolve it if an accidental import
  // slips in.
  external: ['better-sqlite3'],
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    process.stderr.write(`[build-web] watching — output at ${config.outfile}\n`);
  } else {
    const result = await esbuild.build(config);
    const warnings = result.warnings.length;
    process.stderr.write(
      `[build-web] built ${config.outfile} (${warnings} warnings)\n`,
    );
    if (warnings > 0) {
      for (const w of result.warnings) {
        process.stderr.write(`  warning: ${w.text}\n`);
      }
    }
  }
}

main().catch((e) => {
  process.stderr.write(`[build-web] failed: ${e.message}\n`);
  process.exit(1);
});
