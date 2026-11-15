// Literal credentials in a Playwright script must not enter the IR. The
// parser replaces them with vault references and reports what it did.

import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '@sfysh/ir';
import { parse } from '../src/index.js';

function script(body: string): string {
  return `test('login', async ({ page }) => {\n  await page.goto('https://x.test');\n${body}\n});\n`;
}

describe('parse: literal credentials', () => {
  it.each([
    ["page.getByLabel('Password')", 'password'],
    ["page.getByLabel('Confirm password')", 'confirm_password'],
    ["page.locator('#login-pwd')", 'login_pwd'],
    ['page.locator(\'input[name="api_key"]\')', 'input_name_api_key'],
    ["page.getByTestId('otp-input')", 'otp_input'],
    ["page.getByRole('textbox', { name: 'Access token' })", 'access_token'],
    ["page.getByLabel('PIN')", 'pin'],
    ["page.getByLabel('Client secret')", 'client_secret'],
    ["page.locator('.form').getByLabel('Passcode')", 'passcode'],
  ])('lifts a literal typed into %s to vault secret %s', (locator, secret) => {
    const { workflow, warnings } = parse(script(`  await ${locator}.fill('s3cr3t-literal');`));

    expect(workflow.steps[1]).toMatchObject({ action: 'fill', value: { secret } });
    expect(workflow.secrets).toEqual([secret]);
    expect(JSON.stringify(workflow)).not.toContain('s3cr3t-literal');
    expect(warnings).toEqual([
      expect.objectContaining({ kind: 'literal-secret', stepId: 'fill_002', secret }),
    ]);
    expect(JSON.stringify(warnings)).not.toContain('s3cr3t-literal');
    expect(validateWorkflow(workflow).errors).toEqual([]);
  });

  it.each([
    "page.getByLabel('Email')",
    "page.getByLabel('Passenger name')",
    "page.locator('#bypass-code')",
    "page.getByLabel('Shipping address')",
    "page.getByLabel('Spinner speed')",
  ])('keeps the literal for an ordinary field (%s) and flags it', (locator) => {
    const { workflow, warnings } = parse(script(`  await ${locator}.fill('plain value');`));

    expect(workflow.steps[1]).toMatchObject({ action: 'fill', value: 'plain value' });
    expect(workflow.secrets).toBeUndefined();
    expect(warnings).toEqual([
      expect.objectContaining({ kind: 'literal-fill', stepId: 'fill_002' }),
    ]);
    expect(JSON.stringify(warnings)).not.toContain('plain value');
  });

  it('reports the source position of the fill', () => {
    const { warnings } = parse(script(`  await page.getByLabel('Password').fill('x');`));
    expect(warnings[0]?.position).toEqual({ line: 3, column: 3 });
  });

  it('uses one secret for two fills on the same field and separate ones otherwise', () => {
    const { workflow } = parse(
      script(
        [
          `  await page.getByLabel('Password').fill('first');`,
          `  await page.getByLabel('Password').fill('second');`,
          `  await page.getByLabel('Confirm password').fill('second');`,
        ].join('\n'),
      ),
    );
    expect(workflow.secrets).toEqual(['password', 'confirm_password']);
  });

  it('falls back to a numbered name when the field gives nothing usable', () => {
    const { workflow } = parse(script(`  await page.getByLabel('密码 (password)').fill('x');`));
    expect(workflow.secrets).toEqual(['password']);

    const odd = parse(script(`  await page.locator('#pwd-box').getByLabel('口令').fill('x');`));
    // The innermost locator is the target; the credential hint came from the
    // outer one, and the label has no ASCII characters to build a name from.
    expect(odd.workflow.secrets).toEqual(['secret_002']);
    expect(validateWorkflow(odd.workflow).errors).toEqual([]);
  });

  it('lifts credentials inside a loop body and declares them on the workflow', () => {
    const { workflow, warnings } = parse(
      script(
        [
          `  for (const row of await page.locator('tr').all()) {`,
          `    await row.getByLabel('Password').fill('looped');`,
          `  }`,
        ].join('\n'),
      ),
    );
    expect(workflow.secrets).toEqual(['password']);
    expect(JSON.stringify(workflow)).not.toContain('looped');
    expect(warnings).toHaveLength(1);
    expect(validateWorkflow(workflow).errors).toEqual([]);
  });

  it('returns an empty warnings list when there is nothing to report', () => {
    const { warnings } = parse(script(`  await page.getByRole('button').click();`));
    expect(warnings).toEqual([]);
  });
});

describe('parse: step ids stay unique across nested bodies', () => {
  it('does not restart numbering inside a loop', () => {
    const { workflow } = parse(
      script(
        [
          `  await page.locator('#a').click();`,
          `  for (const row of await page.locator('tr').all()) {`,
          `    await row.locator('#b').click();`,
          `    await row.locator('#c').click();`,
          `  }`,
          `  await page.locator('#d').click();`,
        ].join('\n'),
      ),
    );
    const ids: string[] = [];
    const collect = (steps: readonly unknown[]): void => {
      for (const s of steps as Array<{ id: string; do?: unknown[] }>) {
        ids.push(s.id);
        if (s.do) collect(s.do);
      }
    };
    collect(workflow.steps);
    expect(new Set(ids).size).toBe(ids.length);
    expect(validateWorkflow(workflow).errors).toEqual([]);
  });
});
