/**
 * storyboard-ledger.ts — the beats known NOT to pass yet.
 *
 * The ratchet contract (same as the kernel's VENDING_LEDGER):
 *   · a beat NOT listed here must pass
 *   · a listed beat that STARTS passing fails the suite (and the walk)
 *     until it is struck from this list — progress is recorded, never
 *     silent.
 *
 * 11 — frame-level merge of two vended documents (kernel scenario V17)
 * 12 — closure: monotone narrowing + temporal meet HOLD today; what
 *      ledgers the beat is chain-grained provenance (kernel V19)
 */
export const STORYBOARD_LEDGER: number[] = [11, 12];
