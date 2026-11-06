// Selector extraction from walker CallChains.
//
// Recognizes Playwright locator methods (getByRole, getByTestId, getByText,
// getByLabel, locator) and maps them to IR SelectorCandidate / Target objects.
// This is the bridge between the syntax-only walker and the IR-aware layers
// that produce Steps.

import type { SelectorCandidate, Target } from '@sfysh/ir';
import type { ChainLink } from './walker.js';

const LOCATOR_METHODS: ReadonlySet<string> = new Set([
  'getByRole',
  'getByTestId',
  'getByText',
  'getByLabel',
  'locator',
]);

export function isLocatorLink(link: ChainLink): boolean {
  return LOCATOR_METHODS.has(link.method);
}

/**
 * Extract a SelectorCandidate from a single locator chain link.
 * Returns undefined if the link is not a recognized locator method or if
 * its argument is not a static string literal.
 */
export function extractCandidate(link: ChainLink): SelectorCandidate | undefined {
  const firstArg = link.args[0];
  if (!firstArg) return undefined;

  switch (link.method) {
    case 'getByRole':
      return extractRole(link.args);
    case 'getByTestId': {
      const v = unquote(firstArg);
      return v !== undefined ? { kind: 'testid', value: v } : undefined;
    }
    case 'getByText': {
      const v = unquote(firstArg);
      return v !== undefined ? { kind: 'text', value: v } : undefined;
    }
    case 'getByLabel': {
      const v = unquote(firstArg);
      return v !== undefined ? { kind: 'label', value: v } : undefined;
    }
    case 'locator': {
      const v = unquote(firstArg);
      return v !== undefined ? { kind: 'css', value: v } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Extract a Target from the locator links in a chain.
 *
 * Chained locators in Playwright narrow scope (they are not alternatives for
 * the same element). The IR's candidates array represents ranked fallbacks.
 * For a compound chain like `page.locator('.form').getByLabel('Email')`, we
 * take the innermost (last) locator as the primary candidate since it
 * identifies the actual target element.
 */
export function extractTarget(links: ChainLink[]): Target | undefined {
  const candidates: SelectorCandidate[] = [];
  for (const link of links) {
    const candidate = extractCandidate(link);
    if (candidate) candidates.push(candidate);
  }
  if (candidates.length === 0) return undefined;

  const primary = candidates[candidates.length - 1]!;
  return { candidates: [primary] };
}

function extractRole(args: string[]): SelectorCandidate | undefined {
  const role = args[0] !== undefined ? unquote(args[0]) : undefined;
  if (role === undefined) return undefined;

  const optionsArg = args[1];
  if (!optionsArg) return { kind: 'role', value: role };

  const attrs = parseObjectLiteral(optionsArg);
  const entries = Object.entries(attrs);
  if (entries.length === 0) return { kind: 'role', value: role };

  // Produce the IR's role[attr='value'] syntax so the compiler can roundtrip it.
  const attrStr = entries.map(([k, v]) => `${k}='${v}'`).join('][');
  return { kind: 'role', value: `${role}[${attrStr}]` };
}

/**
 * Strip surrounding quotes from a raw TypeScript source string.
 * Returns undefined if the string is not a quoted literal (e.g. a variable
 * reference or complex expression).
 */
export function unquote(raw: string): string | undefined {
  const trimmed = raw.trim();
  for (const q of ["'", '"', '`']) {
    if (trimmed.startsWith(q) && trimmed.endsWith(q) && trimmed.length >= 2) {
      return trimmed.slice(1, -1);
    }
  }
  return undefined;
}

/**
 * Parse a simple TypeScript object literal like `{ name: 'Submit' }` into
 * string-valued key-value pairs. Non-string values (booleans, numbers,
 * expressions) are silently skipped.
 */
function parseObjectLiteral(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out[m[1]!] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}
