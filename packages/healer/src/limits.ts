// Caps on how much healing one failure, and one workflow, may cost.
//
// A heal calls a model, and a model call costs money and can be steered
// by the page it reads. Without caps a workflow that fails every hour on a
// site the healer cannot fix would call the model every hour, forever, and
// a heal that keeps producing patches that fail verification would keep
// asking. Three limits stop that:
//
// - attempts per failure: model calls within one `heal()`;
// - tokens per heal: input plus output tokens summed over those calls;
// - heals per workflow per day: `heal()` runs that reached the model for
//   one workflow in a rolling 24 hours, whatever their outcome.
//
// The daily count needs to survive between processes, so it is kept in a
// `HealHistory` the caller supplies. `MemoryHealHistory` is enough for
// tests and for one long-lived process.

export interface HealLimits {
  /** Most model calls in one `heal()`, across both patch classes. */
  maxAttemptsPerFailure: number;
  /** Most input plus output tokens in one `heal()`. */
  maxTokensPerHeal: number;
  /** Most `heal()` runs that reach a model for one workflow in any 24 hours. */
  maxHealsPerWorkflowPerDay: number;
}

/**
 * Starting values. Three attempts covers one try per patch class plus one
 * retry after a transient provider error. 20,000 tokens is several times a
 * typical heal prompt (a 60,000-character snapshot is about 15,000 tokens)
 * plus answers. Three heals a day lets a workflow recover from a redesign
 * and a follow-up change without letting a hopeless one run all day.
 */
export const DEFAULT_HEAL_LIMITS: Readonly<HealLimits> = Object.freeze({
  maxAttemptsPerFailure: 3,
  maxTokensPerHeal: 20_000,
  maxHealsPerWorkflowPerDay: 3,
});

/** Length of the window `maxHealsPerWorkflowPerDay` counts over, in milliseconds. */
export const HEAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Where past heal runs are counted. Implement it over whatever the caller
 * already stores run history in. Both methods may be synchronous or return
 * a promise.
 */
export interface HealHistory {
  /** Number of heal runs recorded for this workflow at or after `since`. */
  count(workflowId: string, since: Date): number | Promise<number>;
  /** Record that a heal run for this workflow started at `at`. */
  record(workflowId: string, at: Date): void | Promise<void>;
}

/** A `HealHistory` held in memory. Lost when the process exits. */
export class MemoryHealHistory implements HealHistory {
  private readonly runs = new Map<string, number[]>();

  count(workflowId: string, since: Date): number {
    const from = since.getTime();
    return (this.runs.get(workflowId) ?? []).filter((at) => at >= from).length;
  }

  record(workflowId: string, at: Date): void {
    const list = this.runs.get(workflowId) ?? [];
    list.push(at.getTime());
    this.runs.set(workflowId, list);
  }
}

/**
 * Fill in defaults and check the values. Throws `RangeError` for a limit
 * that is not a positive whole number, because a zero or negative cap is
 * almost certainly a mistake and silently healing nothing would hide it.
 */
export function resolveHealLimits(limits: Partial<HealLimits> = {}): HealLimits {
  const resolved = { ...DEFAULT_HEAL_LIMITS, ...limits };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(
        `Heal limit ${name} must be a whole number of at least 1, not ${value}.`,
      );
    }
  }
  return resolved;
}
