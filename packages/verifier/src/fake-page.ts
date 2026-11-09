// FakePage: a Page implementation that satisfies the @sfysh/runtime Page
// contract by replaying a cassette. Every query (url, isVisible, count,
// allTextContents) is resolved by looking up a canonical call key in the
// cassette. Side-effecting methods (goto, click, fill, waitForTimeout) are
// no-ops; the runner's behaviour does not depend on their effects in a
// snapshot world.
//
// A missing key throws CassetteMissError. That is the signal a runner has
// changed what it asks the page: re-record the cassette.

import type { Locator, Page } from '@sfysh/runtime';
import {
  CassetteMissError,
  callKey,
  segment,
  type Cassette,
  type CassetteValue,
} from './cassette.js';

/**
 * Build a FakePage from a cassette. The returned Page can be used anywhere
 * the @sfysh/runtime Page interface is expected.
 */
export function fakePageFromCassette(cassette: Cassette): Page {
  return new FakePage(cassette);
}

class FakePage implements Page {
  constructor(private readonly cassette: Cassette) {}

  async goto(_url: string): Promise<void> {
    // no-op; a cassette is a snapshot, navigation state is fixed
  }

  url(): string {
    return readString(this.cassette, callKey([], 'url', []));
  }

  async waitForTimeout(_ms: number): Promise<void> {
    // no-op in dry-run; the point of a cassette is determinism, not timing
  }

  locator(selector: string): Locator {
    return new FakeLocator(this.cassette, [segment('locator', [selector])]);
  }

  getByRole(role: string, options?: Record<string, unknown>): Locator {
    const args: unknown[] = options === undefined ? [role] : [role, options];
    return new FakeLocator(this.cassette, [segment('getByRole', args)]);
  }

  getByTestId(value: string): Locator {
    return new FakeLocator(this.cassette, [segment('getByTestId', [value])]);
  }

  getByText(value: string): Locator {
    return new FakeLocator(this.cassette, [segment('getByText', [value])]);
  }

  getByLabel(value: string): Locator {
    return new FakeLocator(this.cassette, [segment('getByLabel', [value])]);
  }
}

class FakeLocator implements Locator {
  constructor(
    private readonly cassette: Cassette,
    private readonly path: readonly string[],
  ) {}

  async click(): Promise<void> {
    // no-op
  }

  async fill(_value: string): Promise<void> {
    // no-op
  }

  async isVisible(): Promise<boolean> {
    return readBoolean(this.cassette, callKey(this.path, 'isVisible', []));
  }

  async count(): Promise<number> {
    return readNumber(this.cassette, callKey(this.path, 'count', []));
  }

  async allTextContents(): Promise<string[]> {
    return readStringArray(this.cassette, callKey(this.path, 'allTextContents', []));
  }

  locator(selector: string): Locator {
    return new FakeLocator(this.cassette, [...this.path, segment('locator', [selector])]);
  }

  nth(i: number): Locator {
    return new FakeLocator(this.cassette, [...this.path, segment('nth', [i])]);
  }

  async all(): Promise<Locator[]> {
    // Cassette format does not support .all() in v1. A runner that needs it
    // belongs on live or on a v2 cassette format.
    throw new CassetteMissError(callKey(this.path, 'all', []));
  }
}

function readValue(cassette: Cassette, key: string): CassetteValue {
  const entry = cassette.queries[key];
  if (entry === undefined) {
    throw new CassetteMissError(key);
  }
  return entry;
}

function readString(cassette: Cassette, key: string): string {
  const v = readValue(cassette, key);
  if (v.kind !== 'string') {
    throw new CassetteMissError(`${key} (expected string, got ${v.kind})`);
  }
  return v.value;
}

function readBoolean(cassette: Cassette, key: string): boolean {
  const v = readValue(cassette, key);
  if (v.kind !== 'boolean') {
    throw new CassetteMissError(`${key} (expected boolean, got ${v.kind})`);
  }
  return v.value;
}

function readNumber(cassette: Cassette, key: string): number {
  const v = readValue(cassette, key);
  if (v.kind !== 'number') {
    throw new CassetteMissError(`${key} (expected number, got ${v.kind})`);
  }
  return v.value;
}

function readStringArray(cassette: Cassette, key: string): string[] {
  const v = readValue(cassette, key);
  if (v.kind !== 'string-array') {
    throw new CassetteMissError(`${key} (expected string-array, got ${v.kind})`);
  }
  return v.value.slice();
}
