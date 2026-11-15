import { describe, it, expect } from 'vitest';
import { parse, ParseError } from '../src/index.js';
import { IR_VERSION } from '@sfysh/ir';

describe('parse', () => {
  describe('error handling', () => {
    it('throws ParseError when source has no test() calls', () => {
      expect(() => parse('const x = 1;')).toThrow(ParseError);
      expect(() => parse('const x = 1;')).toThrow(/No test\(\) calls found/);
    });

    it('throws ParseError when test body has no recognizable actions', () => {
      const source = `test('empty', async ({ page }) => {\n  const x = 1;\n});\n`;
      expect(() => parse(source)).toThrow(ParseError);
      expect(() => parse(source)).toThrow(/No recognizable Playwright actions/);
    });
  });

  describe('workflow metadata', () => {
    it('sets irVersion from the IR package', () => {
      const source = `test('basic', async ({ page }) => {\n  await page.goto('https://example.com');\n});\n`;
      expect(parse(source).workflow.irVersion).toBe(IR_VERSION);
    });

    it('derives workflow id from the test name', () => {
      const source = `test('loads the homepage', async ({ page }) => {\n  await page.goto('https://example.com');\n});\n`;
      expect(parse(source).workflow.id).toBe('loads_the_homepage');
    });

    it('uses the test name as the workflow name', () => {
      const source = `test('my test', async ({ page }) => {\n  await page.goto('https://example.com');\n});\n`;
      expect(parse(source).workflow.name).toBe('my test');
    });

    it('handles short test names by padding the id', () => {
      const source = `test('go', async ({ page }) => {\n  await page.goto('https://example.com');\n});\n`;
      const id = parse(source).workflow.id;
      expect(id.length).toBeGreaterThanOrEqual(3);
      expect(id).toMatch(/^[a-z][a-z0-9_-]{2,63}$/);
    });

    it('parses only the first test when multiple are present', () => {
      const source = [
        `test('first', async ({ page }) => { await page.goto('https://a.com'); });`,
        `test('second', async ({ page }) => { await page.goto('https://b.com'); });`,
      ].join('\n');
      expect(parse(source).workflow.name).toBe('first');
    });
  });

  describe('navigate steps', () => {
    it('maps page.goto to a navigate step', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n});\n`;
      const { workflow: wf } = parse(source);
      expect(wf.steps).toHaveLength(1);
      expect(wf.steps[0]).toMatchObject({
        action: 'navigate',
        url: 'https://example.com',
      });
    });
  });

  describe('click steps', () => {
    it('maps getByRole + click to a click step with role target', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await page.getByRole('button', { name: 'Submit' }).click();\n});\n`;
      const { workflow: wf } = parse(source);
      expect(wf.steps[1]).toMatchObject({
        action: 'click',
        target: { candidates: [{ kind: 'role', value: "button[name='Submit']" }] },
      });
    });

    it('maps getByTestId + click to a click step', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await page.getByTestId('login-btn').click();\n});\n`;
      const { workflow: wf } = parse(source);
      expect(wf.steps[1]).toMatchObject({
        action: 'click',
        target: { candidates: [{ kind: 'testid', value: 'login-btn' }] },
      });
    });
  });

  describe('fill steps', () => {
    it('maps getByLabel + fill to a fill step', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await page.getByLabel('Email').fill('test@example.com');\n});\n`;
      const { workflow: wf } = parse(source);
      expect(wf.steps[1]).toMatchObject({
        action: 'fill',
        target: { candidates: [{ kind: 'label', value: 'Email' }] },
        value: 'test@example.com',
      });
    });
  });

  describe('wait steps', () => {
    it('maps waitForTimeout to a wait step with millis', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await page.waitForTimeout(2000);\n});\n`;
      const { workflow: wf } = parse(source);
      expect(wf.steps[1]).toMatchObject({
        action: 'wait',
        millis: 2000,
      });
    });

    it('maps waitForSelector to a wait step with selectorVisible condition', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await page.waitForSelector('.loaded');\n});\n`;
      const { workflow: wf } = parse(source);
      expect(wf.steps[1]).toMatchObject({
        action: 'wait',
        forCondition: { selectorVisible: '.loaded' },
      });
    });

    it('maps waitForURL to a wait step with urlMatches condition', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await page.waitForURL('**/dashboard');\n});\n`;
      const { workflow: wf } = parse(source);
      expect(wf.steps[1]).toMatchObject({
        action: 'wait',
        forCondition: { urlMatches: '**/dashboard' },
      });
    });
  });

  describe('expect assertions as postconditions', () => {
    it('attaches expect after an action as a post condition', () => {
      const source = `test('t', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toHaveURL('https://example.com/home');
});\n`;
      const { workflow: wf } = parse(source);
      expect(wf.steps).toHaveLength(1);
      expect(wf.steps[0]?.post).toEqual([{ urlEquals: 'https://example.com/home' }]);
    });

    it('attaches multiple expects as multiple post conditions', () => {
      const source = `test('t', async ({ page }) => {
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page).toHaveURL('https://example.com/done');
  await expect(page.getByText('Success')).toBeVisible();
});\n`;
      const { workflow: wf } = parse(source);
      expect(wf.steps).toHaveLength(1);
      expect(wf.steps[0]?.post).toEqual([
        { urlEquals: 'https://example.com/done' },
        { textPresent: 'Success' },
      ]);
    });

    it('emits a standalone assert step when expect precedes any action', () => {
      const source = `test('t', async ({ page }) => {
  await expect(page.getByText('Welcome')).toBeVisible();
  await page.goto('https://example.com');
});\n`;
      const { workflow: wf } = parse(source);
      expect(wf.steps).toHaveLength(2);
      expect(wf.steps[0]).toMatchObject({
        action: 'assert',
        condition: { textPresent: 'Welcome' },
      });
    });
  });

  describe('step ids and intents', () => {
    it('generates unique step ids with padded counters', () => {
      const source = `test('t', async ({ page }) => {
  await page.goto('https://example.com');
  await page.getByLabel('Email').fill('a@b.com');
  await page.getByRole('button', { name: 'Go' }).click();
});\n`;
      const { workflow: wf } = parse(source);
      const ids = wf.steps.map((s) => s.id);
      expect(ids).toEqual(['navigate_001', 'fill_002', 'click_003']);
    });

    it('generates descriptive intents for each action', () => {
      const source = `test('t', async ({ page }) => {
  await page.goto('https://example.com');
  await page.getByRole('button', { name: 'Submit' }).click();
});\n`;
      const { workflow: wf } = parse(source);
      expect(wf.steps[0]?.intent).toBe('Navigate to https://example.com');
      expect(wf.steps[1]?.intent).toContain('Submit');
    });
  });

  describe('extract steps', () => {
    it('maps textContent on a locator chain to an extract step with string schema', () => {
      const source = `test('t', async ({ page }) => {\n  await page.getByTestId('user-name').textContent();\n});\n`;
      const { workflow } = parse(source);
      expect(workflow.steps).toHaveLength(1);
      expect(workflow.steps[0]).toMatchObject({
        action: 'extract',
        target: { candidates: [{ kind: 'testid', value: 'user-name' }] },
        schema: { type: 'string' },
      });
      expect((workflow.steps[0] as { bind?: string }).bind).toBeUndefined();
    });

    it('captures the identifier as bind for const name = await locator.textContent()', () => {
      const source = `test('t', async ({ page }) => {\n  const name = await page.getByTestId('user-name').textContent();\n});\n`;
      const { workflow } = parse(source);
      expect(workflow.steps[0]).toMatchObject({
        action: 'extract',
        bind: 'name',
        schema: { type: 'string' },
      });
      expect(workflow.steps[0]?.intent).toContain('name');
    });

    it('maps innerText and inputValue to extract steps with string schema', () => {
      const source = `test('t', async ({ page }) => {\n  const label = await page.getByRole('heading').innerText();\n  const email = await page.getByLabel('Email').inputValue();\n});\n`;
      const { workflow } = parse(source);
      expect(workflow.steps).toHaveLength(2);
      expect(workflow.steps[0]).toMatchObject({ action: 'extract', bind: 'label' });
      expect(workflow.steps[1]).toMatchObject({ action: 'extract', bind: 'email' });
      expect(workflow.steps[0]?.intent).toMatch(/text of/);
      expect(workflow.steps[1]?.intent).toMatch(/input value of/);
    });

    it('maps allTextContents to an extract step with array schema', () => {
      const source = `test('t', async ({ page }) => {\n  const items = await page.locator('.row').allTextContents();\n});\n`;
      const { workflow } = parse(source);
      expect(workflow.steps[0]).toMatchObject({
        action: 'extract',
        bind: 'items',
        schema: { type: 'array', items: { type: 'string' } },
      });
      expect(workflow.steps[0]?.intent).toMatch(/all text contents/);
    });

    it('drops only the bind when the identifier does not match the IR pattern', () => {
      const source = `test('t', async ({ page }) => {\n  const $weird = await page.getByTestId('x').textContent();\n});\n`;
      const { workflow } = parse(source);
      expect(workflow.steps[0]).toMatchObject({ action: 'extract' });
      expect((workflow.steps[0] as { bind?: string }).bind).toBeUndefined();
    });

    it('surfaces locator.evaluate as unsupported rather than silently dropping it', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await page.locator('.item').evaluate((el) => el.textContent);\n});\n`;
      const { workflow, unsupported } = parse(source);
      expect(workflow.steps).toHaveLength(1);
      expect(workflow.steps[0]?.action).toBe('navigate');
      expect(unsupported).toHaveLength(1);
      expect(unsupported[0]?.method).toBe('evaluate');
    });
  });

  describe('unsupported Playwright calls', () => {
    it('returns an empty unsupported list when every page call is recognised', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await page.getByRole('button').click();\n});\n`;
      expect(parse(source).unsupported).toEqual([]);
    });

    it('records page.hover as unsupported with method, position, and raw text', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await page.hover('.menu');\n});\n`;
      const { workflow, unsupported } = parse(source);
      expect(workflow.steps).toHaveLength(1);
      expect(unsupported).toHaveLength(1);
      expect(unsupported[0]?.method).toBe('hover');
      expect(unsupported[0]?.position.line).toBe(3);
      expect(unsupported[0]?.text).toBe("page.hover('.menu')");
    });

    it('records multiple unsupported calls in source order', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await page.hover('.menu');\n  await page.screenshot({ path: 'o.png' });\n  await page.dragAndDrop('.a', '.b');\n});\n`;
      const { unsupported } = parse(source);
      expect(unsupported.map((u) => u.method)).toEqual(['hover', 'screenshot', 'dragAndDrop']);
    });

    it('does not drop recognised steps when later steps are unsupported', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await page.hover('.menu');\n  await page.getByRole('button', { name: 'Submit' }).click();\n});\n`;
      const { workflow, unsupported } = parse(source);
      expect(workflow.steps.map((s) => s.action)).toEqual(['navigate', 'click']);
      expect(unsupported).toHaveLength(1);
      expect(unsupported[0]?.method).toBe('hover');
    });

    it('records chained unsupported terminals (e.g. locator.hover) by terminal method', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await page.locator('.item').hover();\n});\n`;
      const { unsupported } = parse(source);
      expect(unsupported).toHaveLength(1);
      expect(unsupported[0]?.method).toBe('hover');
      expect(unsupported[0]?.text).toBe("page.locator('.item').hover()");
    });

    it('still throws ParseError when no recognised actions remain', () => {
      const source = `test('t', async ({ page }) => {\n  await page.hover('.menu');\n  await page.screenshot({ path: 'o.png' });\n});\n`;
      expect(() => parse(source)).toThrow(/No recognizable Playwright actions/);
    });
  });

  describe('unsupported expect() matchers', () => {
    it('records an unrecognised matcher with the matcher name, position, and raw text', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await expect(page.getByText('X')).toHaveCount(3);\n});\n`;
      const { workflow, unsupported } = parse(source);
      expect(workflow.steps).toHaveLength(1);
      expect(unsupported).toHaveLength(1);
      expect(unsupported[0]?.method).toBe('toHaveCount');
      expect(unsupported[0]?.position.line).toBe(3);
      expect(unsupported[0]?.text).toBe("expect(page.getByText('X')).toHaveCount(3)");
    });

    it('records a supported matcher whose subject cannot be mapped', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await expect(page.getByPlaceholder('Search')).toBeVisible();\n});\n`;
      const { unsupported } = parse(source);
      expect(unsupported).toHaveLength(1);
      expect(unsupported[0]?.method).toBe('toBeVisible');
      expect(unsupported[0]?.text).toBe("expect(page.getByPlaceholder('Search')).toBeVisible()");
    });

    it('records toHaveURL with a regex argument it cannot translate', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await expect(page).toHaveURL(/dashboard/);\n});\n`;
      const { unsupported } = parse(source);
      expect(unsupported).toHaveLength(1);
      expect(unsupported[0]?.method).toBe('toHaveURL');
    });

    it('does not report mapped expect() assertions', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await expect(page.getByText('Welcome')).toBeVisible();\n});\n`;
      const { workflow, unsupported } = parse(source);
      expect(unsupported).toEqual([]);
      expect(workflow.steps[0]?.post).toEqual([{ textPresent: 'Welcome' }]);
    });

    it('interleaves unsupported page calls and expect matchers in source order', () => {
      const source = `test('t', async ({ page }) => {\n  await page.goto('https://example.com');\n  await page.hover('.menu');\n  await expect(page.getByText('X')).toHaveCount(3);\n});\n`;
      const { unsupported } = parse(source);
      expect(unsupported.map((u) => u.method)).toEqual(['hover', 'toHaveCount']);
    });
  });

  describe('for-of loop steps', () => {
    it('lifts a for-of with .all() into an IR loop step with foreach and do', () => {
      const source = `test('t', async ({ page }) => {
  await page.goto('https://example.com');
  for (const row of await page.locator('table tr').all()) {
    await row.locator('button').click();
  }
});\n`;
      const { workflow: wf } = parse(source);
      expect(wf.steps).toHaveLength(2);
      expect(wf.steps[1]).toMatchObject({
        action: 'loop',
        foreach: { candidates: [{ kind: 'css', value: 'table tr' }] },
      });
      const loop = wf.steps[1] as { do: { action: string }[] };
      expect(loop.do).toHaveLength(1);
      expect(loop.do[0]).toMatchObject({ action: 'click' });
    });

    it('lifts inner extract steps inside the loop body', () => {
      const source = `test('t', async ({ page }) => {
  await page.goto('https://example.com');
  for (const row of await page.locator('tr').all()) {
    const name = await row.locator('.name').textContent();
  }
});\n`;
      const { workflow: wf } = parse(source);
      expect(wf.steps[1]).toMatchObject({ action: 'loop' });
      const loop = wf.steps[1] as { do: { action: string; bind?: string; schema?: unknown }[] };
      expect(loop.do[0]).toMatchObject({
        action: 'extract',
        bind: 'name',
        schema: { type: 'string' },
      });
    });

    it('attaches expect() inside a loop body as post on the preceding inner step', () => {
      const source = `test('t', async ({ page }) => {
  await page.goto('https://example.com');
  for (const row of await page.locator('tr').all()) {
    await row.locator('button').click();
    await expect(row.getByText('Done')).toBeVisible();
  }
});\n`;
      const { workflow: wf } = parse(source);
      const loop = wf.steps[1] as { do: { action: string; post?: unknown[] }[] };
      expect(loop.do).toHaveLength(1);
      expect(loop.do[0]?.post).toEqual([{ textPresent: 'Done' }]);
    });

    it('collects unsupported calls inside the loop body', () => {
      const source = `test('t', async ({ page }) => {
  await page.goto('https://example.com');
  for (const row of await page.locator('tr').all()) {
    await row.hover();
  }
});\n`;
      const { workflow: wf, unsupported } = parse(source);
      expect(wf.steps).toHaveLength(1);
      expect(unsupported).toHaveLength(1);
      expect(unsupported[0]?.method).toBe('hover');
    });

    it('uses getByRole iterable for the foreach target', () => {
      const source = `test('t', async ({ page }) => {
  for (const item of await page.getByRole('listitem').all()) {
    await item.getByRole('button').click();
  }
});\n`;
      const { workflow: wf } = parse(source);
      expect(wf.steps[0]).toMatchObject({
        action: 'loop',
        foreach: { candidates: [{ kind: 'role', value: 'listitem' }] },
      });
    });
  });

  describe('full hand-written Playwright script', () => {
    it('parses a login flow into a complete workflow', () => {
      const source = `
import { test, expect } from '@playwright/test';

test('login to dashboard', async ({ page }) => {
  await page.goto('https://app.example.com/login');
  await page.getByLabel('Email').fill('user@example.com');
  await page.getByLabel('Password').fill('secret123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('https://app.example.com/dashboard');
  await expect(page.getByText('Welcome back')).toBeVisible();
});
`;
      const { workflow: wf } = parse(source);

      expect(wf.irVersion).toBe(IR_VERSION);
      expect(wf.id).toBe('login_to_dashboard');
      expect(wf.name).toBe('login to dashboard');
      expect(wf.steps).toHaveLength(4);

      expect(wf.steps[0]).toMatchObject({
        action: 'navigate',
        url: 'https://app.example.com/login',
      });
      expect(wf.steps[1]).toMatchObject({ action: 'fill', value: 'user@example.com' });
      // The literal password is lifted into a vault reference; it must not
      // appear anywhere in the IR.
      expect(wf.steps[2]).toMatchObject({ action: 'fill', value: { secret: 'password' } });
      expect(wf.secrets).toEqual(['password']);
      expect(JSON.stringify(wf)).not.toContain('secret123');
      expect(wf.steps[3]).toMatchObject({
        action: 'click',
        target: { candidates: [{ kind: 'role', value: "button[name='Sign in']" }] },
      });

      expect(wf.steps[3]?.post).toEqual([
        { urlEquals: 'https://app.example.com/dashboard' },
        { textPresent: 'Welcome back' },
      ]);
    });

    it('parses a form submission with multiple assertions', () => {
      const source = `
import { test, expect } from '@playwright/test';

test('submit contact form', async ({ page }) => {
  await page.goto('https://example.com/contact');
  await page.getByLabel('Name').fill('Jane Doe');
  await page.getByLabel('Message').fill('Hello there');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Message sent')).toBeVisible();
  await expect(page.locator('.error')).toBeHidden();
});
`;
      const { workflow: wf } = parse(source);

      expect(wf.steps).toHaveLength(4);
      expect(wf.steps[3]?.post).toEqual([
        { textPresent: 'Message sent' },
        { selectorAbsent: '.error' },
      ]);
    });

    it('parses a script with wait and navigation checks', () => {
      const source = `
import { test, expect } from '@playwright/test';

test('checkout flow', async ({ page }) => {
  await page.goto('https://shop.example.com/cart');
  await page.waitForSelector('.cart-items');
  await page.getByRole('button', { name: 'Checkout' }).click();
  await page.waitForURL('**/checkout');
  await page.getByLabel('Card number').fill('4111111111111111');
  await page.getByRole('button', { name: 'Pay' }).click();
  await expect(page.getByText('Order confirmed')).toBeVisible();
});
`;
      const { workflow: wf } = parse(source);

      expect(wf.steps).toHaveLength(6);
      expect(wf.steps[0]).toMatchObject({ action: 'navigate' });
      expect(wf.steps[1]).toMatchObject({
        action: 'wait',
        forCondition: { selectorVisible: '.cart-items' },
      });
      expect(wf.steps[2]).toMatchObject({ action: 'click' });
      expect(wf.steps[3]).toMatchObject({
        action: 'wait',
        forCondition: { urlMatches: '**/checkout' },
      });
      expect(wf.steps[4]).toMatchObject({ action: 'fill', value: '4111111111111111' });
      expect(wf.steps[5]).toMatchObject({ action: 'click' });
      expect(wf.steps[5]?.post).toEqual([{ textPresent: 'Order confirmed' }]);
    });
  });
});
