// Walking a step the way the patch checks need to: the step itself, the
// steps nested inside it, and every condition each of them carries.

export type LooseStep = Record<string, unknown>;

/** Fields that hold nested steps. */
export const BODIES = ['then', 'else', 'do'] as const;
/** Fields that hold one condition. */
const CONDITION_FIELDS = ['forCondition', 'condition', 'if', 'while'] as const;
/** Fields that hold a list of conditions. */
const CONDITION_LISTS = ['pre', 'post'] as const;

/**
 * Call `visit` for a step and then for every step nested in it, at any
 * depth, with the JSON Pointer of each.
 */
export function eachStep(
  step: LooseStep,
  base: string,
  visit: (step: LooseStep, path: string) => void,
): void {
  visit(step, base);
  for (const body of BODIES) {
    const nested = step[body];
    if (!Array.isArray(nested)) continue;
    nested.forEach((child, index) => {
      if (typeof child === 'object' && child !== null) {
        eachStep(child as LooseStep, `${base}/${body}/${index}`, visit);
      }
    });
  }
}

/** The conditions a step carries itself, not those of nested steps, with the JSON Pointer of each. */
export function ownConditions(
  step: LooseStep,
  base: string,
): Array<{ condition: LooseStep; path: string }> {
  const found: Array<{ condition: LooseStep; path: string }> = [];
  const add = (condition: unknown, path: string) => {
    if (typeof condition === 'object' && condition !== null) {
      found.push({ condition: condition as LooseStep, path });
    }
  };
  for (const field of CONDITION_FIELDS) add(step[field], `${base}/${field}`);
  for (const field of CONDITION_LISTS) {
    const list = step[field];
    if (Array.isArray(list)) {
      list.forEach((condition, index) => add(condition, `${base}/${field}/${index}`));
    }
  }
  return found;
}
