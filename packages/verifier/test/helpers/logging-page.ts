// A scripted Page that logs every call made against it, in order. Two
// executors given pages built from the same script should produce the same
// log if they drive the page the same way.

import type { Locator, Page } from '@sfysh/runtime';

export interface PageScript {
  /** Value returned by `page.url()`. */
  url?: string;
  /**
   * Answers for `isVisible()`, keyed by locator path. A boolean answers
   * every call; an array answers call by call and repeats its last entry.
   * Paths not listed are visible.
   */
  visible?: Record<string, boolean | boolean[]>;
  /** Answers for `count()`, keyed by locator path. Default 1. */
  count?: Record<string, number>;
  /** Answers for `allTextContents()`, keyed by locator path. Default `['text']`. */
  texts?: Record<string, string[]>;
  /** Number of locators `all()` returns, keyed by locator path. Default 2. */
  all?: Record<string, number>;
  /** Locator paths whose `click()` or `fill()` throws. The value is the error message. */
  failAction?: Record<string, string>;
  /** Value returned by `page.snapshot()`. Omit for a page with no snapshot support. */
  snapshot?: string;
}

export interface LoggingPage {
  page: Page;
  /** Every call in order, for example `getByRole("button",{"name":"Go"}).click`. */
  log: string[];
}

export function loggingPage(script: PageScript = {}): LoggingPage {
  const log: string[] = [];
  const visibleCalls = new Map<string, number>();

  const locator = (path: string): Locator => ({
    click: async () => {
      log.push(`${path}.click`);
      const failure = script.failAction?.[path];
      if (failure !== undefined) throw new Error(failure);
    },
    fill: async (value: string) => {
      log.push(`${path}.fill(${JSON.stringify(value)})`);
      const failure = script.failAction?.[path];
      if (failure !== undefined) throw new Error(failure);
    },
    isVisible: async () => {
      log.push(`${path}.isVisible`);
      const answer = script.visible?.[path];
      if (answer === undefined) return true;
      if (typeof answer === 'boolean') return answer;
      const n = visibleCalls.get(path) ?? 0;
      visibleCalls.set(path, n + 1);
      return answer[Math.min(n, answer.length - 1)] ?? true;
    },
    count: async () => {
      log.push(`${path}.count`);
      return script.count?.[path] ?? 1;
    },
    allTextContents: async () => {
      log.push(`${path}.allTextContents`);
      return script.texts?.[path] ?? ['text'];
    },
    all: async () => {
      log.push(`${path}.all`);
      const n = script.all?.[path] ?? 2;
      return Array.from({ length: n }, (_, i) => locator(`${path}.all[${i}]`));
    },
    locator: (selector: string) => locator(`${path}.locator(${JSON.stringify(selector)})`),
    nth: (i: number) => locator(`${path}.nth(${i})`),
    getByRole: (role, options) =>
      locator(
        options === undefined
          ? `${path}.getByRole(${JSON.stringify(role)})`
          : `${path}.getByRole(${JSON.stringify(role)},${JSON.stringify(options)})`,
      ),
    getByTestId: (value) => locator(`${path}.getByTestId(${JSON.stringify(value)})`),
    getByText: (value) => locator(`${path}.getByText(${JSON.stringify(value)})`),
    getByLabel: (value) => locator(`${path}.getByLabel(${JSON.stringify(value)})`),
  });

  const page: Page = {
    goto: async (url, options) => {
      log.push(
        options === undefined
          ? `goto(${JSON.stringify(url)})`
          : `goto(${JSON.stringify(url)},${JSON.stringify(options)})`,
      );
    },
    url: () => {
      log.push('url');
      return script.url ?? 'https://example.com/';
    },
    waitForTimeout: async (ms) => {
      log.push(`waitForTimeout(${ms})`);
    },
    locator: (selector) => locator(`locator(${JSON.stringify(selector)})`),
    getByRole: (role, options) =>
      locator(
        options === undefined
          ? `getByRole(${JSON.stringify(role)})`
          : `getByRole(${JSON.stringify(role)},${JSON.stringify(options)})`,
      ),
    getByTestId: (value) => locator(`getByTestId(${JSON.stringify(value)})`),
    getByText: (value) => locator(`getByText(${JSON.stringify(value)})`),
    getByLabel: (value) => locator(`getByLabel(${JSON.stringify(value)})`),
    ...(script.snapshot !== undefined
      ? {
          snapshot: async () => {
            log.push('snapshot');
            return script.snapshot!;
          },
        }
      : {}),
  };

  return { page, log };
}
