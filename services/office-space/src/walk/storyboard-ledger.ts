/**
 * storyboard-ledger.ts — the beats known NOT to pass yet.
 *
 * The ratchet contract (same as the kernel's VENDING_LEDGER):
 *   · a beat NOT listed here must pass
 *   · a listed beat that STARTS passing fails the suite (and the walk)
 *     until it is struck from this list — progress is recorded, never
 *     silent.
 *
 * EMPTY as of 2026-07-25: beats 11 (frame merge, kernel V17) and 12
 * (chain provenance, kernel V19) were struck when those scenarios
 * landed. The kernel's own remaining gaps (V14 refinement round-trip,
 * V16 type-expansion tokens) refine beats already passing at the
 * office grain — they live in sequence specs/impl/VENDING_LEDGER.json.
 */
export const STORYBOARD_LEDGER: number[] = [];
