/**
 * runner.ts — walks the 12 beats in a terminal.
 *
 * Interactive (default): one beat at a time, Enter to advance, real
 * consent prompts. Scripted (--scripted): no prompts (consent answers
 * yes, labeled), full transcript to stdout — the mode CI and the GIF
 * tape drive, so the recording can never show something the code
 * doesn't do.
 *
 * Exit contract (the ratchet, same as the test suite):
 *   0 — every non-ledgered beat passed AND every ledgered beat failed
 *   1 — a non-ledgered beat failed (regression) OR a ledgered beat
 *       passed (progress unrecorded: strike it from the ledger).
 */

import * as readline from 'node:readline';
import { BEATS, newWalkContext } from './beats';
import { STORYBOARD_LEDGER } from './storyboard-ledger';

export function walkLedger(): Set<number> {
  return new Set(STORYBOARD_LEDGER);
}

export async function runWalk(opts: { scripted: boolean }): Promise<number> {
  const ledger = walkLedger();
  const rl = opts.scripted
    ? null
    : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string): Promise<boolean> => {
    if (!rl) {
      console.log(`${q}[scripted: yes]`);
      return true;
    }
    const a = await new Promise<string>((res) => rl.question(q, res));
    return a.trim() === '' || /^y/i.test(a);
  };
  const pause = async (): Promise<void> => {
    if (!rl) return;
    await new Promise<string>((res) => rl.question('  ⏎ next beat ', res));
  };

  const ctx = newWalkContext(ask);
  let regressions = 0;
  let unstruck = 0;
  const results: string[] = [];

  console.log('THE STORYBOARD WALK — 12 beats, office level, on the v2 kernel');
  console.log('(the connector is a LOCAL SIMULATOR, labeled; every posterior below is observed, never authored)\n');

  for (const beat of BEATS) {
    const ledgered = ledger.has(beat.n);
    console.log(`━━ beat ${beat.n} ─ ${beat.title}${ledgered ? '   [LEDGERED — expected to fail]' : ''}`);
    try {
      const lines = await beat.run(ctx);
      for (const l of lines) console.log(`  ${l}`);
    } catch (e) {
      console.log(`  (run halted: ${(e as Error).message})`);
    }
    let passed = false;
    let failMsg = '';
    try {
      await beat.accept(ctx);
      passed = true;
    } catch (e) {
      failMsg = (e as Error).message;
    }
    if (!ledgered && passed) {
      console.log('  ✓ acceptance holds');
      results.push(`beat ${beat.n}: PASS`);
    } else if (!ledgered && !passed) {
      console.log(`  ✗ ACCEPTANCE FAILED: ${failMsg}`);
      results.push(`beat ${beat.n}: FAIL — ${failMsg}`);
      regressions++;
    } else if (ledgered && !passed) {
      console.log(`  ▢ still unbuilt (ledgered): ${failMsg}`);
      results.push(`beat ${beat.n}: LEDGERED (still failing, as recorded)`);
    } else {
      console.log('  ⚠ LEDGERED BEAT NOW PASSES — strike it from storyboard-ledger.ts to record the ratchet');
      results.push(`beat ${beat.n}: RATCHET VIOLATION — passes but still ledgered`);
      unstruck++;
    }
    console.log('');
    await pause();
  }

  rl?.close();
  console.log('━━ the ledger');
  for (const r of results) console.log(`  ${r}`);
  const ok = regressions === 0 && unstruck === 0;
  console.log(ok
    ? '\nwalk complete: every built beat enforced, every unbuilt beat loud.'
    : `\nwalk BROKEN: ${regressions} regression(s), ${unstruck} unstruck ratchet(s).`);
  return ok ? 0 : 1;
}
