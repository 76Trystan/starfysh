// Recorder: wrap a live Page so every query result is captured under the
// same canonical key FakePage would look it up by. After the runner
// completes, `cassette()` returns a cassette ready to serialise.
//
// The recorder is intentionally a thin forwarder. It does not cache query
// results across calls; if the runner calls `isVisible()` twice on the same
// locator and the live page returns different answers, the cassette stores
// the second answer (last-write-wins). That mirrors FakePage, which has one
// entry per key.
//
// Redaction: `setRedact(fn)` registers a scrubber that runs lazily at
// `cassette()` time over effect call strings and string-valued query
// results. Typically wired to `WorkflowContext.redact` so vault-resolved
// secrets do not leak into a committed cassette. Query keys are
// intentionally not redacted: FakePage computes lookup keys the same way
// the recorder does, and scrubbing a key would cause the replay side's
// still-raw key to miss. In practice secrets rarely appear in selector
// strings; they land in `fill(...)` args (effects) or in response-derived
// query values (string / string-array), both of which are covered.

import type { Locator, Page } from '@sfysh/runtime';
import {
  CASSETTE_VERSION,
  callKey,
  segment,
  type Cassette,
  type CassetteEffect,
  type CassetteValue,
} from './cassette.js';

export interface RecordOptions {
  workflowId: string;
  workflowName: string;
  /** Override the recordedAt timestamp (useful for deterministic tests). */
  now?: () => Date;
}

export interface RecordingResult {
  page: Page;
  /**
   * Register a redaction function. Applied lazily when `cassette()` is
   * called, over every effect call string and every string-valued query
   * result. Typically wired to `WorkflowContext.redact` so vault-resolved
   * secrets do not leak into a committed cassette. If never called,
   * `cassette()` returns raw strings.
   */
  setRedact(fn: (s: string) => string): void;
  /**
   * Snapshot the current cassette. Call after the runner has finished.
   * Returned cassette is a new object each call; mutating it does not
   * disturb the recorder's internal state.
   */
  cassette(): Cassette;
}

export function recordPage(live: Page, options: RecordOptions): RecordingResult {
  const queries: Record<string, CassetteValue> = {};
  const effects: CassetteEffect[] = [];
  const now = options.now ?? (() => new Date());
  let redact: (s: string) => string = identity;

  const page = new RecordingPage(live, queries, effects);

  return {
    page,
    setRedact(fn: (s: string) => string): void {
      redact = fn;
    },
    cassette: (): Cassette => ({
      version: CASSETTE_VERSION,
      workflowId: options.workflowId,
      workflowName: options.workflowName,
      recordedAt: now().toISOString(),
      queries: redactQueries(queries, redact),
      effects: effects.map((e) => ({ call: redact(e.call) })),
    }),
  };
}

function identity(s: string): string {
  return s;
}

function redactQueries(
  source: Record<string, CassetteValue>,
  redact: (s: string) => string,
): Record<string, CassetteValue> {
  const out: Record<string, CassetteValue> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = redactValue(value, redact);
  }
  return out;
}

function redactValue(value: CassetteValue, redact: (s: string) => string): CassetteValue {
  switch (value.kind) {
    case 'string':
      return { kind: 'string', value: redact(value.value) };
    case 'string-array':
      return { kind: 'string-array', value: value.value.map(redact) };
    case 'boolean':
    case 'number':
      return value;
  }
}

class RecordingPage implements Page {
  constructor(
    private readonly live: Page,
    private readonly queries: Record<string, CassetteValue>,
    private readonly effects: CassetteEffect[],
  ) {}

  async goto(url: string, options?: { waitUntil?: string }): Promise<void> {
    const args: unknown[] = options === undefined ? [url] : [url, options];
    this.effects.push({ call: callKey([], 'goto', args) });
    await this.live.goto(url, options);
  }

  url(): string {
    const value = this.live.url();
    this.queries[callKey([], 'url', [])] = { kind: 'string', value };
    return value;
  }

  async waitForTimeout(ms: number): Promise<void> {
    this.effects.push({ call: callKey([], 'waitForTimeout', [ms]) });
    await this.live.waitForTimeout(ms);
  }

  locator(selector: string): Locator {
    return new RecordingLocator(this.live.locator(selector), this.queries, this.effects, [
      segment('locator', [selector]),
    ]);
  }

  getByRole(role: string, options?: Record<string, unknown>): Locator {
    const args: unknown[] = options === undefined ? [role] : [role, options];
    return new RecordingLocator(this.live.getByRole(role, options), this.queries, this.effects, [
      segment('getByRole', args),
    ]);
  }

  getByTestId(value: string): Locator {
    return new RecordingLocator(this.live.getByTestId(value), this.queries, this.effects, [
      segment('getByTestId', [value]),
    ]);
  }

  getByText(value: string): Locator {
    return new RecordingLocator(this.live.getByText(value), this.queries, this.effects, [
      segment('getByText', [value]),
    ]);
  }

  getByLabel(value: string): Locator {
    return new RecordingLocator(this.live.getByLabel(value), this.queries, this.effects, [
      segment('getByLabel', [value]),
    ]);
  }
}

class RecordingLocator implements Locator {
  constructor(
    private readonly live: Locator,
    private readonly queries: Record<string, CassetteValue>,
    private readonly effects: CassetteEffect[],
    private readonly path: readonly string[],
  ) {}

  async click(): Promise<void> {
    this.effects.push({ call: callKey(this.path, 'click', []) });
    await this.live.click();
  }

  async fill(value: string): Promise<void> {
    this.effects.push({ call: callKey(this.path, 'fill', [value]) });
    await this.live.fill(value);
  }

  async isVisible(): Promise<boolean> {
    const value = await this.live.isVisible();
    this.queries[callKey(this.path, 'isVisible', [])] = { kind: 'boolean', value };
    return value;
  }

  async count(): Promise<number> {
    const value = await this.live.count();
    this.queries[callKey(this.path, 'count', [])] = { kind: 'number', value };
    return value;
  }

  async allTextContents(): Promise<string[]> {
    const value = await this.live.allTextContents();
    this.queries[callKey(this.path, 'allTextContents', [])] = {
      kind: 'string-array',
      value: value.slice(),
    };
    return value;
  }

  locator(selector: string): Locator {
    return new RecordingLocator(this.live.locator(selector), this.queries, this.effects, [
      ...this.path,
      segment('locator', [selector]),
    ]);
  }

  nth(i: number): Locator {
    return new RecordingLocator(this.live.nth(i), this.queries, this.effects, [
      ...this.path,
      segment('nth', [i]),
    ]);
  }

  async all(): Promise<Locator[]> {
    // .all() is not supported by the v1 cassette format. Let the live call
    // through so a user who runs the recorder on a workflow that needs
    // .all() gets the right error at verify time (CassetteMissError in
    // dry-run) rather than a confusing silent capture here.
    return this.live.all();
  }
}
