/**
 * storyboard-walk.test.ts — the canonical artifact: one ordered
 * walkthrough of the 12 beats at the office level, each beat a stage
 * with its acceptance assertion, under the ratchet contract:
 *
 *   · a beat NOT in walk/storyboard-ledger.ts must pass
 *   · a ledgered beat that STARTS passing fails the suite until struck
 *
 * The beats are stateful and ordered by design — this is a walk, not a
 * bag of units (same genus as the kernel's vending-endstate suite,
 * which is the unit layer beneath beats 5/8/9).
 */

import { BEATS, newWalkContext, type WalkContext } from '../walk/beats';
import { walkLedger } from '../walk/runner';

describe('THE STORYBOARD WALK — 12 beats, office level', () => {
  const ledger = walkLedger();
  const ctx: WalkContext = newWalkContext(async () => true /* scripted consent, labeled */);

  for (const beat of BEATS) {
    const ledgered = ledger.has(beat.n);
    test(`beat ${beat.n} · ${beat.title}${ledgered ? '  [LEDGERED GAP — must still fail]' : ''}`, async () => {
      try {
        await beat.run(ctx);
      } catch (e) {
        if (!ledgered) throw e;
      }
      if (!ledgered) {
        await beat.accept(ctx);
        return;
      }
      let passed = false;
      try {
        await beat.accept(ctx);
        passed = true;
      } catch {
        /* still a gap — documented, not silent */
      }
      if (passed) {
        throw new Error(
          `beat ${beat.n} now passes — strike it from walk/storyboard-ledger.ts to record the ratchet.`,
        );
      }
    });
  }
});
