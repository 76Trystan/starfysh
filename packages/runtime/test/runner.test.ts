import { describe, it, expect, beforeEach } from 'vitest';
import {
  workflow,
  run,
  resetWorkflows,
  createWorkflowContext,
  VaultSecretMissingError,
  AssertionError,
  ExtractionError,
} from '../src/index.js';
import type { Page, Locator } from '../src/index.js';

const stubLocator: Locator = {
  click: async () => {},
  fill: async () => {},
  isVisible: async () => false,
  locator: () => stubLocator,
  count: async () => 0,
  nth: () => stubLocator,
  allTextContents: async () => [],
  all: async () => [],
};

const stubPage: Page = {
  goto: async () => {},
  url: () => 'https://example.com',
  locator: () => stubLocator,
  getByRole: () => stubLocator,
  getByTestId: () => stubLocator,
  getByText: () => stubLocator,
  getByLabel: () => stubLocator,
  waitForTimeout: async () => {},
};

function newCtx() {
  return createWorkflowContext({ page: stubPage });
}

describe('run', () => {
  beforeEach(() => {
    resetWorkflows();
  });

  it('returns ok when the workflow succeeds', async () => {
    workflow('run-ok', async () => {});
    const result = await run('run-ok', newCtx());
    expect(result.status).toBe('ok');
    expect(result.workflowId).toBe('run-ok');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('throws synchronously for an unregistered workflow id', async () => {
    await expect(run('run-not-registered', newCtx())).rejects.toThrow('run-not-registered');
  });

  it('classifies VaultSecretMissingError as auth', async () => {
    workflow('run-auth', async () => {
      throw new VaultSecretMissingError('my_secret');
    });
    const result = await run('run-auth', newCtx());
    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('auth');
  });

  it('classifies AssertionError as site', async () => {
    workflow('run-assert', async () => {
      throw new AssertionError('postcondition failed');
    });
    const result = await run('run-assert', newCtx());
    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('site');
  });

  it('classifies ExtractionError as site', async () => {
    workflow('run-extract', async () => {
      throw new ExtractionError('column not found');
    });
    const result = await run('run-extract', newCtx());
    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('site');
  });

  it('classifies timeout errors as flake', async () => {
    workflow('run-timeout', async () => {
      throw new Error('Navigation timeout exceeded');
    });
    const result = await run('run-timeout', newCtx());
    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('flake');
  });

  it('classifies network errors as flake', async () => {
    workflow('run-net', async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED');
    });
    const result = await run('run-net', newCtx());
    expect(result.error?.kind).toBe('flake');
  });

  it('classifies unrecognised errors as unknown', async () => {
    workflow('run-unknown', async () => {
      throw new Error('Something unexpected happened');
    });
    const result = await run('run-unknown', newCtx());
    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('unknown');
  });

  it('captures the error message', async () => {
    workflow('run-msg', async () => {
      throw new Error('specific failure message');
    });
    const result = await run('run-msg', newCtx());
    expect(result.error?.message).toBe('specific failure message');
  });

  it('carries the raw error as cause', async () => {
    const original = new Error('original');
    workflow('run-cause', async () => {
      throw original;
    });
    const result = await run('run-cause', newCtx());
    expect(result.error?.cause).toBe(original);
  });

  it('records a non-negative duration', async () => {
    workflow('run-timing', async () => {});
    const result = await run('run-timing', newCtx());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
