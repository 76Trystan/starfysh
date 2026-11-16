// Deep comparison of JSON values for the patch checks.

import { hashStep } from '@sfysh/ir';
import type { Step } from '@sfysh/ir';

/** A string that is equal for two JSON values exactly when they are deep-equal, whatever their key order. */
export function canonical(value: unknown): string {
  // `hashStep` hashes any JSON value with its keys sorted; a step is just
  // the value it is usually given.
  return value === undefined ? 'undefined' : hashStep(value as Step);
}

/** Deep equality that ignores object key order. */
export function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** Escape a key for use in a JSON Pointer. */
export function pointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/[/]/g, '~1');
}
