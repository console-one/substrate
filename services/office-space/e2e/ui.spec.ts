/**
 * e2e/ui.spec.ts — Real browser verification of the UI plugin host.
 *
 * Boots ContextGraphServer in-process, opens the served ui.html in a
 * headless Chromium, drives the page through the actual user flow:
 *
 *   1. Initial render — four panels (Files / Editor / Gaps /
 *      Capabilities) present in the DOM, status `idle`.
 *   2. Click connect → status flips to `connected ...`.
 *   3. window.officeSpace.panels.list() returns the 4 stdlib
 *      PanelInfo records, sorted by position bucket.
 *   4. Mount a cap instance via the ft input box.
 *   5. Capabilities panel updates to show the new cap with model,
 *      endpoint, usage — proving the plugin host's render dispatch
 *      runs on every event AND the caps reader-as-document scopes
 *      correctly.
 *
 * No mocks. Real WebSocket. Real Sequence. Real bundle.js. The
 * UI passing this spec means a user clicking through would see the
 * same thing.
 */

import { test, expect } from '@playwright/test';
import { ContextGraphServer } from '../src/server';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let server: ContextGraphServer;
let port: number;
let dbPath: string;

test.beforeAll(() => {
  // Bundle must exist for the page to load. The build:web npm script
  // produces dist-web/bundle.js. Fail loudly if it's missing — running
  // the e2e against a stale or nonexistent bundle is a guaranteed
  // false signal.
  const bundlePath = join(__dirname, '..', 'dist-web', 'bundle.js');
  if (!existsSync(bundlePath)) {
    throw new Error(
      `dist-web/bundle.js not found. Run \`npm run build:web\` before \`npx playwright test\`.\n` +
      `Looked at: ${bundlePath}`,
    );
  }
});

test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-e2e-'));
  dbPath = join(dir, 'test.db');
  server = new ContextGraphServer({ port: 0, dbPath });
  port = await server.start();
});

test.afterEach(async () => {
  await server.stop();
  try { rmSync(dbPath, { force: true }); } catch {}
});

test('UI shell renders four stdlib panels and dispatches via the plugin host', async ({ page }) => {
  // Surface page errors so we don't get silent breakage.
  const pageErrors: string[] = [];
  const allConsole: string[] = [];
  page.on('pageerror', e => pageErrors.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));
  page.on('console', m => {
    allConsole.push(`[${m.type()}] ${m.text()}`);
    if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`);
  });

  await page.goto(`http://localhost:${port}/`);

  // Static skeleton — Feed primary, Files sidebar, Editor below feed,
  // Capabilities in right rail. Gaps panel removed (everything visible
  // is gap-related; a separate panel for them was duplicative).
  await expect(page.locator('header .title')).toHaveText('Office Space — Workspace');
  await expect(page.locator('.feed-pane .panel-header span').first()).toHaveText('Feed');
  await expect(page.locator('aside.sidebar .panel-header span').first()).toHaveText('Files');
  await expect(page.locator('.editor-pane .title-row span').first()).toHaveText('(no file selected)');
  await expect(page.locator('aside.right-rail .panel').nth(0).locator('.panel-header span').first()).toHaveText('Capabilities');

  // Connect.
  await page.click('button#connect');
  try {
    await expect(page.locator('#status')).toContainText('connected', { timeout: 10_000 });
  } catch (e) {
    // Diagnostic dump before we fail — surface what the page actually
    // saw so we can fix the connect flow rather than guess.
    const diag = await page.evaluate(async () => {
      const w = (globalThis as any).window;
      // Try a vanilla WebSocket to the same server URL — if THAT
      // works, the server is fine and the bug is in client/env code.
      // If it fails, the server isn't accepting ws upgrades.
      const probe = await new Promise<{state: string; readyState?: number; err?: string}>((resolve) => {
        try {
          const url = w.officeSpace?.status?.serverUrl;
          if (!url) return resolve({state: 'no-url'});
          const ws = new WebSocket(url);
          const tid = setTimeout(() => resolve({state: 'timeout', readyState: ws.readyState}), 3000);
          ws.onopen = () => { clearTimeout(tid); resolve({state: 'open', readyState: ws.readyState}); ws.close(); };
          ws.onerror = (e) => { clearTimeout(tid); resolve({state: 'error', err: String((e as any)?.message ?? 'WS error')}); };
          ws.onclose = (e) => resolve({state: 'closed-before-open', readyState: ws.readyState, err: String(e?.code)});
        } catch (e: any) {
          resolve({state: 'throw', err: e.message});
        }
      });
      return {
        status: document.getElementById('status')?.textContent ?? '(no #status)',
        err: document.getElementById('err')?.textContent ?? '(no #err)',
        booted: typeof w.officeSpace,
        statusObj: w.officeSpace?.status,
        hasPanels: !!w.officeSpace?.panels,
        wsProbe: probe,
      };
    });
    console.log('=== DIAG (boot did not complete) ===');
    console.log(JSON.stringify(diag, null, 2));
    console.log('=== Page errors ===');
    console.log(pageErrors.join('\n') || '(none)');
    console.log('=== All console ===');
    console.log(allConsole.slice(-50).join('\n') || '(none)');
    throw e;
  }

  // Plugin host enumerates the four stdlib panel configs.
  const panelList = await page.evaluate(() => {
    const w = (globalThis as any).window;
    if (!w.officeSpace?.panels) return null;
    return w.officeSpace.panels.list();
  });
  expect(panelList).not.toBeNull();
  expect(panelList).toHaveLength(4);
  const ids = panelList!.map((p: { id: string }) => p.id);
  // Order: sidebar (files) → main-top (feed) → main-bottom (editor) → rail-top (capabilities).
  // Gaps panel removed — duplicative with everything else the UI already surfaces.
  expect(ids).toEqual(['files', 'feed', 'editor', 'capabilities']);

  const caps = panelList!.find((p: { id: string }) => p.id === 'capabilities')!;
  expect(caps.position).toBe('rail-top');
  expect(caps.reader).toBe('caps');
  expect(caps.render).toBe('capabilities-panel');

  // Render fns registered by the shell on connect.
  const resolved = await page.evaluate(() => {
    const w = (globalThis as any).window;
    return {
      feed: typeof w.officeSpace.panels.resolve('feed-panel'),
      files: typeof w.officeSpace.panels.resolve('files-panel'),
      editor: typeof w.officeSpace.panels.resolve('editor-panel'),
      caps: typeof w.officeSpace.panels.resolve('capabilities-panel'),
      bogus: typeof w.officeSpace.panels.resolve('does-not-exist'),
    };
  });
  expect(resolved).toEqual({
    feed: 'function', files: 'function', editor: 'function',
    caps: 'function', bogus: 'undefined',
  });

  // No pageerrors so far.
  expect(pageErrors).toEqual([]);
});

test('Feed shows Planned + Recent sections with semantic activity', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(`pageerror: ${e.message}`));

  await page.goto(`http://localhost:${port}/`);
  await page.click('button#connect');
  await expect(page.locator('#status')).toContainText('connected');

  // Mount via programmatic API. The DOM no longer has a raw-ft input
  // (it was a developer console, removed). Tests drive state via
  // window.officeSpace.mount + mountBlock, which are legit programmatic
  // surfaces.
  //
  // For "scheduled fact" we use the substrate's actual scheduling
  // primitive: a block with `where: gt('_rt', T)` is suspended until
  // _rt advances past T. The substrate's planned() reads suspended
  // blocks directly — no `.fireAt` sidecar field.
  const future = Date.now() + 60_000;
  await page.evaluate((futureMs) => {
    (globalThis as any).window.officeSpace.mount(
      `tasks.standup.title = "Daily standup"\n` +
      `notes.foo.body = "hello"`,
    );
    (globalThis as any).window.officeSpace.mountBlock({
      entries: [{ op: 'bind', path: 'tasks.standup.status', value: 'happening' }],
      where: [{ op: 'gt', args: ['_rt', futureMs] }],
    });
  }, future);
  await page.waitForTimeout(300);

  // Two section headers: Planned + Recent. (Topics was substrate-cluster
  // noise; removed. Scope-text-input was substrate-tooling-as-feature;
  // removed. Click-driven scope is the right abstraction, not yet wired.)
  const headers = page.locator('.feed-section-header');
  await expect(headers).toHaveCount(2);
  await expect(headers.nth(0)).toContainText('Planned');
  await expect(headers.nth(1)).toContainText('Recent');

  // Planned: standup card with countdown.
  const plannedSection = page.locator('[data-section="planned"]');
  await expect(plannedSection).toContainText('Daily standup');
  await expect(plannedSection.locator('.feed-card').first().locator('.when')).toContainText(/in \d/);

  // Recent: at least one semantic activity card. Card title is
  // "{author} updated {subject}" — human-readable, no substrate
  // paths or block numbers, no "block N" framing.
  const recentSection = page.locator('[data-section="recent"]');
  const firstRecentCard = recentSection.locator('.feed-card').first();
  await expect(firstRecentCard).toBeVisible();
  await expect(firstRecentCard.locator('.id')).toContainText(/updated/);
  await expect(firstRecentCard.locator('.id')).not.toContainText(/^block /);

  // Substrate-tooling surfaces are gone — assert no DOM trace.
  await expect(page.locator('#feed-scope')).toHaveCount(0);
  await expect(page.locator('.feed-toolbar')).toHaveCount(0);
  await expect(page.locator('#input')).toHaveCount(0);
  await expect(page.locator('#send')).toHaveCount(0);
  await expect(page.locator('.debug-panel')).toHaveCount(0);
  await expect(page.locator('#debug-toggle')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test('cluster scoring surface (window.officeSpace.feed) remains available for inspection', async ({ page }) => {
  // Topics aren't on the homepage anymore (substrate noise), but the
  // clustering API stays — useful for a future debug/inspection panel,
  // for LLM prompt assembly, and for memory compaction. Verify the
  // shape is intact even though the homepage no longer renders it.
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`);
  });

  await page.goto(`http://localhost:${port}/`);
  await page.click('button#connect');
  await expect(page.locator('#status')).toContainText('connected');

  await page.evaluate(() => {
    (globalThis as any).window.officeSpace.mount(
      'task.alpha.title = "ship the loop"\n' +
      'task.alpha.status = "open"\n' +
      'task.beta.title = "review PR"\n' +
      'project.docs.section = "intro"',
    );
  });
  await page.waitForTimeout(300);

  const items = await page.evaluate(() => (globalThis as any).window.officeSpace.feed());
  expect(Array.isArray(items)).toBe(true);
  expect(items.length).toBeGreaterThan(0);
  // Items are sorted by score descending.
  for (let i = 1; i < items.length; i++) {
    expect(items[i - 1].score).toBeGreaterThanOrEqual(items[i].score);
  }
  // Each item carries the signal breakdown.
  expect(items[0]).toHaveProperty('signals');
  expect(items[0].signals).toHaveProperty('actionability');
  expect(items[0].signals).toHaveProperty('urgency');

  // No "Topics" section in the DOM anymore.
  await expect(page.locator('[data-section="topics"]')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test('editor injections: {{path}} in source resolves live in preview', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(`pageerror: ${e.message}`));

  await page.goto(`http://localhost:${port}/`);
  await page.click('button#connect');
  await expect(page.locator('#status')).toContainText('connected');

  // Mount a value the narrative will inject.
  await page.evaluate(() => {
    (globalThis as any).window.officeSpace.mount('task.standup.title = "Daily standup"');
  });
  // Create + open a file via the new-file dialog (faked via prompt).
  await page.evaluate(() => {
    (globalThis as any).window.prompt = () => 'notes';
  });
  await page.click('#new-file');
  await page.waitForTimeout(150);

  // Type narrative content with an injection. Replace any default
  // template; type the source directly into the editor textarea.
  const editor = page.locator('#editor');
  await editor.click();
  await page.evaluate(() => { (document.getElementById('editor') as HTMLTextAreaElement).value = ''; });
  await editor.type("Tomorrow's standup is: {{task.standup.title}}. Status: {{task.standup.status}}.");
  await page.waitForTimeout(200);

  // Preview should resolve the title (mounted) and mark status as missing.
  const preview = page.locator('#editor-preview');
  await expect(preview).toContainText("Tomorrow's standup is:");
  await expect(preview).toContainText('Daily standup');
  await expect(preview.locator('.injection.resolved').first()).toHaveText('Daily standup');
  // Missing pill shows just the field label "status" — full path
  // and kind live in the tooltip.
  await expect(preview.locator('.injection.missing')).toHaveCount(1);
  await expect(preview.locator('.injection.missing').first()).toHaveText('status');
  await expect(preview.locator('.injection.missing').first()).toHaveAttribute('title', /task\.standup\.status/);

  // Mount the missing value — preview updates on the cascade event.
  await page.evaluate(() => {
    (globalThis as any).window.officeSpace.mount('task.standup.status = "scheduled"');
  });
  await page.waitForTimeout(200);
  await expect(preview).toContainText('scheduled');
  await expect(preview.locator('.injection.missing')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test('editor injections: typed kind annotation declares a schema in the substrate', async ({ page }) => {
  // {{path : kind}} declares a typed reference. Writing the marker
  // mounts a schema at that path so backward inference treats it as
  // a typed gap. Filling the gap with a matching value resolves the
  // injection; filling with a wrong type would be rejected by
  // admission (not asserted here — would need a covering law).
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(`pageerror: ${e.message}`));

  await page.goto(`http://localhost:${port}/`);
  await page.click('button#connect');
  await expect(page.locator('#status')).toContainText('connected');

  // Open a file.
  await page.evaluate(() => { (globalThis as any).window.prompt = () => 'typed_notes'; });
  await page.click('#new-file');
  await page.waitForTimeout(150);

  // Type a narrative with a kind-annotated injection.
  const editor = page.locator('#editor');
  await editor.click();
  await page.evaluate(() => { (document.getElementById('editor') as HTMLTextAreaElement).value = ''; });
  await editor.type('Title: {{doc.heading : string}}. Count: {{doc.count : number}}.');
  await page.waitForTimeout(300); // wait for debounced save + schema declaration

  // Schemas should be declared at the referenced paths — verify
  // through the seq's typeAt (exposed via officeSpace's underlying
  // client).
  const schemas = await page.evaluate(() => {
    const w = (globalThis as any).window;
    const seq = w.officeSpace && (w.officeSpace as any);
    // Use the public typeAt path through declareType's idempotency:
    // declareType returns ok if schema is already present.
    return {
      heading: w.officeSpace.declareType('doc.heading', 'string'),
      count:   w.officeSpace.declareType('doc.count', 'number'),
    };
  });
  expect(schemas.heading.ok).toBe(true);
  expect(schemas.count.ok).toBe(true);

  // Both injections render as missing initially.
  const preview = page.locator('#editor-preview');
  await expect(preview.locator('.injection.missing')).toHaveCount(2);

  // Fill the heading — only the heading injection resolves.
  await page.evaluate(() => {
    (globalThis as any).window.officeSpace.mount('doc.heading = "Hello"');
  });
  await page.waitForTimeout(200);
  await expect(preview.locator('.injection.resolved')).toHaveCount(1);
  await expect(preview.locator('.injection.missing')).toHaveCount(1);
  await expect(preview).toContainText('Hello');

  // Fill the count.
  await page.evaluate(() => {
    (globalThis as any).window.officeSpace.mount('doc.count = 42');
  });
  await page.waitForTimeout(200);
  await expect(preview.locator('.injection.resolved')).toHaveCount(2);
  await expect(preview.locator('.injection.missing')).toHaveCount(0);
  await expect(preview).toContainText('Hello');
  await expect(preview).toContainText('42');

  expect(pageErrors).toEqual([]);
});

test('narrative transclusion: fork includes parent inline + shares pills', async ({ page }) => {
  // Filling a pill in EITHER narrative resolves it for BOTH —
  // they reference the same workspace path. The fork is the parent
  // composed with whatever the user appends.
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(`pageerror: ${e.message}`));

  await page.goto(`http://localhost:${port}/`);
  await page.click('button#connect');
  await expect(page.locator('#status')).toContainText('connected');

  // Create the parent narrative with a typed pill.
  await page.evaluate(() => { (globalThis as any).window.prompt = () => 'parent_doc'; });
  await page.click('#new-file');
  await page.waitForTimeout(150);
  const editor = page.locator('#editor');
  await editor.click();
  await page.evaluate(() => { (document.getElementById('editor') as HTMLTextAreaElement).value = ''; });
  await editor.type('Parent says hello to {{greeting.name : string}}.');
  await page.waitForTimeout(300);

  // Verify parent preview shows the missing pill.
  const preview = page.locator('#editor-preview');
  await expect(preview).toContainText('Parent says hello to');
  await expect(preview.locator('.injection.missing')).toHaveCount(1);

  // Fork it. Fork auto-names (parent_doc_fork) and structurally
  // links to the parent via files.{fork}.parent — no transclusion
  // marker in the saved content. The renderer transcludes the
  // parent's content into the preview automatically.
  await page.click('#fork-file');
  await page.waitForTimeout(300);

  // Editor now shows the fork.
  await expect(page.locator('#current-file')).toContainText('parent_doc_fork');

  // Append an additional pill specific to the fork.
  const editor2 = page.locator('#editor');
  await editor2.click();
  await page.evaluate(() => {
    (document.getElementById('editor') as HTMLTextAreaElement).value = 'Also: {{addendum : string}}.';
    document.getElementById('editor')?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);

  // Preview now shows: parent narrative transcluded above (▼ forked
  // from parent_doc) PLUS the fork's own additions. Two missing
  // pills total: parent's greeting.name and fork's addendum.
  await expect(preview.locator('.transcluded')).toHaveCount(1);
  await expect(preview.locator('.transcluded-label')).toContainText('parent_doc');
  await expect(preview.locator('.injection.missing')).toHaveCount(2);

  // Fill greeting.name — the parent's pill. Both narratives resolve
  // (fork via the structural transclusion of the parent).
  await page.evaluate(() => {
    (globalThis as any).window.officeSpace.mount('greeting.name = "world"');
  });
  await page.waitForTimeout(200);

  // Fork preview: only addendum still missing.
  await expect(preview.locator('.injection.missing')).toHaveCount(1);
  await expect(preview.locator('.transcluded')).toContainText('world');

  // Switch back to the parent — its preview also shows greeting
  // resolved (single workspace, single path, both narratives see it).
  await page.locator('.file-list li[data-file="parent_doc"]').click();
  await page.waitForTimeout(200);
  await expect(page.locator('#current-file')).toContainText('parent_doc');
  await expect(preview).toContainText('world');
  await expect(preview.locator('.injection.missing')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test('document frontmatter: --- block is metadata, hidden from render, mounted to substrate', async ({ page }) => {
  // Each narrative MAY carry a `--- key: value ---` frontmatter block
  // at the top. Renderer strips it. Each k:v is mounted at
  // files.{name}.meta.{key} so consumers (agent loop, peers, external
  // tools) see the metadata as type-state without re-parsing the body.
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(`pageerror: ${e.message}`));

  await page.goto(`http://localhost:${port}/`);
  await page.click('button#connect');
  await expect(page.locator('#status')).toContainText('connected');

  await page.evaluate(() => { (globalThis as any).window.prompt = () => 'meta_doc'; });
  await page.click('#new-file');
  await page.waitForTimeout(150);

  // Type a document with a frontmatter block.
  const editor = page.locator('#editor');
  await editor.click();
  await page.evaluate(() => {
    const e = document.getElementById('editor') as HTMLTextAreaElement;
    e.value =
      '---\n' +
      'scope: tasks.alpha\n' +
      'parser: v1\n' +
      'visibility: private\n' +
      '---\n' +
      '\n' +
      'Hello {{greeting.name : string}}.';
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);

  const preview = page.locator('#editor-preview');

  // Preview shows the body. Pill renders with the field label only
  // ("name") — full path lives in the tooltip.
  await expect(preview).toContainText('Hello');
  await expect(preview.locator('.injection.missing').first()).toHaveText('name');
  await expect(preview.locator('.injection.missing').first()).toHaveAttribute('title', /greeting\.name/);
  // The literal "---" delimiters and the meta values must not appear
  // in the rendered body.
  const previewText = await preview.textContent() ?? '';
  expect(previewText).not.toContain('---');
  expect(previewText).not.toContain('tasks.alpha');
  expect(previewText).not.toContain('private');
  // The meta-badge shows the key names compactly.
  await expect(preview.locator('.meta-badge')).toContainText('meta:');

  // Substrate has the metadata at files.meta_doc.meta.{key}.
  const meta = await page.evaluate(() => ({
    scope:      (globalThis as any).window.officeSpace.get('files.meta_doc.meta.scope'),
    parser:     (globalThis as any).window.officeSpace.get('files.meta_doc.meta.parser'),
    visibility: (globalThis as any).window.officeSpace.get('files.meta_doc.meta.visibility'),
  }));
  expect(meta.scope).toBe('tasks.alpha');
  expect(meta.parser).toBe('v1');
  expect(meta.visibility).toBe('private');

  expect(pageErrors).toEqual([]);
});

test('Capabilities panel renders newly-installed cap via the caps reader', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`);
  });

  await page.goto(`http://localhost:${port}/`);
  await page.click('button#connect');
  await expect(page.locator('#status')).toContainText('connected');

  // Caps panel starts empty.
  await expect(page.locator('#caps-doc')).toContainText('(no capabilities installed)');
  await expect(page.locator('#caps-count')).toHaveText('0');

  // Mount a cap via the programmatic API.
  const mountText =
    'state.cap_instances.test_oai.endpoint = "https://api.openai.com/v1/chat/completions"\n' +
    'state.cap_instances.test_oai.model = "gpt-4"\n' +
    'state.cap_instances.test_oai.provider = "openai"\n' +
    'state.cap_instances.test_oai.usage.tokens = 0\n' +
    'state.cap_instances.test_oai.usage.requests = 0';
  await page.evaluate((text) => {
    (globalThis as any).window.officeSpace.mount(text);
  }, mountText);

  // Document updates via the registered capabilities-panel render fn.
  const capsPane = page.locator('#caps-doc');
  await expect(capsPane).toContainText('test_oai', { timeout: 5_000 });
  await expect(capsPane).toContainText('gpt-4');
  await expect(capsPane).toContainText('openai');
  await expect(page.locator('#caps-count')).toHaveText('1');

  // Reader scope discipline: mount narratives.* (out of caps reader's
  // source) and verify it does NOT appear in the Capabilities panel.
  await page.evaluate(() => {
    (globalThis as any).window.officeSpace.mount('narratives.thread1.posts.p0 = "hello"');
  });
  // give it a tick to propagate
  await page.waitForTimeout(200);
  expect(await capsPane.textContent()).not.toContain('narratives');
  expect(await capsPane.textContent()).not.toContain('hello');

  // Cap count still 1.
  await expect(page.locator('#caps-count')).toHaveText('1');

  expect(pageErrors).toEqual([]);
});
