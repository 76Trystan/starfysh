// Page snapshot capture. When a run fails, the runner asks the page for a
// text rendering of its accessibility tree. That is the evidence a healer
// works from: without it there is nothing to derive a replacement selector
// from.
//
// The snapshot is page content, which means it is untrusted. It is stored
// on the run result as data. Nothing in the runtime interprets it, and it
// must never be treated as instructions by whatever reads it later.

import type { WorkflowContext } from './context.js';

export interface PageSnapshot {
  /**
   * Accessibility tree of the page as text, with registered secrets
   * redacted. Untrusted page content.
   */
  text: string;
  /** True when the snapshot was longer than the cap and was cut. */
  truncated: boolean;
  /** Length of the snapshot before truncation, in characters. */
  originalLength: number;
}

export interface SnapshotOptions {
  /** Maximum characters kept. Default 100,000. */
  maxChars?: number;
  /** How long to wait for the page to answer, in milliseconds. Default 5,000. */
  timeoutMs?: number;
}

export const DEFAULT_SNAPSHOT_MAX_CHARS = 100_000;
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 5_000;

/**
 * Capture a snapshot of `ctx.page`, or return undefined if the backend does
 * not support snapshots, the page does not answer in time, or the call
 * throws. Capture runs after a failure, often against a page that is in a
 * bad state, so it must never turn one failure into two.
 */
export async function capturePageSnapshot(
  ctx: WorkflowContext,
  options: SnapshotOptions = {},
): Promise<PageSnapshot | undefined> {
  const page = ctx.page;
  if (typeof page.snapshot !== 'function') return undefined;

  const maxChars = options.maxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      page.snapshot(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    if (typeof raw !== 'string') return undefined;

    // Redact before cutting, so a secret that straddles the cap cannot
    // survive as a fragment.
    const redacted = ctx.redact(raw);
    const truncated = redacted.length > maxChars;
    return {
      text: truncated ? redacted.slice(0, maxChars) : redacted,
      truncated,
      originalLength: redacted.length,
    };
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
