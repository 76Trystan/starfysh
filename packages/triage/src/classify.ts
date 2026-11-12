import {
  AssertionError,
  ExtractionError,
  PostconditionViolation,
  VaultSecretMissingError,
} from '@sfysh/runtime';
import type { ClassifyInput, ClassifyResult } from './types.js';

const NETWORK_MARKERS = [
  'timeout',
  'net::',
  'econnrefused',
  'econnreset',
  'etimedout',
  '500',
  '502',
  '503',
];

/**
 * Deterministic triage classifier. Pure function; no I/O, no model call.
 *
 * A violated postcondition is the strongest single signal of site drift and
 * runs before any instanceof check, so a `PostconditionViolation` thrown
 * alongside a passing-but-stale postcondition set still classifies as `site`.
 */
export function classify(input: ClassifyInput): ClassifyResult {
  const { error, postconditions, response } = input;

  if (postconditions?.some((p) => p.status === 'violated')) {
    return { kind: 'site', reason: 'postcondition violated' };
  }

  if (error instanceof VaultSecretMissingError) {
    return { kind: 'auth', reason: `missing vault secret: ${error.secretName}` };
  }
  if (error instanceof PostconditionViolation) {
    return {
      kind: 'site',
      reason: `postcondition ${error.phase} violated on ${error.stepId}`,
    };
  }
  if (error instanceof ExtractionError) {
    return { kind: 'site', reason: 'extraction target missing' };
  }
  if (error instanceof AssertionError) {
    return { kind: 'site', reason: 'assertion failed' };
  }

  if (response) {
    if (response.status >= 500) {
      return { kind: 'flake', reason: `HTTP ${response.status}` };
    }
    if (response.status === 401 || response.status === 403) {
      return { kind: 'auth', reason: `HTTP ${response.status}` };
    }
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (NETWORK_MARKERS.some((marker) => msg.includes(marker))) {
      return { kind: 'flake', reason: 'transient network error' };
    }
  }

  return { kind: 'unknown', reason: 'no classification rule matched' };
}
