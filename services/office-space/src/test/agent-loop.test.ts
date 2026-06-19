/**
 * agent-loop.test.ts — Local root-loop agent, end-to-end with a mock LLM.
 *
 * Verifies the four spec acceptance criteria the loop directly satisfies:
 *
 *   AC (semantickernel R1)  state.is_renderable_as_prompt
 *   AC (contextfeedback R1) turn record contains prompt + response + applied + violations
 *   AC (contextfeedback R3) violations from turn N appear in prompt for turn N+1
 *   AC (contextfeedback R5) loop terminates 'converged' OR 'exhausted'
 *
 * The LLM is a function returning fixed ft text. No network. No fixtures.
 */

import { Sequence, FT } from '@console-one/sequence';
import { agentTick, agentLoop, type LLMCall } from '@console-one/sequenceutils/agent';

let seq: Sequence;

beforeEach(() => {
  seq = new Sequence(() => Date.now());
});

/** Build a deterministic LLM that returns a queue of fixed responses. */
function fixedLLM(responses: string[]): LLMCall {
  let i = 0;
  return async () => {
    const content = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: true, response: { content } };
  };
}

describe('agent-loop — local root loop', () => {
  test('single tick: prompt rendered, response mounted, turn record written', async () => {
    // Set up a gap the LLM can fill.
    seq.mount('schema', 'work.x', FT.string());

    const llm = fixedLLM(['work.x = "done"']);

    const rec = await agentTick(seq, llm, 'agents.alpha', 0);

    // Prompt was rendered from current state — gap line for work.x present.
    expect(rec.prompt).toContain('work.x');

    // Response was applied — value visible after tick.
    expect(seq.get('work.x')).toBe('done');
    expect(rec.appliedPaths).toContain('work.x');
    expect(rec.violations).toEqual([]);

    // Turn record persisted under the agent's scope.
    expect(seq.get('agents.alpha.turns.t0.prompt')).toBe(rec.prompt);
    expect(seq.get('agents.alpha.turns.t0.response')).toBe('work.x = "done"');
    expect(seq.get('agents.alpha.turns.t0.unresolvedBefore')).toBeGreaterThanOrEqual(1);
    expect(seq.get('agents.alpha.turns.t0.unresolvedAfter')).toBeLessThan(
      seq.get('agents.alpha.turns.t0.unresolvedBefore') as number,
    );
  });

  test('violation in turn N appears in prompt for turn N+1 (contextfeedback R3)', async () => {
    // Constraint: model must match a regex of two literals.
    seq.mount('schema', 'config.model', FT.string().pattern('^(gpt-4|claude)$'));

    // Turn 0: LLM emits an invalid value (rejected by admission).
    // Turn 1: LLM emits a valid value.
    const llm = fixedLLM([
      'config.model = "bogus-model"',
      'config.model = "gpt-4"',
    ]);

    const rec0 = await agentTick(seq, llm, 'agents.beta', 0);
    expect(rec0.violations.length).toBeGreaterThan(0);
    expect(rec0.violations[0].path).toContain('config.model');
    // Value did NOT land — admission rejected.
    expect(seq.get('config.model')).not.toBe('bogus-model');

    const rec1 = await agentTick(seq, llm, 'agents.beta', 1);

    // Turn 1 prompt carries the prior turn's violation in the corrective block.
    expect(rec1.prompt).toContain('Violations from prior turn');
    expect(rec1.prompt).toContain('config.model');

    // Turn 1 applied the valid value.
    expect(seq.get('config.model')).toBe('gpt-4');
    expect(rec1.violations).toEqual([]);
  });

  test('loop converges when LLM fills all gaps (contextfeedback R5 — converged)', async () => {
    seq.mount('schema', 'work.a', FT.number());
    seq.mount('schema', 'work.b', FT.number());

    const llm = fixedLLM([
      'work.a = 1',
      'work.b = 2',
    ]);

    const result = await agentLoop(seq, llm, 'agents.gamma', 5);

    expect(result.status).toBe('converged');
    expect(result.turns).toBeLessThanOrEqual(2);
    expect(seq.get('work.a')).toBe(1);
    expect(seq.get('work.b')).toBe(2);
  });

  test('loop exhausts budget when LLM cannot resolve gaps (contextfeedback R5 — exhausted)', async () => {
    seq.mount('schema', 'work.x', FT.number().min(11));

    // LLM keeps emitting values that fail the constraint.
    const llm = fixedLLM([
      'work.x = 1',
      'work.x = 2',
      'work.x = 3',
    ]);

    const result = await agentLoop(seq, llm, 'agents.delta', 3);

    expect(result.status).toBe('exhausted');
    expect(result.turns).toBe(3);
    expect(result.records.every(r => r.violations.length > 0)).toBe(true);
  });

});
