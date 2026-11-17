// The semantic diff: what a patch changes, in terms a reviewer reads.
//
// `diffPatch` in `@sfysh/ir` gives field-level changes as JSON Pointers.
// That is exact but noisy for the commonest heal. Ranked selector
// candidates are compared position by position, so promoting the second
// candidate to first shows as a change at every index, and putting a new
// candidate in front of the old ones shows as every candidate changing.
// This module reads candidate lists as lists: it says "reordered" or
// "a new first choice in front of the old ones" when that is what
// happened, and always says which selector compiled code will now use,
// because that is the one that matters.
//
// `semanticDiff` returns a structure (for JSON output and tests);
// `renderSemanticDiff` and `renderReview` turn it into plain text. Every
// value that came from a patch is untrusted: a model wrote it after
// reading a page. The text renderers strip control characters and cap the
// length of every value, so nothing in a patch can move the cursor, change
// colours or forge lines in a reviewer's terminal.

import { diffPatch, findStep } from '@sfysh/ir';
import type { SelectorCandidate, Step, StepChange, StepPatch, Workflow } from '@sfysh/ir';

/** A candidate's place in the list before and after. */
export interface RankedCandidate {
  candidate: SelectorCandidate;
  /** 1-based position after the patch. Absent for a removed candidate. */
  rank?: number;
  /** 1-based position before the patch. Absent for a new candidate. */
  was?: number;
}

export type CandidateChangeKind =
  /** Same candidates, same order. */
  | 'unchanged'
  /** Same candidates, different order. */
  | 'reordered'
  /** New candidates put in front; the old ones follow unchanged and in order. */
  | 'inserted_at_front'
  /** Anything else: candidates added elsewhere, removed, or edited. */
  | 'changed';

export interface CandidateChange {
  /** Which list: a step's `target` or a loop's `foreach`. */
  field: 'target' | 'foreach';
  kind: CandidateChangeKind;
  /** The candidate compiled code uses after the patch, with where it came from. */
  first: RankedCandidate;
  /** The candidate it used before. */
  firstBefore?: SelectorCandidate;
  /** Every candidate after the patch, in order. */
  after: RankedCandidate[];
  /** Candidates the patch removed. */
  removed: RankedCandidate[];
}

/** A change to any field other than the candidate lists. */
export interface FieldChange {
  /** JSON Pointer within the step, as `diffStep` gives it. */
  path: string;
  /** The same path written for reading: `post[1]`, `target`, `timeoutMs`. */
  label: string;
  kind: StepChange['kind'];
  before?: unknown;
  after?: unknown;
}

export interface SemanticDiff {
  stepId: string;
  op: StepPatch['op'];
  /** Intent of the step the patch is anchored to, before the patch. */
  intent: string;
  /** For a replace: changes to candidate lists, read as lists. */
  candidates: CandidateChange[];
  /** For a replace: every other field change. */
  fields: FieldChange[];
  /** For an insert: the new step. */
  inserted?: Step;
}

/**
 * Describe what a patch changes. `workflow` is optional: when given, the
 * anchor step's intent is read from it, which matters for an insert (the
 * patch only carries the new step).
 */
export function semanticDiff(patch: StepPatch, workflow?: Workflow): SemanticDiff {
  const anchor = workflow ? findStep(workflow, patch.stepId)?.step : undefined;
  const intent =
    (anchor as { intent?: string } | undefined)?.intent ??
    (patch.before as { intent?: string } | undefined)?.intent ??
    (patch.op === 'replace' ? ((patch.after as { intent?: string }).intent ?? '') : '');

  if (patch.op !== 'replace' || !patch.before) {
    return {
      stepId: patch.stepId,
      op: patch.op,
      intent,
      candidates: [],
      fields: [],
      inserted: patch.after,
    };
  }

  const before = patch.before as unknown as Loose;
  const after = patch.after as unknown as Loose;
  const candidates: CandidateChange[] = [];
  for (const field of ['target', 'foreach'] as const) {
    const b = candidatesIn(before[field]);
    const a = candidatesIn(after[field]);
    if (a !== undefined && b !== undefined) {
      const change = compareCandidates(field, b, a);
      if (change.kind !== 'unchanged') candidates.push(change);
    }
  }

  // Candidate paths are described above. Everything else is reported field
  // by field, except where a whole target appeared or vanished, which the
  // field change already covers.
  const handled = candidates.map((c) => `/${c.field}/candidates/`);
  const fields = diffPatch(patch)
    .changes.filter((c) => !handled.some((prefix) => c.path.startsWith(prefix)))
    .map((c) => ({ ...c, label: readablePath(c.path) }));

  return { stepId: patch.stepId, op: patch.op, intent, candidates, fields };
}

/** Compare two candidate lists as lists. */
export function compareCandidates(
  field: CandidateChange['field'],
  before: readonly SelectorCandidate[],
  after: readonly SelectorCandidate[],
): CandidateChange {
  const keyOf = (c: SelectorCandidate): string => `${c.kind}\u0000${c.value}`;
  const wasAt = new Map<string, number>();
  before.forEach((c, i) => {
    if (!wasAt.has(keyOf(c))) wasAt.set(keyOf(c), i + 1);
  });
  const nowAt = new Set(after.map(keyOf));

  const ranked: RankedCandidate[] = after.map((candidate, i) => {
    const was = wasAt.get(keyOf(candidate));
    return { candidate, rank: i + 1, ...(was !== undefined ? { was } : {}) };
  });
  const removed: RankedCandidate[] = before
    .map((candidate, i) => ({ candidate, was: i + 1 }))
    .filter(({ candidate }) => !nowAt.has(keyOf(candidate)));

  const added = ranked.filter((r) => r.was === undefined).length;
  const sameOrder =
    before.length === after.length && before.every((c, i) => keyOf(c) === keyOf(after[i]!));

  let kind: CandidateChangeKind;
  if (sameOrder) kind = 'unchanged';
  else if (added === 0 && removed.length === 0) kind = 'reordered';
  else if (
    removed.length === 0 &&
    added > 0 &&
    ranked.slice(0, added).every((r) => r.was === undefined) &&
    ranked.slice(added).every((r, i) => r.was === i + 1)
  ) {
    kind = 'inserted_at_front';
  } else kind = 'changed';

  return {
    field,
    kind,
    first: ranked[0] ?? { candidate: { kind: 'css', value: '' } as SelectorCandidate },
    ...(before[0] !== undefined ? { firstBefore: before[0] } : {}),
    after: ranked,
    removed,
  };
}

// ---------------------------------------------------------------------------
// Text

/** Longest a single value is printed, in characters. */
export const RENDER_VALUE_MAX_CHARS = 200;

// C0 and C1 controls (which include ESC), DEL, and the Unicode line and
// paragraph separators. Any of them could end a line or start a terminal
// escape sequence.
const UNSAFE = new RegExp(
  `[\\u0000-\\u001f\\u007f-\\u009f${String.fromCharCode(0x2028, 0x2029)}]+`,
  'g',
);

/** Make untrusted text safe to print on one line: controls become a space, and long text is cut. */
export function printable(text: string, max = RENDER_VALUE_MAX_CHARS): string {
  const flat = text.replace(UNSAFE, ' ');
  return flat.length > max
    ? `${flat.slice(0, max)}... (${flat.length - max} more characters)`
    : flat;
}

/** Render a semantic diff as plain text, one fact per line. */
export function renderSemanticDiff(diff: SemanticDiff): string {
  const lines: string[] = [];
  const intent = diff.intent ? ` (${quoted(diff.intent)})` : '';

  if (diff.inserted !== undefined) {
    const where = diff.op === 'insert_after' ? 'after' : 'before';
    lines.push(
      `New step ${printable(diff.inserted.id ?? '?')}, ${where} step ${printable(diff.stepId)}${intent}:`,
    );
    for (const line of describeStep(diff.inserted)) lines.push(`  ${line}`);
    return lines.join('\n');
  }

  lines.push(`Step ${printable(diff.stepId)}${intent}:`);
  if (diff.candidates.length === 0 && diff.fields.length === 0) {
    lines.push('  No change.');
  }
  for (const change of diff.candidates) {
    for (const line of describeCandidates(change)) lines.push(`  ${line}`);
  }
  for (const change of diff.fields) lines.push(`  ${describeField(change)}`);
  return lines.join('\n');
}

function describeCandidates(change: CandidateChange): string[] {
  const label = change.field === 'target' ? 'Selectors' : 'Loop selectors';
  const first = selector(change.first.candidate);
  const from =
    change.first.was === undefined
      ? 'new'
      : change.first.was === 1
        ? 'unchanged'
        : `was #${change.first.was}`;
  const lines: string[] = [];
  switch (change.kind) {
    case 'reordered':
      lines.push(
        change.first.was === 1
          ? `${label} reordered. The first choice is unchanged: ${first}.`
          : `${label} reordered. Now tried first: ${first} (${from}).`,
      );
      break;
    case 'inserted_at_front': {
      const n = change.after.filter((r) => r.was === undefined).length;
      lines.push(
        `${n === 1 ? 'A new selector is' : `${n} new selectors are`} put in front of the existing ones, which keep their order. Now tried first: ${first}.`,
      );
      break;
    }
    default:
      lines.push(`${label} changed. Now tried first: ${first} (${from}).`);
  }
  if (change.firstBefore !== undefined && change.first.was !== 1) {
    lines.push(`  Before, the first choice was ${selector(change.firstBefore)}.`);
  }
  for (const r of change.after) {
    const note = r.was === undefined ? 'new' : r.was === r.rank ? 'same place' : `was #${r.was}`;
    lines.push(`  ${r.rank}. ${selector(r.candidate)} (${note})`);
  }
  for (const r of change.removed) {
    lines.push(`  removed: ${selector(r.candidate)} (was #${r.was})`);
  }
  return lines;
}

function describeField(change: FieldChange): string {
  switch (change.kind) {
    case 'added':
      return `Added ${change.label}: ${value(change.after)}`;
    case 'removed':
      return `Removed ${change.label}: ${value(change.before)}`;
    default:
      return `Changed ${change.label}: ${value(change.before)} -> ${value(change.after)}`;
  }
}

/** One line per fact about a new step. */
function describeStep(step: Step): string[] {
  const s = step as unknown as Loose;
  const lines = [`Action: ${printable(String(s.action))}`];
  if (typeof s.intent === 'string') lines.push(`Intent: ${quoted(s.intent)}`);
  const candidates = candidatesIn(s.target);
  if (candidates !== undefined && candidates.length > 0) {
    lines.push(`Target: ${selector(candidates[0]!)}`);
    for (const c of candidates.slice(1)) lines.push(`  fallback: ${selector(c)}`);
  }
  if (s.forCondition !== undefined) lines.push(`Waits until: ${value(s.forCondition)}`);
  if (s.timeoutMs !== undefined) lines.push(`Timeout: ${value(s.timeoutMs)} ms`);
  for (const key of ['pre', 'post'] as const) {
    if (Array.isArray(s[key]) && (s[key] as unknown[]).length > 0) {
      lines.push(`${key === 'pre' ? 'Checks before' : 'Checks after'}: ${value(s[key])}`);
    }
  }
  return lines;
}

function selector(c: SelectorCandidate): string {
  return `${printable(c.kind)} ${quoted(c.value)}`;
}

function quoted(text: string): string {
  return JSON.stringify(printable(text)).replace(UNSAFE, ' ');
}

function value(v: unknown): string {
  if (v === undefined) return '(none)';
  // JSON escapes control characters inside strings; `printable` caps length
  // and catches the separators JSON leaves raw.
  return printable(JSON.stringify(v) ?? String(v));
}

/** `/post/1/urlMatches` becomes `post[1].urlMatches`. */
function readablePath(pointer: string): string {
  if (pointer === '') return '(whole step)';
  let out = '';
  for (const raw of pointer.split('/').slice(1)) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    out += /^\d+$/.test(seg) ? `[${seg}]` : out === '' ? seg : `.${seg}`;
  }
  return printable(out);
}

type Loose = Record<string, unknown>;

function candidatesIn(target: unknown): SelectorCandidate[] | undefined {
  const list = (target as { candidates?: unknown } | undefined)?.candidates;
  return Array.isArray(list) ? (list as SelectorCandidate[]) : undefined;
}
