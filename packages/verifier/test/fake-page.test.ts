import { describe, it, expect } from 'vitest';
import {
  CASSETTE_VERSION,
  CassetteMissError,
  fakePageFromCassette,
  type Cassette,
} from '../src/index.js';

function cassette(queries: Cassette['queries'] = {}): Cassette {
  return {
    version: CASSETTE_VERSION,
    workflowId: 'wf',
    workflowName: 'wf',
    recordedAt: '2026-11-09T00:00:00.000Z',
    queries,
    effects: [],
  };
}

describe('FakePage', () => {
  it('returns the recorded url', () => {
    const page = fakePageFromCassette(
      cassette({ url: { kind: 'string', value: 'https://example.com/done' } }),
    );
    expect(page.url()).toBe('https://example.com/done');
  });

  it('throws CassetteMissError when url was never recorded', () => {
    const page = fakePageFromCassette(cassette());
    expect(() => page.url()).toThrow(CassetteMissError);
  });

  it('serves locator(isVisible) from a single-segment path', async () => {
    const page = fakePageFromCassette(
      cassette({
        'locator("#submit").isVisible': { kind: 'boolean', value: true },
      }),
    );
    await expect(page.locator('#submit').isVisible()).resolves.toBe(true);
  });

  it('serves locator(count) from a single-segment path', async () => {
    const page = fakePageFromCassette(
      cassette({
        'locator("#rows").count': { kind: 'number', value: 7 },
      }),
    );
    await expect(page.locator('#rows').count()).resolves.toBe(7);
  });

  it('serves allTextContents', async () => {
    const page = fakePageFromCassette(
      cassette({
        'locator(".row").allTextContents': { kind: 'string-array', value: ['a', 'b'] },
      }),
    );
    await expect(page.locator('.row').allTextContents()).resolves.toEqual(['a', 'b']);
  });

  it('serves nested locator chains', async () => {
    const page = fakePageFromCassette(
      cassette({
        'locator("#form").nth(0).locator("input").isVisible': { kind: 'boolean', value: false },
      }),
    );
    await expect(page.locator('#form').nth(0).locator('input').isVisible()).resolves.toBe(false);
  });

  it('serves getByRole with options', async () => {
    const page = fakePageFromCassette(
      cassette({
        'getByRole("button",{"name":"Submit"}).isVisible': { kind: 'boolean', value: true },
      }),
    );
    await expect(page.getByRole('button', { name: 'Submit' }).isVisible()).resolves.toBe(true);
  });

  it('serves getByText and getByTestId and getByLabel', async () => {
    const page = fakePageFromCassette(
      cassette({
        'getByText("Submitted").count': { kind: 'number', value: 1 },
        'getByTestId("row").count': { kind: 'number', value: 3 },
        'getByLabel("Email").isVisible': { kind: 'boolean', value: true },
      }),
    );
    await expect(page.getByText('Submitted').count()).resolves.toBe(1);
    await expect(page.getByTestId('row').count()).resolves.toBe(3);
    await expect(page.getByLabel('Email').isVisible()).resolves.toBe(true);
  });

  it('throws CassetteMissError with the key when a query is missing', async () => {
    const page = fakePageFromCassette(cassette());
    try {
      await page.locator('#x').isVisible();
      expect.fail('expected CassetteMissError');
    } catch (err) {
      expect(err).toBeInstanceOf(CassetteMissError);
      expect((err as CassetteMissError).key).toBe('locator("#x").isVisible');
    }
  });

  it('throws CassetteMissError when recorded kind mismatches', async () => {
    const page = fakePageFromCassette(
      cassette({
        'locator("#x").isVisible': { kind: 'string', value: 'true' },
      }),
    );
    await expect(page.locator('#x').isVisible()).rejects.toBeInstanceOf(CassetteMissError);
  });

  it('side-effecting methods on Page and Locator are no-ops', async () => {
    const page = fakePageFromCassette(cassette());
    await page.goto('https://example.com/');
    await page.waitForTimeout(5);
    await page.locator('#x').click();
    await page.locator('#y').fill('hello');
    // No assertions needed; we only care that none of these throw.
  });

  it('.all() is not supported in v1 and throws', async () => {
    const page = fakePageFromCassette(cassette());
    await expect(page.locator('#x').all()).rejects.toBeInstanceOf(CassetteMissError);
  });
});
