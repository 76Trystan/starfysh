// Patch reach: where a patch may send the browser, and where a secret may go.
//
// Two things a heal must never do quietly. The first is take the run to a
// site the workflow has never visited: a page that talked the model into
// "the login moved to this address" would otherwise get the credentials
// typed into it. The second is change what happens to a secret: which
// secret is used, which step uses it, or which element it is typed into.
//
// A new origin and a changed secret reference are rejected outright. A new
// target on a step that types a secret is the one case with a legitimate
// reading (the password field was renamed), so it is not rejected, but it
// is never accepted without a person looking at it.

import { findStep } from '@sfysh/ir';
import type { StepPatch, Workflow } from '@sfysh/ir';
import { pointer, same } from './equal.js';

export type ReachViolationCode =
  /** The step the patch is anchored to is not in the workflow. */
  | 'unknown_step'
  /** A URL or URL condition names an origin the workflow does not already use. */
  | 'new_origin'
  /** The patch adds a `{secret}` reference. */
  | 'secret_added'
  /** The patch removes a `{secret}` reference. */
  | 'secret_removed'
  /** The patch points a `{secret}` reference at a different secret. */
  | 'secret_changed';

export interface ReachViolation {
  code: ReachViolationCode;
  /** JSON Pointer within the patch, for example `/after/url`. */
  path: string;
  /** What is wrong, for logs and for the reviewer. Does not quote patch content. */
  message: string;
}

export type ReachApprovalCode =
  /** The step types a secret, and the patch changes the element it is typed into. */
  'secret_retargeted';

export interface ReachApproval {
  code: ReachApprovalCode;
  /** JSON Pointer within the patch. */
  path: string;
  /** What the reviewer is being asked to confirm. Does not quote patch content. */
  message: string;
}

/**
 * Only `ok` means the patch may go ahead on its own. `needs_approval` means
 * it broke no rule but must not be accepted, auto-applied or shipped until
 * a person has confirmed each listed point.
 */
export type ReachResult =
  | { status: 'ok' }
  | { status: 'needs_approval'; approvals: ReachApproval[] }
  | { status: 'rejected'; violations: ReachViolation[] };

type Loose = Record<string, unknown>;

/** Fields that hold nested steps. */
const BODIES = ['then', 'else', 'do'] as const;
/** Fields that hold one condition. */
const CONDITION_FIELDS = ['forCondition', 'condition', 'if', 'while'] as const;
/** Fields that hold a list of conditions. */
const CONDITION_LISTS = ['pre', 'post'] as const;
/** Fields that hold a value source, which may be a `{secret}` reference. */
const VALUE_FIELDS = ['url', 'value'] as const;

/**
 * Check where a patch sends the browser and what it does with secrets.
 *
 * Origins. Every literal `navigate` URL, every `urlEquals` and every
 * origin written into a `urlMatches` pattern in the new step must already
 * be used somewhere in the workflow. A relative URL is fine. Anything that
 * is not plain http or https on a known host (`javascript:`, `data:`, a
 * protocol-relative `//host`) is a new origin.
 *
 * Secrets. A replacement must reference the same secrets in the same
 * fields as the step in the workflow. An inserted step must reference
 * none. A replacement that keeps the secret but changes the `target` it is
 * typed into comes back as `needs_approval`.
 *
 * The comparison is against the workflow, not the patch's own `before`.
 * Every violation is reported, not only the first.
 *
 * Limit: a `urlMatches` pattern that names a host without a scheme
 * (`evil\.test/login`) cannot be told apart from a path, so it is not
 * caught here. Such a condition can only be added, never swapped in for an
 * existing `post` condition, because `checkPatchScope` forbids that.
 */
export function checkPatchReach(patch: StepPatch, workflow: Workflow): ReachResult {
  const violations: ReachViolation[] = [];
  const approvals: ReachApproval[] = [];
  const after = patch.after as unknown as Loose;

  let current: Loose | undefined;
  if (patch.op === 'replace') {
    current = findStep(workflow, patch.stepId)?.step as unknown as Loose | undefined;
    if (current === undefined) {
      return {
        status: 'rejected',
        violations: [
          {
            code: 'unknown_step',
            path: '/stepId',
            message: 'The step the patch is anchored to is not in the workflow.',
          },
        ],
      };
    }
  }

  const known = new Set<string>();
  for (const step of workflow.steps as unknown as Loose[]) {
    for (const use of originUses(step, '')) for (const key of use.keys) known.add(key);
  }
  for (const use of originUses(after, '/after')) {
    if (!use.keys.some((key) => known.has(key))) {
      violations.push({
        code: 'new_origin',
        path: use.path,
        message: 'The URL names an origin the workflow does not already use.',
      });
    }
  }

  const before = current === undefined ? new Map<string, string>() : secretRefs(current, '');
  const now = secretRefs(after, '');
  for (const path of [...new Set([...before.keys(), ...now.keys()])].sort()) {
    const was = before.get(path);
    const is = now.get(path);
    if (was === is) continue;
    if (was === undefined) {
      violations.push({
        code: 'secret_added',
        path: `/after${path}`,
        message: 'A heal must not add a secret reference.',
      });
    } else if (is === undefined) {
      violations.push({
        code: 'secret_removed',
        path: `/after${path}`,
        message: 'A heal must not remove a secret reference.',
      });
    } else {
      violations.push({
        code: 'secret_changed',
        path: `/after${path}`,
        message: 'A heal must not point a secret reference at a different secret.',
      });
    }
  }

  if (current !== undefined && before.has('/value') && !same(current.target, after.target)) {
    approvals.push({
      code: 'secret_retargeted',
      path: '/after/target',
      message:
        'This step types a secret, and the patch changes which element it is typed into. Confirm the new target is the right field.',
    });
  }

  if (violations.length > 0) return { status: 'rejected', violations };
  if (approvals.length > 0) return { status: 'needs_approval', approvals };
  return { status: 'ok' };
}

interface OriginUse {
  /** JSON Pointer to the value that names the origin. */
  path: string;
  /** Keys this use is known by. It is allowed when any of them is already in the workflow. */
  keys: string[];
}

/** Every place a step, or a step nested in it, names an origin. */
function originUses(step: Loose, base: string): OriginUse[] {
  const uses: OriginUse[] = [];

  if (typeof step.url === 'string') {
    const origin = literalOrigin(step.url);
    if (origin !== undefined) uses.push({ path: `${base}/url`, keys: [origin] });
  }

  const visit = (condition: unknown, path: string) => {
    if (typeof condition !== 'object' || condition === null) return;
    const { urlEquals, urlMatches } = condition as Loose;
    if (typeof urlEquals === 'string') {
      const origin = literalOrigin(urlEquals);
      if (origin !== undefined) uses.push({ path: `${path}/urlEquals`, keys: [origin] });
    }
    if (typeof urlMatches === 'string') {
      for (const keys of patternOrigins(urlMatches)) {
        uses.push({ path: `${path}/urlMatches`, keys });
      }
    }
  };
  for (const field of CONDITION_FIELDS) visit(step[field], `${base}/${field}`);
  for (const field of CONDITION_LISTS) {
    const list = step[field];
    if (Array.isArray(list)) {
      list.forEach((condition, index) => visit(condition, `${base}/${field}/${index}`));
    }
  }

  for (const body of BODIES) {
    const nested = step[body];
    if (Array.isArray(nested)) {
      nested.forEach((child, index) => {
        if (typeof child === 'object' && child !== null) {
          uses.push(...originUses(child as Loose, `${base}/${body}/${index}`));
        }
      });
    }
  }
  return uses;
}

/** A host no real URL has, used to tell a relative URL from an absolute one. */
const RELATIVE_BASE = 'https://relative.invalid';

/**
 * The origin a literal URL leads to, or `undefined` for a relative URL,
 * which stays on whatever origin the run is already on. A URL the browser
 * would not treat as http or https on a named host gets a key that is
 * never in the known set.
 */
function literalOrigin(text: string): string | undefined {
  let url: URL;
  try {
    // The URL parser applies the same rules a browser does, including
    // reading "/\host" and "//host" as a different host.
    url = new URL(text, RELATIVE_BASE);
  } catch {
    return 'unparseable';
  }
  if (url.origin === RELATIVE_BASE) {
    // Either relative, or absolute and naming the placeholder host itself.
    return /^\s*https:/i.test(text) ? 'unparseable' : undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `scheme ${url.protocol}`;
  if (/^\s*[/\\]/.test(text)) return 'protocol-relative';
  return url.origin;
}

/**
 * The origins written into a `urlMatches` pattern. The pattern is a regex
 * or a substring, so this reads it as text: escapes are dropped, and every
 * `scheme://host` in it is one use. Each is known by its parsed origin
 * when the host is a plain one, and by its text as written, so a pattern
 * copied from elsewhere in the workflow still passes when its host part is
 * itself a regex.
 */
function patternOrigins(pattern: string): string[][] {
  const text = pattern.replace(/\\(.)/g, '$1');
  const found: string[][] = [];
  for (const match of text.matchAll(/[a-z][a-z0-9+.-]*:[/]{2}[^/?#\s]*/gi)) {
    const written = match[0].toLowerCase();
    const keys = [`pattern ${written}`];
    try {
      // An anchored pattern ends its host with "$", which is not part of it.
      const url = new URL(written.replace(/[$]$/, ''));
      if (url.protocol === 'http:' || url.protocol === 'https:') keys.push(url.origin);
    } catch {
      // A host part that is itself a regex. Only the text key applies.
    }
    found.push(keys);
  }
  return found;
}

/** Secret references in a step and the steps nested in it: JSON Pointer to secret name. */
function secretRefs(step: Loose, base: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const field of VALUE_FIELDS) {
    const source = step[field];
    if (typeof source === 'object' && source !== null && 'secret' in source) {
      refs.set(`${base}/${field}`, String((source as { secret: unknown }).secret));
    }
  }
  for (const body of BODIES) {
    const nested = step[body];
    if (Array.isArray(nested)) {
      nested.forEach((child, index) => {
        if (typeof child === 'object' && child !== null) {
          for (const [path, name] of secretRefs(
            child as Loose,
            `${base}/${pointer(body)}/${index}`,
          )) {
            refs.set(path, name);
          }
        }
      });
    }
  }
  return refs;
}
