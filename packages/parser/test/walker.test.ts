import { describe, it, expect } from 'vitest';
import { walkFile } from '../src/walker.js';

describe('walkFile', () => {
  it('returns an empty list when no top-level test() call is present', () => {
    expect(walkFile('const x = 1;')).toEqual([]);
  });

  it('extracts a single test with its name and position', () => {
    const source = `test('loads homepage', async ({ page }) => {\n  await page.goto('https://example.com');\n});\n`;
    const walked = walkFile(source);
    expect(walked).toHaveLength(1);
    expect(walked[0]?.name).toBe('loads homepage');
    expect(walked[0]?.position.line).toBe(1);
  });

  it('extracts a page.goto chain with the url argument as raw source text', () => {
    const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n});\n`;
    const [walked] = walkFile(source);
    expect(walked?.calls).toHaveLength(1);
    expect(walked?.calls[0]?.root).toBe('page');
    expect(walked?.calls[0]?.links).toEqual([{ method: 'goto', args: ["'https://example.com'"] }]);
  });

  it('flattens a role-based locator chain into ordered links', () => {
    const source = `test('t', async ({ page }) => {\n  await page.getByRole('button', { name: 'Submit' }).click();\n});\n`;
    const [walked] = walkFile(source);
    expect(walked?.calls[0]?.root).toBe('page');
    expect(walked?.calls[0]?.links).toEqual([
      { method: 'getByRole', args: ["'button'", "{ name: 'Submit' }"] },
      { method: 'click', args: [] },
    ]);
  });

  it('preserves source order across multiple statements in one body', () => {
    const source = `test('t', async ({ page }) => {\n  await page.goto('u');\n  await page.getByRole('button').click();\n  await page.getByLabel('Email').fill('a@b.c');\n});\n`;
    const [walked] = walkFile(source);
    const methods = walked?.calls.map((c) => c.links[c.links.length - 1]?.method);
    expect(methods).toEqual(['goto', 'click', 'fill']);
  });

  it('extracts expect() assertions as chains rooted at the expect identifier', () => {
    const source = `test('t', async ({ page }) => {\n  await expect(page.getByText('Hello')).toBeVisible();\n});\n`;
    const [walked] = walkFile(source);
    const chain = walked?.calls[0];
    expect(chain?.root).toBe('expect');
    expect(chain?.links[0]?.method).toBe('expect');
    expect(chain?.links[chain.links.length - 1]?.method).toBe('toBeVisible');
  });

  it('returns multiple tests in file order', () => {
    const source = `test('first', async ({ page }) => { await page.goto('a'); });\ntest('second', async ({ page }) => { await page.goto('b'); });\n`;
    const walked = walkFile(source);
    expect(walked.map((t) => t.name)).toEqual(['first', 'second']);
  });

  it('ignores statements that are not direct call expressions (variable declarations, control flow)', () => {
    const source = `test('t', async ({ page }) => {\n  const url = 'https://example.com';\n  await page.goto(url);\n  if (true) { await page.click('x'); }\n});\n`;
    const [walked] = walkFile(source);
    expect(walked?.calls).toHaveLength(1);
    expect(walked?.calls[0]?.links[0]?.method).toBe('goto');
    expect(walked?.calls[0]?.links[0]?.args).toEqual(['url']);
  });

  it('skips test() calls that lack a string literal name', () => {
    const source = `const name = 'dynamic'; test(name, async ({ page }) => { await page.goto('x'); });\n`;
    expect(walkFile(source)).toEqual([]);
  });

  it('records 1-based line and column for the test call site', () => {
    const source = `\n\n  test('t', async ({ page }) => { await page.goto('x'); });\n`;
    const [walked] = walkFile(source);
    expect(walked?.position).toEqual({ line: 3, column: 3 });
  });
});
