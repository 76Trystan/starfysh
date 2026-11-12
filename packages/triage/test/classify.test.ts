import { describe, it, expect } from 'vitest';
import {
  AssertionError,
  ExtractionError,
  PostconditionViolation,
  VaultSecretMissingError,
} from '@sfysh/runtime';
import { classify } from '../src/index.js';
import type { PostconditionResult } from '../src/index.js';

describe('classify', () => {
  describe('postcondition-first rule', () => {
    it('returns site when any postcondition is violated', () => {
      const postconditions: PostconditionResult[] = [
        { condition: { urlMatches: '/dashboard' }, status: 'violated', reason: 'url mismatch' },
      ];
      const result = classify({ error: new Error('unrelated'), postconditions });
      expect(result.kind).toBe('site');
      expect(result.reason).toBe('postcondition violated');
    });

    it('postcondition violation beats other classifications', () => {
      const postconditions: PostconditionResult[] = [
        { condition: { urlMatches: '/x' }, status: 'violated' },
      ];
      const result = classify({
        error: new VaultSecretMissingError('token'),
        postconditions,
      });
      expect(result.kind).toBe('site');
    });

    it('ignores held or unsupported postconditions', () => {
      const postconditions: PostconditionResult[] = [
        { condition: { urlMatches: '/x' }, status: 'held' },
        { condition: { responseStatus: { equals: 200 } }, status: 'unsupported' },
      ];
      const result = classify({ error: new Error('unrelated'), postconditions });
      expect(result.kind).toBe('unknown');
    });
  });

  describe('error-type rules', () => {
    it('maps VaultSecretMissingError to auth', () => {
      const result = classify({ error: new VaultSecretMissingError('portal_pass') });
      expect(result.kind).toBe('auth');
      expect(result.reason).toContain('portal_pass');
    });

    it('maps PostconditionViolation to site with step attribution', () => {
      const result = classify({
        error: new PostconditionViolation({
          stepId: 'step_submit',
          phase: 'post',
          condition: { urlMatches: '/dashboard' },
          reason: 'url mismatch',
        }),
      });
      expect(result.kind).toBe('site');
      expect(result.reason).toContain('step_submit');
      expect(result.reason).toContain('post');
    });

    it('maps ExtractionError to site', () => {
      const result = classify({ error: new ExtractionError('column missing') });
      expect(result.kind).toBe('site');
    });

    it('maps AssertionError to site', () => {
      const result = classify({ error: new AssertionError('expectation failed') });
      expect(result.kind).toBe('site');
    });
  });

  describe('response-based rules (Phase 2 HTTP)', () => {
    it('maps HTTP 500 to flake', () => {
      const result = classify({ error: new Error('server error'), response: { status: 500 } });
      expect(result.kind).toBe('flake');
      expect(result.reason).toBe('HTTP 500');
    });

    it('maps HTTP 503 to flake', () => {
      const result = classify({ error: new Error('unavailable'), response: { status: 503 } });
      expect(result.kind).toBe('flake');
    });

    it('maps HTTP 401 to auth', () => {
      const result = classify({ error: new Error('unauthorized'), response: { status: 401 } });
      expect(result.kind).toBe('auth');
      expect(result.reason).toBe('HTTP 401');
    });

    it('maps HTTP 403 to auth', () => {
      const result = classify({ error: new Error('forbidden'), response: { status: 403 } });
      expect(result.kind).toBe('auth');
    });

    it('response-based rule does not fire without a response', () => {
      const result = classify({ error: new Error('unauthorized') });
      expect(result.kind).toBe('unknown');
    });

    it('response-based rule yields to postcondition rule', () => {
      const postconditions: PostconditionResult[] = [
        { condition: { urlMatches: '/x' }, status: 'violated' },
      ];
      const result = classify({
        error: new Error('e'),
        postconditions,
        response: { status: 500 },
      });
      expect(result.kind).toBe('site');
    });

    it('response-based rule yields to typed-error rule', () => {
      const result = classify({
        error: new VaultSecretMissingError('x'),
        response: { status: 500 },
      });
      expect(result.kind).toBe('auth');
    });
  });

  describe('message-heuristic rules', () => {
    it('maps timeout message to flake', () => {
      const result = classify({ error: new Error('Navigation timeout exceeded') });
      expect(result.kind).toBe('flake');
    });

    it('maps net:: prefix to flake', () => {
      const result = classify({ error: new Error('net::ERR_CONNECTION_REFUSED') });
      expect(result.kind).toBe('flake');
    });

    it('maps ECONNREFUSED to flake', () => {
      const result = classify({ error: new Error('ECONNREFUSED 127.0.0.1:443') });
      expect(result.kind).toBe('flake');
    });

    it('maps ECONNRESET to flake', () => {
      const result = classify({ error: new Error('ECONNRESET during read') });
      expect(result.kind).toBe('flake');
    });

    it('maps ETIMEDOUT to flake', () => {
      const result = classify({ error: new Error('ETIMEDOUT after 30s') });
      expect(result.kind).toBe('flake');
    });

    it('maps HTTP 502 in message to flake', () => {
      const result = classify({ error: new Error('Received 502 from upstream') });
      expect(result.kind).toBe('flake');
    });

    it('is case insensitive on the message', () => {
      const result = classify({ error: new Error('TIMEOUT WAITING FOR RESPONSE') });
      expect(result.kind).toBe('flake');
    });
  });

  describe('fallback', () => {
    it('returns unknown with a descriptive reason', () => {
      const result = classify({ error: new Error('something weird happened') });
      expect(result.kind).toBe('unknown');
      expect(result.reason).toBe('no classification rule matched');
    });

    it('returns unknown for non-Error throws', () => {
      const result = classify({ error: 'string thrown directly' });
      expect(result.kind).toBe('unknown');
    });

    it('returns unknown for null error with no other signal', () => {
      const result = classify({ error: null });
      expect(result.kind).toBe('unknown');
    });
  });
});
