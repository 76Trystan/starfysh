import { describe, it, expect } from 'vitest';
import type { Locator, Page } from '@sfysh/runtime';
import {
  CASSETTE_VERSION,
  fakePageFromCassette,
  recordPage,
  serialiseCassette,
  parseCassette,
} from '../src/index.js';

function stubLocator(overrides: Partial<Locator> = {}): Locator {
  const base: Locator = {
    click: async () => {},
    fill: async () => {},
    isVisible: async () => true,
    locator: () => stubLocator(),
    count: async () => 1,
    nth: () => stubLocator(),
    allTextContents: async () => [],
    all: async () => [],
  };
  return { ...base, ...overrides };
}

function stubPage(overrides: Partial<Page> = {}): Page {
  const base: Page = {
    goto: async () => {},
    url: () => 'https://example.com/done',
    locator: () => stubLocator(),
    getByRole: () => stubLocator(),
    getByTestId: () => stubLocator(),
    getByText: () => stubLocator(),
    getByLabel: () => stubLocator(),
    waitForTimeout: async () => {},
  };
  return { ...base, ...overrides };
}

const meta = {
  workflowId: 'wf',
  workflowName: 'Workflow',
  now: () => new Date('2026-11-09T00:00:00.000Z'),
};

describe('recordPage', () => {
  it('captures the page url when the runner calls it', () => {
    const r = recordPage(stubPage({ url: () => 'https://example.com/done' }), meta);
    expect(r.page.url()).toBe('https://example.com/done');
    expect(r.cassette().queries.url).toEqual({ kind: 'string', value: 'https://example.com/done' });
  });

  it('captures locator isVisible under the canonical key', async () => {
    const r = recordPage(
      stubPage({
        locator: () => stubLocator({ isVisible: async () => true }),
      }),
      meta,
    );
    const visible = await r.page.locator('#submit').isVisible();
    expect(visible).toBe(true);
    expect(r.cassette().queries['locator("#submit").isVisible']).toEqual({
      kind: 'boolean',
      value: true,
    });
  });

  it('captures count under the canonical key', async () => {
    const r = recordPage(
      stubPage({
        getByText: () => stubLocator({ count: async () => 3 }),
      }),
      meta,
    );
    const n = await r.page.getByText('Submitted').count();
    expect(n).toBe(3);
    expect(r.cassette().queries['getByText("Submitted").count']).toEqual({
      kind: 'number',
      value: 3,
    });
  });

  it('captures nested locator chain keys', async () => {
    const r = recordPage(
      stubPage({
        locator: () =>
          stubLocator({
            nth: () =>
              stubLocator({ locator: () => stubLocator({ isVisible: async () => false }) }),
          }),
      }),
      meta,
    );
    await r.page.locator('#form').nth(0).locator('input').isVisible();
    expect(r.cassette().queries).toHaveProperty(
      'locator("#form").nth(0).locator("input").isVisible',
    );
  });

  it('records getByRole options canonically', async () => {
    const r = recordPage(
      stubPage({
        getByRole: () => stubLocator({ isVisible: async () => true }),
      }),
      meta,
    );
    await r.page.getByRole('button', { name: 'Submit', exact: true }).isVisible();
    expect(r.cassette().queries).toHaveProperty(
      'getByRole("button",{"exact":true,"name":"Submit"}).isVisible',
    );
  });

  it('appends side-effecting calls to effects in order', async () => {
    let gotoUrl = '';
    let filled = '';
    let clicked = false;
    const r = recordPage(
      stubPage({
        goto: async (u) => {
          gotoUrl = u;
        },
        locator: () =>
          stubLocator({
            click: async () => {
              clicked = true;
            },
            fill: async (v) => {
              filled = v;
            },
          }),
      }),
      meta,
    );
    await r.page.goto('https://example.com/form');
    await r.page.locator('#email').fill('a@b.c');
    await r.page.locator('#submit').click();
    expect(gotoUrl).toBe('https://example.com/form');
    expect(filled).toBe('a@b.c');
    expect(clicked).toBe(true);
    expect(r.cassette().effects.map((e) => e.call)).toEqual([
      'goto("https://example.com/form")',
      'locator("#email").fill("a@b.c")',
      'locator("#submit").click',
    ]);
  });

  it('cassette() returns a fresh object each call so callers can mutate without disturbing state', async () => {
    const r = recordPage(stubPage(), meta);
    const first = r.cassette();
    await r.page.locator('#x').isVisible();
    const second = r.cassette();
    expect(first.queries).toEqual({});
    expect(second.queries).toHaveProperty('locator("#x").isVisible');
  });

  it('records with the supplied timestamp', () => {
    const r = recordPage(stubPage(), meta);
    expect(r.cassette().recordedAt).toBe('2026-11-09T00:00:00.000Z');
  });

  it('round-trip: FakePage replaying a recorded cassette returns the same values', async () => {
    const live = stubPage({
      url: () => 'https://example.com/done',
      locator: (sel) =>
        stubLocator({
          isVisible: async () => sel === '#submit',
          count: async () => (sel === '#row' ? 2 : 0),
        }),
    });
    const r = recordPage(live, meta);
    await r.page.locator('#submit').isVisible();
    await r.page.locator('#row').count();
    r.page.url();

    const written = serialiseCassette(r.cassette());
    const fake = fakePageFromCassette(parseCassette(written));
    await expect(fake.locator('#submit').isVisible()).resolves.toBe(true);
    await expect(fake.locator('#row').count()).resolves.toBe(2);
    expect(fake.url()).toBe('https://example.com/done');
  });

  it('cassette version matches the exported constant', () => {
    const r = recordPage(stubPage(), meta);
    expect(r.cassette().version).toBe(CASSETTE_VERSION);
  });

  describe('setRedact', () => {
    // A minimal substring scrubber in the shape of WorkflowContext.redact:
    // register a secret value under a name, replace occurrences with
    // `[REDACTED:name]`. Longest-first so overlapping secrets scrub cleanly.
    function redactor(secrets: Record<string, string>): (s: string) => string {
      const entries = Object.entries(secrets).sort(([, a], [, b]) => b.length - a.length);
      return (input) => {
        let out = input;
        for (const [name, value] of entries) {
          if (value.length === 0) continue;
          out = out.split(value).join(`[REDACTED:${name}]`);
        }
        return out;
      };
    }

    it('default behaviour is identity: cassette strings are unchanged when setRedact is not called', async () => {
      const r = recordPage(
        stubPage({
          locator: () => stubLocator({ fill: async () => {} }),
        }),
        meta,
      );
      await r.page.locator('#pw').fill('hunter2');
      expect(r.cassette().effects.map((e) => e.call)).toEqual(['locator("#pw").fill("hunter2")']);
    });

    it('scrubs fill args in effects after setRedact is registered', async () => {
      const r = recordPage(
        stubPage({
          locator: () => stubLocator({ fill: async () => {} }),
        }),
        meta,
      );
      r.setRedact(redactor({ pw: 'hunter2' }));
      await r.page.locator('#pw').fill('hunter2');
      expect(r.cassette().effects.map((e) => e.call)).toEqual([
        'locator("#pw").fill("[REDACTED:pw]")',
      ]);
    });

    it('applies lazily: setRedact after the recording still scrubs the already-captured effect', async () => {
      const r = recordPage(
        stubPage({
          locator: () => stubLocator({ fill: async () => {} }),
        }),
        meta,
      );
      await r.page.locator('#pw').fill('hunter2');
      r.setRedact(redactor({ pw: 'hunter2' }));
      expect(r.cassette().effects.map((e) => e.call)).toEqual([
        'locator("#pw").fill("[REDACTED:pw]")',
      ]);
    });

    it('scrubs goto args that embed a secret', async () => {
      const r = recordPage(stubPage({ goto: async () => {} }), meta);
      r.setRedact(redactor({ token: 'abc123' }));
      await r.page.goto('https://example.com/callback?token=abc123');
      expect(r.cassette().effects[0]?.call).toBe(
        'goto("https://example.com/callback?token=[REDACTED:token]")',
      );
    });

    it('scrubs string query values (e.g. url() returning a URL with a session token)', () => {
      const r = recordPage(stubPage({ url: () => 'https://example.com/?session=s3cr3t' }), meta);
      r.setRedact(redactor({ session: 's3cr3t' }));
      r.page.url();
      expect(r.cassette().queries.url).toEqual({
        kind: 'string',
        value: 'https://example.com/?session=[REDACTED:session]',
      });
    });

    it('scrubs each entry of string-array query values', async () => {
      const r = recordPage(
        stubPage({
          locator: () => stubLocator({ allTextContents: async () => ['hunter2', 'visible'] }),
        }),
        meta,
      );
      r.setRedact(redactor({ pw: 'hunter2' }));
      await r.page.locator('.items').allTextContents();
      expect(r.cassette().queries['locator(".items").allTextContents']).toEqual({
        kind: 'string-array',
        value: ['[REDACTED:pw]', 'visible'],
      });
    });

    it('does not redact query keys (FakePage replay must still match raw keys)', async () => {
      const r = recordPage(
        stubPage({
          locator: () => stubLocator({ isVisible: async () => true }),
        }),
        meta,
      );
      r.setRedact(redactor({ pw: 'hunter2' }));
      await r.page.locator('input[value="hunter2"]').isVisible();
      // Key preserved verbatim; the replay-side callKey() matches it.
      expect(r.cassette().queries).toHaveProperty(
        'locator("input[value=\\"hunter2\\"]").isVisible',
      );
    });

    it('leaves number and boolean query values untouched', async () => {
      const r = recordPage(
        stubPage({
          locator: () =>
            stubLocator({
              isVisible: async () => true,
              count: async () => 42,
            }),
        }),
        meta,
      );
      r.setRedact(redactor({ pw: 'hunter2' }));
      await r.page.locator('#a').isVisible();
      await r.page.locator('#b').count();
      expect(r.cassette().queries['locator("#a").isVisible']).toEqual({
        kind: 'boolean',
        value: true,
      });
      expect(r.cassette().queries['locator("#b").count']).toEqual({ kind: 'number', value: 42 });
    });

    it('subsequent setRedact calls replace the active function', async () => {
      const r = recordPage(
        stubPage({
          locator: () => stubLocator({ fill: async () => {} }),
        }),
        meta,
      );
      r.setRedact(redactor({ first: 'wrong' }));
      r.setRedact(redactor({ pw: 'hunter2' }));
      await r.page.locator('#pw').fill('hunter2');
      expect(r.cassette().effects[0]?.call).toBe('locator("#pw").fill("[REDACTED:pw]")');
    });
  });
});
