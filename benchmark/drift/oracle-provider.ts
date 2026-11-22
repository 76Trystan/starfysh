// A provider that answers with the case's oracle heal instead of asking a
// model. It costs nothing and its answers are known to be right, so a run
// with it tests the harness end to end: the prompt reaches a provider, the
// answer goes through the healer's own parsing, checks and verification,
// the patch is applied and judged, and the corpus gets its records. A
// failure here is a harness or healer bug, never a model's mistake.
//
// It answers only the patch class the oracle names at this point in the
// case; every other prompt gets "cannot heal", as an honest model would.

import type { Workflow } from '@sfysh/ir';
import { INSERT_STEP_SYSTEM_PROMPT, SELECTOR_SYSTEM_PROMPT } from '@sfysh/healer';
import type { Completion, Message, Provider } from '@sfysh/providers';
import type { SuiteCase } from './case-kit.js';
import { buildPatch, classOf } from './oracle.js';
import type { OraclePatch } from './oracle.js';

export class OracleProvider implements Provider {
  readonly name = 'oracle';
  readonly model = 'oracle';
  private next: { workflow: Workflow; patch: OraclePatch } | undefined;

  /** Pass as `DriftHealOptions.beforeHeal`: points the provider at the oracle patch for this heal. */
  readonly beforeHeal = (input: { driftCase: SuiteCase; workflow: Workflow; index: number }) => {
    const patch = input.driftCase.oracle?.[input.index];
    this.next = patch === undefined ? undefined : { workflow: input.workflow, patch };
  };

  complete(messages: Message[]): Promise<Completion> {
    const system = messages.find((m) => m.role === 'system')?.content;
    const asked =
      system === SELECTOR_SYSTEM_PROMPT
        ? 'selector'
        : system === INSERT_STEP_SYSTEM_PROMPT
          ? 'insert_step'
          : undefined;
    let answer: unknown = { cannotHeal: true, rationale: 'The oracle has no answer for this.' };
    if (this.next !== undefined && classOf(this.next.patch) === asked) {
      // The healer replaces an inserted step's id with its own.
      const patch = buildPatch(this.next.workflow, this.next.patch, () => 'healed_000');
      answer =
        asked === 'selector'
          ? { after: patch.after, rationale: 'Oracle heal.', confidence: 0.9 }
          : { step: patch.after, rationale: 'Oracle heal.', confidence: 0.9 };
    }
    return Promise.resolve({
      content: JSON.stringify(answer),
      stopReason: 'end',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: this.model,
    });
  }
}
