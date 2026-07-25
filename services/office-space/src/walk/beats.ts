/**
 * beats.ts — the 12 beats of the storyboard walk, executable.
 *
 * Each beat = { run, accept }. `run` performs the beat's REAL actions
 * against the office kernel (v2) and returns what the dev would see;
 * `accept` throws unless the beat's acceptance criterion — from the
 * storyboard table, enforcement or round-trip, never parse or
 * appearance — actually holds. Beats in STORYBOARD_LEDGER.json are
 * known-unbuilt: they must FAIL loudly; one that starts passing fails
 * the suite until struck (the ratchet).
 *
 * Determinism: the kernel clock is injected; the agent side is a fixed
 * script, labeled operator-scripted. The latency observations are real
 * measured durations of real local calls (that is the honesty rule,
 * not a determinism leak — no assertion depends on their digits).
 */

import type { Sequence, VendResult, MergeFramesResult } from '@console-one/sequence/v2';
import {
  Sequence as SequenceV2, vend, revend, callThroughSession, continueSession,
  receiveDocument, mergeFrames, electLabel, timeHorizon,
} from '@console-one/sequence/v2';
import { MailboxSim } from './mailbox-sim';
import { browseConnectors, installMailboxConnector, MAILBOX_MANIFEST_FT } from './connector';
import { storeKey, createKit, offerHydration, hydrate, type HydrationResult } from './kit';

export const SECRET_KEY_VALUE = 'sim-personal-key-8842';
export const CAPABILITY = 'personalemail';

export type WalkContext = {
  office: Sequence;
  sim: MailboxSim;
  clock: { t: number };
  /** Interactive consent hook; scripted mode answers yes with a note. */
  ask: (question: string) => Promise<boolean>;
  // Cross-beat state, filled as the walk advances:
  keyAlias?: string;
  hydration?: HydrationResult;
  frame?: VendResult;
  frameBefore?: string;
  reVended?: string;
  secondFrame?: VendResult;
  merged?: MergeFramesResult;
  bTools?: string[];
  bSessionId?: string;
  cTools?: string[];
  cValidUntil?: number;
  cChain?: string;
};

export function newWalkContext(ask: WalkContext['ask']): WalkContext {
  const clock = { t: 1_000_000_000 };
  return {
    office: new SequenceV2(() => clock.t),
    sim: new MailboxSim('me@example.test', SECRET_KEY_VALUE),
    clock,
    ask,
  };
}

const approxTokens = (s: string): number => Math.ceil(s.length / 4);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const NARRATIVES_FT = `
narratives.team.short = "The mail crew: four of us triaging a shared support inbox."
narratives.team.medium = "The mail crew is a four-person team that triages a shared support inbox: invoices, renewals and release chatter. We answer within a day and archive aggressively."
narratives.team.long = "The mail crew is a four-person team that triages a shared support inbox covering invoices, renewals, releases, onboarding and retros. We answer within a day, star anything billing-related, archive aggressively, and never send from automation without a human in the loop. Escalations go to whoever is on point that week."
narratives.self.short = "Dev on the mail crew; owns the billing label."
narratives.self.medium = "I am the dev on the mail crew who owns the billing label. I prefer terse summaries and want automation to read my mail, never to write it."
narratives.self.long = "I am the developer on the mail crew who owns the billing label and the renewal follow-ups. I prefer terse, code-anchored summaries. I want agents to read and organize my personal mail — search it, fetch it, label it — but composing or sending mail stays with me; that boundary is permanent, not a phase."
`;

export type Beat = {
  n: number;
  title: string;
  run: (ctx: WalkContext) => Promise<string[]>;
  accept: (ctx: WalkContext) => Promise<void>;
};

export const BEATS: Beat[] = [
  {
    n: 1,
    title: 'Write short/medium/long narratives about the TEAM and about THEMSELVES — labeled variants',
    run: async (ctx) => {
      const r = await receiveDocument(ctx.office, NARRATIVES_FT);
      assert(r.errors.length === 0, `narratives failed to mount: ${r.errors.join('; ')}`);
      return [
        'two label groups now exist:',
        `  narratives.team — variants: ${ctx.office.keys('narratives.team').join(', ')}`,
        `  narratives.self — variants: ${ctx.office.keys('narratives.self').join(', ')}`,
      ];
    },
    accept: async (ctx) => {
      // A label reference ALONE resolves to ONE context-suitable variant:
      // generous budget elects the long form, tight budget the short.
      const roomy = electLabel(ctx.office, 'narratives.self', 10_000);
      const tight = electLabel(ctx.office, 'narratives.self', 15);
      assert(roomy?.variant === 'long', `roomy budget elected ${roomy?.variant}, wanted long`);
      assert(tight?.variant === 'short', `tight budget elected ${tight?.variant}, wanted short`);
    },
  },
  {
    n: 2,
    title: 'Browse/search connectors, find the mailbox one, install it',
    run: async (ctx) => {
      // The manifest document IS the directory entry + the connector.
      const r = await installMailboxConnector(ctx.office, ctx.sim);
      assert(r.errors.length === 0, `install errors: ${r.errors.join('; ')}`);
      const found = browseConnectors(ctx.office, 'mail');
      return [
        `browse "mail" → ${found.map((f) => `${f.name} (${f.displayName})`).join(', ')}`,
        `installed from manifest DATA: ${r.tools.filter((t) => !t.includes('._')).join(', ')}`,
      ];
    },
    accept: async (ctx) => {
      // Install is data: the tool types came from the manifest TEXT and
      // the temporal metadata is orinary kernel state.
      assert(ctx.office.rawTypeAt('mailbox.search')?.kind === 'fn', 'mailbox.search not mounted');
      assert(MAILBOX_MANIFEST_FT.includes('mailbox.search = (q: string)'), 'manifest is not the source');
      const meta = ctx.office.get('_connectors.mailbox.apis.search') as { cacheable?: boolean };
      assert(meta?.cacheable === true, 'manifest metadata not readable from the kernel');
    },
  },
  {
    n: 3,
    title: 'Secret tool → a key for their personal email, addressable by alias only',
    run: async (ctx) => {
      ctx.keyAlias = storeKey(ctx.office, 'mailbox.personal', SECRET_KEY_VALUE);
      return [
        `key stored; alias: ${ctx.keyAlias}`,
        'everything downstream carries the alias — the value stays in the vault cell',
      ];
    },
    accept: async (ctx) => {
      assert(ctx.office.get(ctx.keyAlias!) === SECRET_KEY_VALUE, 'key not retrievable by alias');
      // The key is REAL: without it the service refuses.
      const raw = ctx.office.impls.get('mailbox.search')!;
      let refused = false;
      try { await raw({ q: 'invoice' }); } catch { refused = true; }
      assert(refused, 'the connector answered without the key — the secret is decorative');
    },
  },
  {
    n: 4,
    title: 'Create a KIT: key alias injected into the mailbox tools + a constraint filtering out email-WRITING',
    run: async (ctx) => {
      const r = createKit(ctx.office, {
        capability: CAPABILITY,
        connector: 'mailbox',
        keyAlias: ctx.keyAlias!,
        exclude: ['send'],
        excludeReason: 'email-writing filtered at kit creation — reads only',
      });
      return [
        `capability '${CAPABILITY}': ${r.tools.join(', ')}`,
        `excluded (retained constraint): ${r.excluded.join(', ')}`,
      ];
    },
    accept: async (ctx) => {
      // The exclusion is RETAINED: the kernel REFUSES any future mount
      // at the excluded path — type, value, anything, forever.
      const tryType = ctx.office.insert({
        path: `${CAPABILITY}.send`,
        type: ctx.office.rawTypeAt('mailbox.send'),
      });
      assert(tryType.suspended, 'the kernel admitted a tool at the excluded verb');
      const tryValue = ctx.office.insert({ path: `${CAPABILITY}.send`, value: 'smuggled' });
      assert(tryValue.suspended, 'the kernel admitted a value at the excluded verb');
      assert(ctx.office.rawTypeAt(`${CAPABILITY}.send`) === undefined, 'the excluded verb has a type');
      assert(
        typeof ctx.office.get(`${CAPABILITY}._excluded.send`) === 'string',
        'exclusion is not a queryable fact',
      );
      assert(!ctx.office.impls.has(`${CAPABILITY}.send`), 'send still has an implementation');
      // And the included surface WORKS through the alias:
      const out = await ctx.office.impls.get(`${CAPABILITY}.search`)!({ q: 'invoice' }) as { ids: string[] };
      assert(out.ids.length > 0, 'authorized capability call returned nothing');
    },
  },
  {
    n: 5,
    title: 'Add descriptions to the capability, transcluding self/team narratives BY LABEL ONLY',
    run: async (ctx) => {
      const r = await receiveDocument(ctx.office, [
        `${CAPABILITY}.search._description = "Search my personal mail. Owner: [[narratives.self]]"`,
        `${CAPABILITY}.get._description = "Fetch one of my messages. Team context: [[narratives.team]]"`,
        `${CAPABILITY}.labels._description = "My label taxonomy. Team context: [[narratives.team]]"`,
      ].join('\n'));
      assert(r.errors.length === 0, r.errors.join('; '));
      return [
        'descriptions authored with LABELS, unresolved:',
        `  ${CAPABILITY}.search → …[[narratives.self]]`,
        `  ${CAPABILITY}.get, ${CAPABILITY}.labels → …[[narratives.team]]`,
      ];
    },
    accept: async (ctx) => {
      const d = ctx.office.get(`${CAPABILITY}.search._description`);
      assert(typeof d === 'string' && d.includes('[[narratives.self]]'),
        'authoring resolved the label — election must happen at FRAME time, not now');
    },
  },
  {
    n: 6,
    title: '(Connector author) the manifest carries TIMEWISE COHERENCE per API — metadata only',
    run: async (ctx) => {
      const lines = ['per-API temporal metadata (from the manifest, beat 2):'];
      for (const api of ctx.office.keys('_connectors.mailbox.apis')) {
        const m = ctx.office.get(`_connectors.mailbox.apis.${api}`) as Record<string, unknown>;
        lines.push(`  ${api}: cacheable=${m.cacheable} hydratable=${m.hydratable} ttlMs=${m.ttlMs} read/min=${m.readPerMin} write/min=${m.writePerMin}`);
      }
      return lines;
    },
    accept: async (ctx) => {
      const m = ctx.office.get('_connectors.mailbox.apis.get') as { ttlMs?: number };
      assert(m?.ttlMs === 300_000, 'temporal metadata not kernel-readable data');
      assert(offerHydration(ctx.office, 'mailbox').length === 2,
        'the hydration offer does not derive from the metadata');
    },
  },
  {
    n: 7,
    title: 'Install asks: "save emails locally for speed?" → yes → local SQL tables hydrate',
    run: async (ctx) => {
      const offers = offerHydration(ctx.office, 'mailbox');
      const yes = await ctx.ask(
        `save emails locally for speed? (offer derived from: ${offers.map((o) => o.api).join(', ')}) [Y/n] `,
      );
      assert(yes, 'the walk needs the hydration to demonstrate beats 8-10');
      ctx.hydration = await hydrate(ctx.office, 'mailbox', CAPABILITY);
      const fact = ctx.office.get('_hydration.mailbox') as Record<string, unknown>;
      return [
        `hydrated into local SQL: ${ctx.hydration.emails} emails, ${ctx.hydration.stored} stored`,
        `the extent is a fact: _hydration.mailbox = ${JSON.stringify(fact)}`,
        'every hydration fetch went through the measured capability — the first observed posteriors now exist',
      ];
    },
    accept: async (ctx) => {
      const fact = ctx.office.get('_hydration.mailbox') as { emails?: number; stored?: number };
      assert(fact?.emails === 24 && fact?.stored === 24, 'hydration extent fact wrong');
      const row = ctx.hydration!.db.prepare('SELECT COUNT(*) AS n FROM emails').get() as { n: number };
      assert(row.n === 24, `SQL table holds ${row.n}, not 24`);
      const lat = ctx.office.get(`${CAPABILITY}.get._prior.latency`) as { samples?: number };
      assert((lat?.samples ?? 0) >= 24, 'hydration produced no observed posteriors');
    },
  },
  {
    n: 8,
    title: `office frame ${CAPABILITY} --maxtokens 2000 --duration 100s`,
    run: async (ctx) => {
      ctx.frame = vend(ctx.office, { query: CAPABILITY, maxTokens: 2000, ttlMs: 100_000 });
      ctx.office.insert({ path: '_hydration.mailbox.heldUntil', value: ctx.frame.expiresAt });
      ctx.frameBefore = ctx.frame.text;
      return ['the FT frame:', '─'.repeat(64), ...ctx.frame.text.split('\n'), '─'.repeat(64)];
    },
    accept: async (ctx) => {
      const f = ctx.frame!;
      // Budget-true.
      assert(approxTokens(f.text) <= 2000, 'frame exceeds its stated budget');
      // Annotations are OBSERVED posteriors, structurally consistent
      // with the mounted priors — never authored.
      const lat = ctx.office.get(`${CAPABILITY}.search._prior.latency`) as { rate: number };
      assert(f.text.includes(`~survival(exp, ${lat.rate})`), 'latency annotation is not the observed posterior');
      const rel = ctx.office.get(`${CAPABILITY}.search._prior.reliability`) as { alpha: number; beta: number };
      assert(f.text.includes(`${CAPABILITY}.search._reliability = { alpha: ${rel.alpha}, beta: ${rel.beta} }`),
        'reliability annotation is not the observed posterior');
      // The prelude chain forced the narratives to the top, elected by
      // budget, labels kept in the descriptions.
      const teamAt = f.text.indexOf('narratives.team = ');
      const selfAt = f.text.indexOf('narratives.self = ');
      const firstTool = f.text.indexOf(`${CAPABILITY}.get = `);
      assert(teamAt >= 0 && selfAt >= 0, 'narrative preludes missing');
      assert(teamAt < firstTool && selfAt < firstTool, 'preludes must precede definitions');
      assert(f.text.includes('[[narratives.self]]'), 'description lost its label reference');
      // THE STANDING GUARD: strip every `--` line; the frame must
      // reconstruct identically on a fresh kernel.
      const stripped = f.text.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
      const rx = new SequenceV2(() => ctx.clock.t);
      const rr = await receiveDocument(rx, stripped);
      assert(rr.errors.length === 0, `stripped frame does not receive: ${rr.errors.join('; ')}`);
      for (const t of f.tools) {
        assert(rx.rawTypeAt(t)?.kind === 'fn', `stripped frame lost ${t}`);
        const horizons = (rx.rawTypeAt(t)?.constraints ?? [])
          .map((c) => timeHorizon(c)).filter((h): h is number => h !== null);
        assert(horizons.includes(f.expiresAt), `stripped frame lost ${t}'s expiry constraint`);
      }
      // The secret never rides on a frame.
      assert(!f.text.includes(SECRET_KEY_VALUE), 'THE KEY VALUE LEAKED INTO THE FRAME');
      // Hydration is held for the stated duration.
      assert(ctx.office.get('_hydration.mailbox.heldUntil') === f.expiresAt, 'hydration hold not recorded');
    },
  },
  {
    n: 9,
    title: 'An agent calls a tool through the frame — and the NEXT frame\'s annotations have moved',
    run: async (ctx) => {
      // OPERATOR-SCRIPTED agent (fixed script, not model cognition):
      const before = (ctx.office.get(`${CAPABILITY}.search._prior.latency`) as { samples: number }).samples;
      // The frame's types are not decoration: a call violating the
      // manifest's refinement (message ids match /^m/) is refused by
      // name before the connector ever runs — and is NOT observed (a
      // caller's type error is not the endpoint's unreliability).
      const refused = await callThroughSession(ctx.office, ctx.frame!.sessionId, `${CAPABILITY}.get`, { id: 'x999' });
      assert(!refused.ok && (refused as { reason: string }).reason.includes('invalid-args'),
        'the refinement did not enforce at the call');
      const call = await callThroughSession(ctx.office, ctx.frame!.sessionId, `${CAPABILITY}.search`, { q: 'renewal' });
      assert(call.ok, `agent call refused: ${JSON.stringify(call)}`);
      const rv = revend(ctx.office, ctx.frame!.sessionId, { query: CAPABILITY });
      assert(rv.ok, 'revend refused');
      ctx.reVended = rv.text;
      const after = (ctx.office.get(`${CAPABILITY}.search._prior.latency`) as { samples: number }).samples;
      const line = (t: string) => t.split('\n').find((l) => l.startsWith(`${CAPABILITY}.search = `)) ?? '';
      return [
        `agent (scripted): ${CAPABILITY}.get({ id: "x999" }) → REFUSED (${(refused as { reason: string }).reason}) — refinements enforce at the call`,
        `agent (scripted): ${CAPABILITY}.search({ q: "renewal" }) → ${JSON.stringify(call.ok && call.value)}`,
        `observation recorded: samples ${before} → ${after}`,
        `frame annotation before: ${line(ctx.frameBefore!)}`,
        `frame annotation after:  ${line(rv.text)}`,
      ];
    },
    accept: async (ctx) => {
      // The loop is automatic at the office grain: observation →
      // conjugate update → the next vend reads the moved posterior.
      // search has 1 hydration observation + the agent's call = 2.
      const lat = ctx.office.get(`${CAPABILITY}.search._prior.latency`) as { rate: number; samples: number };
      assert(lat.samples >= 2, 'the call did not observe');
      assert(ctx.reVended!.includes(`~survival(exp, ${lat.rate})`),
        'the next frame does not carry the moved posterior');
      const rel = ctx.office.get(`${CAPABILITY}.search._prior.reliability`) as { alpha: number };
      assert(rel.alpha >= 2, 'reliability posterior did not move on success');
    },
  },
  {
    n: 10,
    title: 'Later: "where was my mail used, for what?" — usage at the capability grain',
    run: async (ctx) => {
      const keys = ctx.office.keys(`_usage.${CAPABILITY}`);
      const byTool = new Map<string, number>();
      for (const k of keys) {
        const u = ctx.office.get(`_usage.${CAPABILITY}.${k}`) as { tool: string };
        byTool.set(u.tool, (byTool.get(u.tool) ?? 0) + 1);
      }
      return [
        `${keys.length} uses of '${CAPABILITY}' on record:`,
        ...[...byTool.entries()].map(([t, n]) => `  ${t}: ${n} call(s)`),
        'each fact: { tool, at, ok } — session-stamped, key-free',
      ];
    },
    accept: async (ctx) => {
      const keys = ctx.office.keys(`_usage.${CAPABILITY}`);
      // 1 kit-verification search (beat 4) + 1 hydration search +
      // 24 hydration gets + 1 agent search (beat 9) = 27.
      assert(keys.length === 27, `expected 27 usage facts, found ${keys.length}`);
      for (const k of keys) {
        const u = ctx.office.get(`_usage.${CAPABILITY}.${k}`) as Record<string, unknown>;
        assert(typeof u.tool === 'string' && typeof u.at === 'number', 'usage fact malformed');
        assert(!JSON.stringify(u).includes(SECRET_KEY_VALUE), 'THE KEY VALUE LEAKED INTO USAGE');
      }
    },
  },
  {
    n: 11,
    title: 'Point a second office (or a bare planner) at TWO vended frames — one merged surface',
    run: async (ctx) => {
      // A SECOND frame from the same office — vended after the agent's
      // call, so its posteriors carry more evidence than the first.
      ctx.secondFrame = vend(ctx.office, { query: CAPABILITY, ttlMs: 50_000 });
      ctx.merged = await mergeFrames([ctx.frame!.text, ctx.secondFrame.text]);
      const line = (t: string, p: string) => t.split('\n').find((l) => l.startsWith(p)) ?? '';
      return [
        `merged ${2} frames → one surface: ${ctx.merged.tools.join(', ')}`,
        `temporal meet: ${line(ctx.merged.text, `${CAPABILITY}.search._validUntil`)} (the tighter of ${ctx.frame!.expiresAt} / ${ctx.secondFrame.expiresAt})`,
        `more-evidenced posterior superseded: ${line(ctx.merged.text, `${CAPABILITY}.search._reliability`)}`,
        `named conflicts: ${ctx.merged.conflicts.length === 0 ? 'none' : ctx.merged.conflicts.join('; ')}`,
        'a genuine contradiction would be NAMED and excluded — never silently overwritten',
      ];
    },
    accept: async (ctx) => {
      const merged = ctx.merged!;
      assert(merged.tools.includes(`${CAPABILITY}.search`), 'merged surface lost a tool');
      // Tightest consistent: the shorter validity wins.
      assert(merged.text.includes(`${CAPABILITY}.search._validUntil = ${ctx.secondFrame!.expiresAt}`),
        'merge did not take the tightest validity');
      assert(merged.conflicts.length === 0,
        `unexpected conflicts: ${merged.conflicts.join('; ')}`);
      // The more-evidenced reliability (the post-agent-call frame) won.
      const rel = ctx.office.get(`${CAPABILITY}.search._prior.reliability`) as { alpha: number; beta: number };
      assert(merged.text.includes(`${CAPABILITY}.search._reliability = { alpha: ${rel.alpha}, beta: ${rel.beta} }`),
        'merge did not keep the more-evidenced posterior');
      // And the merged frame is itself receivable — same standing guard.
      const rx = new SequenceV2(() => ctx.clock.t);
      const rr = await receiveDocument(rx, merged.text);
      assert(rr.errors.length === 0, `merged frame does not receive: ${rr.errors.join('; ')}`);
    },
  },
  {
    n: 12,
    title: 'Office B installs A\'s vended frame AS A CONNECTOR, narrows it, re-vends to C — closure',
    run: async (ctx) => {
      const b = new SequenceV2(() => ctx.clock.t);
      const rb = await receiveDocument(b, ctx.frame!.text);
      assert(rb.errors.length === 0, `B could not install A's frame: ${rb.errors.join('; ')}`);
      ctx.bTools = rb.tools.filter((t) => !t.startsWith('_'));
      const bVend = vend(b, { query: `${CAPABILITY}.search`, ttlMs: 3_600_000 });
      ctx.bSessionId = bVend.sessionId;
      // The chain reports: B's vend owes every upstream session word of
      // the re-vend; the WALK is the host transport and delivers them.
      for (const report of bVend.chainReports) {
        const delivered = await continueSession(ctx.office, report.session, report.ft);
        assert(delivered.ok, `chain report refused by ${report.session}`);
      }
      const c = new SequenceV2(() => ctx.clock.t);
      const rc = await receiveDocument(c, bVend.text);
      assert(rc.errors.length === 0, `C could not install B's re-vend: ${rc.errors.join('; ')}`);
      ctx.cTools = rc.tools.filter((t) => !t.startsWith('_'));
      ctx.cChain = c.get(`${CAPABILITY}.search._origin.chain`) as string | undefined;
      const m = new RegExp(`${CAPABILITY}\\.search\\._validUntil = (\\d+)`).exec(bVend.text);
      ctx.cValidUntil = m ? Number(m[1]) : undefined;
      return [
        `B installed A's frame (vend ∘ receive = install): ${ctx.bTools.join(', ')}`,
        `B re-vended a NARROWED surface to C: ${ctx.cTools.join(', ')}`,
        `temporal meet: C's grant expires ${ctx.cValidUntil} ≤ A's ${ctx.frame!.expiresAt}: ${ctx.cValidUntil! <= ctx.frame!.expiresAt}`,
        `C's provenance chain: "${ctx.cChain}"`,
        `A's chain view: _sessions.${ctx.frame!.sessionId}.chain → ${JSON.stringify(ctx.office.keys(`_sessions.${ctx.frame!.sessionId}.chain`))}`,
      ];
    },
    accept: async (ctx) => {
      // Monotone narrowing: C ⊆ B ⊆ A, and the verb A filtered exists
      // NOWHERE downstream.
      const aTools = ctx.frame!.tools;
      assert(ctx.bTools!.every((t) => aTools.includes(t)), 'B gained tools A never vended');
      assert(ctx.cTools!.every((t) => ctx.bTools!.includes(t)), 'C gained tools B never vended');
      assert(ctx.cTools!.length < ctx.bTools!.length, 'B\'s re-vend did not narrow');
      assert(!ctx.bTools!.includes(`${CAPABILITY}.send`) && !ctx.cTools!.includes(`${CAPABILITY}.send`),
        'the filtered verb re-appeared downstream');
      // Temporal meet: C's frame expires no later than A's session.
      assert(ctx.cValidUntil !== undefined && ctx.cValidUntil <= ctx.frame!.expiresAt,
        'C\'s grant outlives A\'s session');
      // Chain-grained provenance: A sees the re-vend at the capability
      // grain, and C holds the FULL chain.
      const links = ctx.office.keys(`_sessions.${ctx.frame!.sessionId}.chain`);
      assert(links.includes(ctx.bSessionId!), 'A does not see B\'s re-vend in its chain view');
      assert(ctx.cChain === `${ctx.frame!.sessionId} ${ctx.bSessionId}`,
        `C's chain is "${ctx.cChain}", expected the full A→B lineage`);
    },
  },
];
