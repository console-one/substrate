/**
 * path-stub.ts — Browser-bundle stub for Node `path`.
 *
 * Named `join` serves the sequenceutils client's guarded Node paths;
 * the default export serves `import nodePath from 'path'` in
 * @console-one/sequence/v2 env/storage.ts. join/normalize/dirname are
 * pure string ops, so provide real minimal impls — accidental
 * invocations produce sensible strings rather than throwing.
 */

export function join(...parts: string[]): string {
  return parts
    .filter(p => typeof p === 'string' && p.length > 0)
    .join('/')
    .replace(/\/+/g, '/');
}

export function normalize(p: string): string {
  const segs: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { segs.pop(); continue; }
    segs.push(seg);
  }
  return (p.startsWith('/') ? '/' : '') + segs.join('/');
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? (i === 0 ? '/' : '.') : p.slice(0, i);
}

/** POSIX-ish resolve: last absolute segment wins, then join+normalize.
 *  Used by the transport server's bootstrap resolver — never reached
 *  in the browser, but has to resolve at bundle time. */
export function resolve(...parts: string[]): string {
  let acc = '';
  for (const p of parts) {
    if (typeof p !== 'string' || p.length === 0) continue;
    acc = p.startsWith('/') ? p : (acc ? `${acc}/${p}` : p);
  }
  return normalize(acc);
}

export default { join, normalize, dirname, resolve };
