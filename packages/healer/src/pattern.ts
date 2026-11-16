// Limits on `urlMatches` patterns a patch introduces.
//
// The runtime and generated code compile a `urlMatches` string into a
// regular expression and run it against the page URL. A pattern such as
// `(a+)+$` is valid and can hold the event loop for minutes on a long URL,
// and a URL is something the site controls. Patterns a person wrote and
// approved are left alone. A pattern a model wrote has to pass these
// limits before the patch that carries it is applied or run.

import type { StepPatch, Workflow } from '@sfysh/ir';
import { eachStep, ownConditions } from './walk.js';
import type { LooseStep } from './walk.js';

/** Longest `urlMatches` pattern a patch may introduce. */
export const URL_PATTERN_MAX_CHARS = 200;

/**
 * Most unbounded quantifiers (`*`, `+`, `{n,}`) a new pattern may hold.
 * Several of them in a row can backtrack against each other without any
 * nesting (`.*.*.*.*x`), and the cost grows with each one.
 */
export const URL_PATTERN_MAX_UNBOUNDED = 3;

export type UrlPatternProblem =
  /** Longer than `URL_PATTERN_MAX_CHARS`. */
  | 'too_long'
  /** Not a valid regular expression. Generated code would throw on it. */
  | 'invalid'
  /** A repeated group whose body also repeats, such as `(a+)+`. */
  | 'nested_quantifier'
  /** More than `URL_PATTERN_MAX_UNBOUNDED` unbounded quantifiers. */
  | 'too_many_quantifiers';

/**
 * Check one `urlMatches` pattern. Returns the first problem found, or
 * `undefined` when the pattern is within the limits.
 *
 * The nested-quantifier rule is structural and errs on the side of
 * refusing: a group that can repeat (`*`, `+`, `{n,}`, `{n,m}` above one)
 * must not contain anything of variable length (`*`, `+`, `?`, `{n,}`,
 * `{n,m}`). Some harmless patterns fail it, for example `(/\d+)*`. It does
 * not catch a repeated alternation whose branches overlap, such as
 * `(a|a)*`.
 */
export function checkUrlPattern(pattern: string): UrlPatternProblem | undefined {
  if (pattern.length > URL_PATTERN_MAX_CHARS) return 'too_long';
  try {
    new RegExp(pattern);
  } catch {
    return 'invalid';
  }

  // One entry per open group: whether its body holds a variable-length part.
  const open: boolean[] = [];
  let unbounded = 0;
  const markVariable = () => {
    if (open.length > 0) open[open.length - 1] = true;
  };

  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '\\') {
      i += 2;
    } else if (char === '[') {
      i += 1;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i += 1;
    } else if (char === '(') {
      open.push(false);
      // Skip the "?" of "(?:", "(?=", "(?<name>" so it is not read as a quantifier.
      i += pattern[i + 1] === '?' ? 2 : 1;
      continue;
    } else if (char === ')') {
      const bodyVariable = open.pop() ?? false;
      i += 1;
      const quantifier = readQuantifier(pattern, i);
      if (quantifier !== undefined) {
        if (quantifier.repeats && bodyVariable) return 'nested_quantifier';
        if (quantifier.unbounded) unbounded += 1;
        i += quantifier.length;
      }
      if (bodyVariable || quantifier?.variable === true) markVariable();
      continue;
    } else {
      i += 1;
    }

    // A quantifier on the atom just read.
    const quantifier = readQuantifier(pattern, i);
    if (quantifier !== undefined) {
      if (quantifier.variable) markVariable();
      if (quantifier.unbounded) unbounded += 1;
      i += quantifier.length;
    }
  }

  return unbounded > URL_PATTERN_MAX_UNBOUNDED ? 'too_many_quantifiers' : undefined;
}

interface Quantifier {
  /** Characters it takes up, including a trailing lazy `?`. */
  length: number;
  /** It can match more than once. */
  repeats: boolean;
  /** It has no upper limit. */
  unbounded: boolean;
  /** What it matches can vary in length. */
  variable: boolean;
}

function readQuantifier(pattern: string, at: number): Quantifier | undefined {
  const char = pattern[at];
  let found: Quantifier;
  if (char === '*' || char === '+') {
    found = { length: 1, repeats: true, unbounded: true, variable: true };
  } else if (char === '?') {
    found = { length: 1, repeats: false, unbounded: false, variable: true };
  } else if (char === '{') {
    const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(at));
    if (match === null) return undefined;
    const min = Number(match[1]);
    const isRange = match[2] !== undefined;
    const isOpen = isRange && match[3] === '';
    const max = isOpen ? Infinity : isRange ? Number(match[3]) : min;
    found = {
      length: match[0].length,
      repeats: max > 1,
      unbounded: isOpen,
      variable: max !== min,
    };
  } else {
    return undefined;
  }
  // A "?" straight after a quantifier makes it lazy. It is not a second one.
  if (pattern[at + found.length] === '?') found.length += 1;
  return found;
}

export type PatternViolationCode =
  | 'pattern_too_long'
  | 'pattern_invalid'
  | 'pattern_nested_quantifier'
  | 'pattern_too_many_quantifiers';

export interface PatternViolation {
  code: PatternViolationCode;
  /** JSON Pointer within the patch, for example `/after/pre/0/urlMatches`. */
  path: string;
  /** What is wrong, for logs and for the reviewer. Does not quote the pattern. */
  message: string;
}

export type PatternResult = { ok: true } | { ok: false; violations: PatternViolation[] };

const MESSAGES: Record<UrlPatternProblem, string> = {
  too_long: `A new urlMatches pattern must be at most ${URL_PATTERN_MAX_CHARS} characters.`,
  invalid: 'A new urlMatches pattern must be a valid regular expression.',
  nested_quantifier:
    'A new urlMatches pattern must not repeat a group whose contents can vary in length.',
  too_many_quantifiers: `A new urlMatches pattern may use at most ${URL_PATTERN_MAX_UNBOUNDED} unbounded quantifiers.`,
};

/**
 * Check every `urlMatches` pattern a patch introduces.
 *
 * A pattern that already appears somewhere in the workflow, character for
 * character, is not checked: a person put it there, and refusing it would
 * make any step that carries one impossible to heal. Every other pattern
 * in the new step, at any depth, must pass `checkUrlPattern`.
 */
export function checkPatchPatterns(patch: StepPatch, workflow: Workflow): PatternResult {
  const existing = new Set<string>();
  for (const step of workflow.steps as unknown as LooseStep[]) {
    for (const use of patterns(step, '')) existing.add(use.pattern);
  }

  const violations: PatternViolation[] = [];
  for (const use of patterns(patch.after as unknown as LooseStep, '/after')) {
    if (existing.has(use.pattern)) continue;
    const problem = checkUrlPattern(use.pattern);
    if (problem !== undefined) {
      violations.push({ code: `pattern_${problem}`, path: use.path, message: MESSAGES[problem] });
    }
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

function patterns(root: LooseStep, base: string): Array<{ pattern: string; path: string }> {
  const found: Array<{ pattern: string; path: string }> = [];
  eachStep(root, base, (step, at) => {
    for (const { condition, path } of ownConditions(step, at)) {
      if (typeof condition.urlMatches === 'string') {
        found.push({ pattern: condition.urlMatches, path: `${path}/urlMatches` });
      }
    }
  });
  return found;
}
