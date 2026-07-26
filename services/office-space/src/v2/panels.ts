/**
 * v2/panels.ts — browser-tier panel plugin registry (type-state side),
 * on the v2 kernel. Port of sequenceutils/transport's panels module
 * (deletion-ledger stage 4): a panel's CONFIG lives as facts under
 * `_panels.{id}.*` (inspectable, persistent, orderable); its RENDER FN
 * lives in the JS bundle, registered against the `render` id at boot —
 * the same template-vs-impl split as tools.
 *
 *     _panels.{id}.title    = "Tools"
 *     _panels.{id}.reader   = "tools"          // optional
 *     _panels.{id}.position = "rail-top"       // sidebar | main-top | …
 *     _panels.{id}.render   = "tools-panel"
 *     _panels.{id}.order    = 20               // sort within position
 *
 * Browser-tier ONLY — server/agent/lambda envs have no DOM.
 */

import { Sequence } from '@console-one/sequence/v2';

export interface PanelConfig {
  title: string;
  position: 'sidebar' | 'main' | 'main-top' | 'main-bottom' | 'rail-top' | 'rail-bottom';
  order: number;
  render: string;
  reader?: string;
}

export function registerPanel(seq: Sequence, id: string, cfg: PanelConfig): void {
  const base = `_panels.${id}`;
  seq.insert({ path: `${base}.title`, value: cfg.title });
  seq.insert({ path: `${base}.position`, value: cfg.position });
  seq.insert({ path: `${base}.order`, value: cfg.order });
  seq.insert({ path: `${base}.render`, value: cfg.render });
  if (cfg.reader !== undefined) seq.insert({ path: `${base}.reader`, value: cfg.reader });
}

/** Mount the stdlib panel configs. Same four panels, same layout
 *  rationale as the v1 module (editor dominant, feed supporting,
 *  no dedicated gaps panel — that was a leak). */
export function registerStdlibPanels(seq: Sequence): void {
  registerPanel(seq, 'feed',   { title: 'Feed',   position: 'main-top',    order: 10, render: 'feed-panel' });
  registerPanel(seq, 'files',  { title: 'Files',  position: 'sidebar',     order: 10, render: 'files-panel' });
  registerPanel(seq, 'editor', { title: 'Editor', position: 'main-bottom', order: 10, render: 'editor-panel' });
  registerPanel(seq, 'tools',  { title: 'Tools',  position: 'rail-top',    order: 10, reader: 'tools', render: 'tools-panel' });
}
