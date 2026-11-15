// Redaction hardening: encoded forms of a secret, short secrets, output
// scrubbing, and the non-enumerable raw cause on RunResult.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createWorkflowContext,
  MIN_REDACTABLE_SECRET_LENGTH,
  resetWorkflows,
  run,
  workflow,
} from '../src/index.js';
import type { Locator, Page } from '../src/index.js';

const stubPage: Page = {
  goto: async () => undefined,
  url: () => 'about:blank',
  locator: () => ({}) as unknown as Locator,
  getByRole: () => ({}) as unknown as Locator,
  getByTestId: () => ({}) as unknown as Locator,
  getByText: () => ({}) as unknown as Locator,
  getByLabel: () => ({}) as unknown as Locator,
  waitForTimeout: async () => undefined,
};

function ctxWith(secrets: Record<string, string>) {
  const ctx = createWorkflowContext({
    page: stubPage,
    vaultResolver: { resolve: (name) => secrets[name] },
  });
  for (const name of Object.keys(secrets)) ctx.vault(name);
  return ctx;
}

describe('ctx.redact: encoded forms', () => {
  const awkward = 'pa"ss\\w&rd/+ é';

  it('scrubs the JSON-escaped form (how a cassette stores call arguments)', () => {
    const ctx = ctxWith({ pw: awkward });
    const call = `getByLabel("Password").fill(${JSON.stringify(awkward)})`;
    expect(ctx.redact(call)).toBe('getByLabel("Password").fill("[REDACTED:pw]")');
  });

  it('scrubs the percent-encoded form (query strings)', () => {
    const ctx = ctxWith({ pw: awkward });
    const url = `https://x.test/cb?token=${encodeURIComponent(awkward)}&next=1`;
    expect(ctx.redact(url)).toBe('https://x.test/cb?token=[REDACTED:pw]&next=1');
  });

  it('scrubs the form-encoded variant that uses + for spaces', () => {
    const ctx = ctxWith({ pw: 'two words here' });
    expect(ctx.redact('body: pw=two+words+here&x=1')).toBe('body: pw=[REDACTED:pw]&x=1');
  });

  it('scrubs the encodeURI form, which leaves reserved characters alone', () => {
    const ctx = ctxWith({ pw: 'a b/c?d' });
    expect(ctx.redact(`see ${encodeURI('a b/c?d')}`)).toBe('see [REDACTED:pw]');
  });

  it('scrubs base64 and base64url forms, with and without padding', () => {
    const ctx = ctxWith({ pw: awkward });
    const b64 = Buffer.from(awkward, 'utf8').toString('base64');
    const b64url = Buffer.from(awkward, 'utf8').toString('base64url');
    expect(ctx.redact(`Authorization: Bearer ${b64}`)).toBe('Authorization: Bearer [REDACTED:pw]');
    expect(ctx.redact(`t=${b64.replace(/=+$/, '')};`)).toBe('t=[REDACTED:pw];');
    expect(ctx.redact(`t=${b64url};`)).toBe('t=[REDACTED:pw];');
  });

  it('still scrubs the raw form', () => {
    const ctx = ctxWith({ pw: awkward });
    expect(ctx.redact(`typed ${awkward} into the field`)).toBe(
      'typed [REDACTED:pw] into the field',
    );
  });

  it('leaves no fragment of the secret behind in any encoded form', () => {
    const ctx = ctxWith({ pw: awkward });
    const haystack = [
      awkward,
      JSON.stringify(awkward),
      encodeURIComponent(awkward),
      Buffer.from(awkward, 'utf8').toString('base64'),
    ].join(' | ');
    const out = ctx.redact(haystack);
    expect(out).not.toContain('pa');
    expect(out).not.toContain('rd');
  });

  it('picks up a secret registered after the first redact call', () => {
    const secrets: Record<string, string> = { first: 'first-secret' };
    const ctx = createWorkflowContext({
      page: stubPage,
      vaultResolver: { resolve: (name) => secrets[name] },
    });
    ctx.vault('first');
    expect(ctx.redact('first-secret second-secret')).toBe('[REDACTED:first] second-secret');
    secrets['second'] = 'second-secret';
    ctx.vault('second');
    expect(ctx.redact('first-secret second-secret')).toBe('[REDACTED:first] [REDACTED:second]');
  });
});

describe('ctx.vault: short secrets', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('resolves a short secret but does not register it for redaction', () => {
    const ctx = ctxWith({ pin: 'a' });
    expect(ctx.vault('pin')).toBe('a');
    expect(ctx.redact('navigation failed at page')).toBe('navigation failed at page');
  });

  it('warns once per secret name, without printing the value', () => {
    const ctx = ctxWith({ pin: '12' });
    ctx.vault('pin');
    ctx.vault('pin');
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, options] = warn.mock.calls[0] as [string, { code: string }];
    expect(message).toContain("'pin'");
    expect(message).not.toContain('12');
    expect(options.code).toBe('SFYSH_SHORT_SECRET');
  });

  it('redacts a secret exactly at the minimum length', () => {
    const value = 'x'.repeat(MIN_REDACTABLE_SECRET_LENGTH);
    const ctx = ctxWith({ edge: value });
    expect(ctx.redact(`[${value}]`)).toBe('[[REDACTED:edge]]');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('outputs are redacted on the way out', () => {
  it('drainOutputs scrubs strings at any depth and leaves other values alone', () => {
    const ctx = ctxWith({ api_token: 'tok_live_12345' });
    const when = new Date('2026-11-15T00:00:00.000Z');
    ctx.emit.output({
      banner: 'Your token is tok_live_12345',
      rows: [{ note: 'tok_live_12345', qty: 3, ok: true, missing: null }],
      when,
    });
    expect(ctx.drainOutputs()).toEqual([
      {
        banner: 'Your token is [REDACTED:api_token]',
        rows: [{ note: '[REDACTED:api_token]', qty: 3, ok: true, missing: null }],
        when,
      },
    ]);
  });

  it('scrubs a secret that was resolved after the output was emitted', () => {
    const secrets: Record<string, string> = { late: 'late-secret-value' };
    const ctx = createWorkflowContext({
      page: stubPage,
      vaultResolver: { resolve: (name) => secrets[name] },
    });
    ctx.emit.output('page said late-secret-value');
    ctx.vault('late');
    expect(ctx.drainOutputs()).toEqual(['page said [REDACTED:late]']);
  });

  it('does not mutate the value the workflow emitted', () => {
    const ctx = ctxWith({ api_token: 'tok_live_12345' });
    const emitted = { note: 'tok_live_12345' };
    ctx.emit.output(emitted);
    ctx.drainOutputs();
    expect(emitted.note).toBe('tok_live_12345');
  });

  it('flushOutputs writes the scrubbed form to stdout', async () => {
    const ctx = ctxWith({ api_token: 'tok_live_12345' });
    ctx.emit.output({ note: 'tok_live_12345' });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const previous = process.env['COMPILE_OUTPUT_FILE'];
    delete process.env['COMPILE_OUTPUT_FILE'];
    try {
      await ctx.flushOutputs();
      expect(write).toHaveBeenCalledWith('{"note":"[REDACTED:api_token]"}\n');
    } finally {
      write.mockRestore();
      if (previous !== undefined) process.env['COMPILE_OUTPUT_FILE'] = previous;
    }
  });

  it('keeps an own __proto__ key as data instead of changing the prototype', () => {
    const ctx = ctxWith({ api_token: 'tok_live_12345' });
    ctx.emit.output(JSON.parse('{"__proto__":{"polluted":"tok_live_12345"}}'));
    const [out] = ctx.drainOutputs() as [Record<string, unknown>];
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('RunResult.error.cause', () => {
  beforeEach(() => {
    resetWorkflows();
  });

  it('is reachable for triage but skipped by JSON.stringify and spread', async () => {
    const raw = new Error('locator.fill: fill("hunter2-secret") timed out');
    workflow('cause-hidden', async (ctx) => {
      ctx.vault('portal_pass');
      throw raw;
    });
    const ctx = createWorkflowContext({
      page: stubPage,
      vaultResolver: { resolve: () => 'hunter2-secret' },
    });
    const result = await run('cause-hidden', ctx);

    expect(result.error?.cause).toBe(raw);
    expect(Object.keys(result.error ?? {})).not.toContain('cause');
    expect({ ...result.error }).not.toHaveProperty('cause');

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('hunter2-secret');
    expect(serialised).toContain('[REDACTED:portal_pass]');
  });
});
