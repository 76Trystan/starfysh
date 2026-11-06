import type { Condition } from '@sfysh/ir';
import type { CallChain } from './walker.js';
import { unquote } from './selectors.js';

export function extractCondition(chain: CallChain): Condition | undefined {
  if (chain.root !== 'expect') return undefined;
  if (chain.links.length < 2) return undefined;

  const expectLink = chain.links[0]!;
  const assertionLink = chain.links[chain.links.length - 1]!;
  const subject = expectLink.args[0]?.trim();
  if (!subject) return undefined;

  return mapAssertion(subject, assertionLink.method, assertionLink.args);
}

function mapAssertion(subject: string, method: string, args: string[]): Condition | undefined {
  switch (method) {
    case 'toHaveURL': {
      const url = unquote(args[0] ?? '');
      return url !== undefined ? { urlEquals: url } : undefined;
    }
    case 'toBeVisible':
      return subjectToVisible(subject);
    case 'toBeHidden':
      return subjectToAbsent(subject);
    case 'toContainText':
    case 'toHaveText': {
      const text = unquote(args[0] ?? '');
      return text !== undefined ? { textPresent: text } : undefined;
    }
    default:
      return undefined;
  }
}

const GET_BY_TEXT_RE = /^page\.getByText\(\s*(['"`])(.+?)\1\s*\)$/;
const GET_BY_LABEL_RE = /^page\.getByLabel\(\s*(['"`])(.+?)\1\s*\)$/;
const GET_BY_TEST_ID_RE = /^page\.getByTestId\(\s*(['"`])(.+?)\1\s*\)$/;
const GET_BY_ROLE_RE =
  /^page\.getByRole\(\s*(['"`])(\w+)\1(?:\s*,\s*\{[^}]*name\s*:\s*(['"`])(.+?)\3[^}]*\})?\s*\)$/;
const LOCATOR_RE = /^page\.locator\(\s*(['"`])(.+?)\1\s*\)$/;

function subjectToVisible(subject: string): Condition | undefined {
  let m: RegExpMatchArray | null;

  m = subject.match(GET_BY_TEXT_RE);
  if (m) return { textPresent: m[2]! };

  m = subject.match(LOCATOR_RE);
  if (m) return { selectorVisible: m[2]! };

  m = subject.match(GET_BY_TEST_ID_RE);
  if (m) return { selectorVisible: `[data-testid="${m[2]!}"]` };

  m = subject.match(GET_BY_LABEL_RE);
  if (m) return { textPresent: m[2]! };

  m = subject.match(GET_BY_ROLE_RE);
  if (m) {
    const name = m[4];
    if (name) return { textPresent: name };
    return { selectorVisible: `[role="${m[2]!}"]` };
  }

  return undefined;
}

function subjectToAbsent(subject: string): Condition | undefined {
  let m: RegExpMatchArray | null;

  m = subject.match(LOCATOR_RE);
  if (m) return { selectorAbsent: m[2]! };

  m = subject.match(GET_BY_TEST_ID_RE);
  if (m) return { selectorAbsent: `[data-testid="${m[2]!}"]` };

  m = subject.match(GET_BY_ROLE_RE);
  if (m) return { selectorAbsent: `[role="${m[2]!}"]` };

  return undefined;
}
