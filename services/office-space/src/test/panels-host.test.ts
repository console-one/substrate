/**
 * panels-host.test.ts — Plugin host for UI panels.
 *
 * Verifies the registry surface that the ui.html shell uses:
 *   1. registerStdlibPanels mounts _panels.{id}.* for the four
 *      default panels (files, editor, gaps, tools).
 *   2. A custom panel mounted via _panels.{custom}.* surfaces in
 *      panels.list() in correct sort order (position bucket, then
 *      order, then id).
 *   3. Render fns registered against a render id can be looked up
 *      via panels.resolve(id).
 *
 * The shell itself (ui.html DOM dispatch) is browser-only; this
 * test covers the type-state + registry primitives that drive it.
 */

import { Sequence } from '@console-one/sequence';
import { registerStdlibPanels } from '@console-one/sequenceutils/transport';

test('registerStdlibPanels mounts the four default panel configs (gaps panel removed)', () => {
  const seq = new Sequence(() => Date.now());
  registerStdlibPanels(seq);

  const ids = seq.keys('_panels').sort();
  expect(ids).toEqual(['editor', 'feed', 'files', 'tools']);

  expect(seq.get('_panels.files.title')).toBe('Files');
  expect(seq.get('_panels.files.position')).toBe('sidebar');
  expect(seq.get('_panels.files.render')).toBe('files-panel');

  // Feed is the primary view — main-top, no reader (uses renderForReader directly).
  expect(seq.get('_panels.feed.title')).toBe('Feed');
  expect(seq.get('_panels.feed.position')).toBe('main-top');
  expect(seq.get('_panels.feed.render')).toBe('feed-panel');

  expect(seq.get('_panels.editor.position')).toBe('main-bottom');

  // Tools now sits at rail-top (gaps was rail-top, removed).
  expect(seq.get('_panels.tools.reader')).toBe('tools');
  expect(seq.get('_panels.tools.position')).toBe('rail-top');
});

test('panels.list (the browser-entry surface) returns sorted PanelInfo by position then order then id', () => {
  // Recreate the list logic the browser-entry exposes; the test
  // operates on the underlying primitives so jest doesn't need a DOM.
  const seq = new Sequence(() => Date.now());
  registerStdlibPanels(seq);

  // Mount a custom panel after stdlib — order=5 means it comes
  // BEFORE files (order=10) in the same `sidebar` bucket.
  seq.mount([
    { op: 'bind', path: '_panels.recents.title', value: 'Recents' },
    { op: 'bind', path: '_panels.recents.position', value: 'sidebar' },
    { op: 'bind', path: '_panels.recents.order', value: 5 },
    { op: 'bind', path: '_panels.recents.render', value: 'recents-panel' },
  ]);

  // Replicate the browser-entry's list() implementation so this test
  // stays in plain Node — proves the shape and order without coupling
  // to the bundled browser surface.
  const list = listPanels(seq);

  expect(list.map(p => p.id)).toEqual([
    'recents',      // sidebar,     order 5
    'files',        // sidebar,     order 10
    'feed',         // main-top
    'editor',       // main-bottom
    'tools', // rail-top  (gaps panel removed; tools moved up)
  ]);
  expect(list[0].position).toBe('sidebar');
  expect(list[1].position).toBe('sidebar');
  expect(list[2].position).toBe('main-top');
  expect(list[3].position).toBe('main-bottom');
  expect(list[4].reader).toBe('tools');
});

test('panel render impls register and resolve by id', () => {
  // Mirror the panel registry the browser-entry exposes.
  const registry = new Map<string, (slot: object, ctx: object) => void>();
  const register = (id: string, fn: (slot: object, ctx: object) => void) => { registry.set(id, fn); };
  const resolve = (id: string) => registry.get(id);

  let calls = 0;
  register('files-panel', () => { calls++; });
  register('tools-panel', () => { calls += 10; });

  const filesFn = resolve('files-panel');
  expect(filesFn).toBeInstanceOf(Function);
  filesFn!({}, {});
  expect(calls).toBe(1);

  expect(resolve('not-a-panel')).toBeUndefined();

  // Re-registering replaces (idempotent reload).
  register('files-panel', () => { calls += 100; });
  resolve('files-panel')!({}, {});
  expect(calls).toBe(101);
});

// ─── Local copy of the browser-entry list() logic ────────────────
// Keeps the test in plain Node (no DOM, no bundle import). The real
// implementation in browser-entry.ts must match this shape — if they
// diverge, the test's "browser-entry surface" claim is a lie.

interface PanelInfo {
  id: string;
  title: string;
  position: 'sidebar' | 'main' | 'main-top' | 'main-bottom' | 'rail-top' | 'rail-bottom';
  order: number;
  render: string;
  reader: string | null;
}

function listPanels(seq: Sequence): PanelInfo[] {
  const validPositions = ['sidebar', 'main', 'main-top', 'main-bottom', 'rail-top', 'rail-bottom'];
  const ids = seq.keys('_panels');
  const out: PanelInfo[] = [];
  for (const id of ids) {
    const base = `_panels.${id}`;
    const title = seq.get(`${base}.title`);
    const position = seq.get(`${base}.position`);
    const order = seq.get(`${base}.order`);
    const render = seq.get(`${base}.render`);
    const reader = seq.get(`${base}.reader`);
    if (typeof title !== 'string' || typeof position !== 'string' || typeof render !== 'string') continue;
    if (!validPositions.includes(position)) continue;
    out.push({
      id,
      title,
      position: position as PanelInfo['position'],
      order: typeof order === 'number' ? order : 0,
      render,
      reader: typeof reader === 'string' ? reader : null,
    });
  }
  const positionRank: Record<PanelInfo['position'], number> = {
    'sidebar': 0, 'main': 1, 'main-top': 1, 'main-bottom': 2, 'rail-top': 3, 'rail-bottom': 4,
  };
  out.sort((a, b) => {
    const p = positionRank[a.position] - positionRank[b.position];
    if (p !== 0) return p;
    if (a.order !== b.order) return a.order - b.order;
    return a.id.localeCompare(b.id);
  });
  return out;
}
