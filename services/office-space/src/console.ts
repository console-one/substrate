/**
 * console.ts — Interactive ft client console.
 *
 * The console maintains a scope (path prefix) and dispatches
 * rendering via covers against the type at the scope.
 * Renderers are fn tools at _render.{name} — pure functions that
 * take scope data as input and return rendered text.
 *
 * Navigation: /path to enter scope, /.. to go up, / for root.
 * Writes within a scope are auto-prefixed.
 * Deltas outside the scope are filtered.
 */

import * as readline from 'readline';
import { OfficeSpaceClient } from '@console-one/sequenceutils/transport';
import type { ClientEvent } from '@console-one/sequenceutils/transport';
import {
  Sequence,
  createType,
  property,
  param,
  returns,
  selectFirstBranch,
  FT,
  type Type,
} from '@console-one/sequence';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';

// ═══════════════════════════════════════════════════════════════════════
// RENDERERS — pure fn tools at _render.{name}.
// Each tool receives scope data as a plain object, returns rendered text.
// No seq.get() inside impls — the input IS the dependency declaration.
// ═══════════════════════════════════════════════════════════════════════

/** Mount renderers as fn schemas + pure tools. Called once at boot. */
export function mountRenderers(seq: Sequence): void {
  // Document renderer: requires content:string in scope
  seq.mount('schema', '_render.document', createType('fn', [
    param(createType('object', [property('content', FT.string(), false)])),
    returns(FT.string()),
  ]));
  seq.mount('tool', '_render.document', (input: Record<string, unknown>) => {
    const lines: string[] = [];
    const title = input.title as string | undefined;
    if (title) { lines.push(`\x1b[1m${title}\x1b[0m`); lines.push(''); }
    const content = input.content as string | undefined;
    if (content) lines.push(content);
    const meta: string[] = [];
    for (const [k, v] of Object.entries(input)) {
      if (k === 'content' || k === 'title' || v === undefined) continue;
      const display = typeof v === 'string'
        ? v.length > 40 ? v.slice(0, 40) + '...' : v
        : String(v);
      meta.push(`${k}: ${display}`);
    }
    if (meta.length > 0) { lines.push(''); lines.push(`\x1b[2m${meta.join(' | ')}\x1b[0m`); }
    return lines.join('\n');
  });

  // Directory renderer: accepts any object scope (fallback)
  seq.mount('schema', '_render.directory', createType('fn', [
    param(createType('object', [])),
    returns(FT.string()),
  ]));
  seq.mount('tool', '_render.directory', (input: Record<string, unknown>) => {
    const entries = Object.entries(input).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '\x1b[2m(empty)\x1b[0m';
    const lines: string[] = [];
    for (const [k, v] of entries) {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        const title = (v as Record<string, unknown>).title as string | undefined;
        const subCount = Object.keys(v as object).length;
        lines.push(title
          ? `  \x1b[36m${k}/\x1b[0m  ${title}`
          : `  \x1b[36m${k}/\x1b[0m  \x1b[2m(${subCount} keys)\x1b[0m`);
      } else {
        const display = typeof v === 'string'
          ? v.length > 60 ? v.slice(0, 60) + '...' : v
          : String(v);
        lines.push(`  \x1b[33m${k}\x1b[0m = ${display}`);
      }
    }
    return lines.join('\n');
  });
}

/** Collect scope data as a plain object for the render tool. */
function collectScopeData(seq: Sequence, scope: string, keys: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const k of keys) {
    const fullPath = scope ? `${scope}.${k}` : k;
    const val = seq.get(fullPath);
    const subKeys = seq.keys(fullPath);
    if (subKeys.length > 0) {
      const sub: Record<string, unknown> = {};
      for (const sk of subKeys) sub[sk] = seq.get(`${fullPath}.${sk}`);
      data[k] = sub;
    } else if (val !== undefined) {
      data[k] = val;
    }
  }
  return data;
}

// Dispatch is one selectFirstBranch over the union of _render.* fn
// schemas. No covers loop, no value-level fallback: scope without a
// schema defaults to the empty-object type, which covers directory
// (its param is `object []`). The last renderer mounted is the
// general fallback — order tools accordingly.
function dispatchRenderer(seq: Sequence, scope: string, keys: string[]): string {
  const names = seq.keys('_render');
  const pairs = names
    .map(n => ({ name: n, type: seq.typeAt(`_render.${n}`) }))
    .filter((p): p is { name: string; type: Type } => p.type?.kind === 'fn');
  if (pairs.length === 0) return '\x1b[2m(no renderers)\x1b[0m';

  const scopeType = seq.typeAt(scope) ?? createType('object', []);
  const union = pairs.length === 1
    ? pairs[0].type
    : createType('or', pairs.map(p => ({ op: 'branch' as const, args: [p.type] })));
  const selected = selectFirstBranch(union, scopeType);
  if (!selected) return '\x1b[2m(no matching renderer)\x1b[0m';

  const impl = seq.toolAt(`_render.${pairs[selected.index].name}`);
  if (!impl) return '\x1b[2m(no impl)\x1b[0m';
  return (impl as Function)(collectScopeData(seq, scope, keys)) as string;
}

// ═══════════════════════════════════════════════════════════════════════
// CONSOLE
// ═══════════════════════════════════════════════════════════════════════

export interface ConsoleConfig {
  user?: string;
  serverUrl?: string;
  dataDir?: string;
  silent?: boolean;
}

export async function runConsole(config: ConsoleConfig): Promise<void> {
  const user = config.user ?? 'operator';
  const serverUrl = config.serverUrl ?? 'ws://localhost:3100';
  const dataDir = config.dataDir ?? join(homedir(), '.office-space', user, 'console');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  let scope = '';

  const client = new OfficeSpaceClient({
    dataDir,
    serverUrl,
    user,
    env: 'console',
    heartbeatMs: 15_000,
    reconnectMs: 5_000,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });

  function promptStr(): string {
    return `\x1b[2m${scope || '/'}\x1b[0m > `;
  }

  function display(): void {
    if (config.silent) return;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    const seq = (client as any).seq as Sequence;
    const keys = scope
      ? seq.keys(scope)
      : seq.keys().filter((k: string) => !k.startsWith('_'));
    console.log(dispatchRenderer(seq, scope, keys));
    console.log('');
  }

  client.on((ev: ClientEvent) => {
    if (config.silent) return;
    switch (ev.kind) {
      case 'connected':
        display();
        rl.setPrompt(promptStr());
        rl.prompt(true);
        break;
      case 'delta':
        for (const line of ev.text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('_')) continue;
          if (scope && !trimmed.startsWith(scope + '.')) continue;
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          const stripped = scope ? trimmed.replace(scope + '.', '') : trimmed;
          console.log(`\x1b[2m${stripped}\x1b[0m`);
        }
        rl.prompt(true);
        break;
      case 'disconnected':
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        console.log('\x1b[2mdisconnected\x1b[0m');
        rl.prompt(true);
        break;
      case 'error':
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        console.log(`\x1b[31m${ev.message}\x1b[0m`);
        rl.prompt(true);
        break;
    }
  });

  await client.boot();
  mountRenderers((client as any).seq as Sequence);
  if (!config.silent) console.log(`\x1b[2m${user}@${serverUrl}\x1b[0m\n`);
  display();
  rl.setPrompt(promptStr());
  rl.prompt();

  rl.on('line', (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) { rl.prompt(); return; }

    if (trimmed === ':q' || trimmed === ':quit') {
      client.shutdown();
      rl.close();
      process.exit(0);
    }

    // Navigation
    if (trimmed.startsWith('/')) {
      const target = trimmed.slice(1).trim();
      if (target === '' || target === '/') {
        scope = '';
      } else if (target === '..') {
        const parts = scope.split('.');
        parts.pop();
        scope = parts.join('.');
      } else {
        scope = scope ? `${scope}.${target}` : target;
      }
      display();
      rl.setPrompt(promptStr());
      rl.prompt();
      return;
    }

    // Ft text — scoped
    let ftText = trimmed;
    if (scope) {
      ftText = trimmed.split('\n').map(line => {
        const l = line.trim();
        if (!l) return l;
        const m = l.match(/^([a-zA-Z_][\w.]*)\s*(=|<<)\s*(.*)/);
        if (m) return `${scope}.${m[1]} ${m[2]} ${m[3]}`;
        return l;
      }).join('\n');
    }

    try {
      client.mount(ftText);
    } catch (e: any) {
      if (!config.silent) console.log(`\x1b[31m${e.message}\x1b[0m`);
    }
    rl.prompt();
  });

  rl.on('close', () => {
    client.shutdown();
    process.exit(0);
  });
}
