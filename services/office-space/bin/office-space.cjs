#!/usr/bin/env node
/**
 * Office Space CLI launcher.
 *
 * Runs the TypeScript entry point through tsx with a tsconfig that
 * maps @ft/core to its source tree instead of the compiled dist.
 * Edits to packages/core take effect on the next server restart
 * with no `npm run build` required, eliminating the stale-dist
 * foot-gun. Trade-off is ~200ms of cold-start compile time —
 * invisible for a local dev tool.
 */
const path = require('node:path');
const { spawn } = require('node:child_process');

const tsxBin = require.resolve('tsx/cli');
const indexTs = path.resolve(__dirname, '..', 'src', 'index.ts');
const tsconfig = path.resolve(__dirname, '..', 'tsconfig.tsx.json');

const child = spawn(
  process.execPath,
  [tsxBin, '--tsconfig', tsconfig, indexTs, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
