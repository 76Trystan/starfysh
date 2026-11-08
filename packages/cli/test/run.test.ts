import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runParseCommand } from '../src/index.js';

class StringSink {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
}

function ctx() {
  return { stdout: new StringSink(), stderr: new StringSink() };
}

const samplePlaywright = `
import { test, expect } from '@playwright/test';

test('submit a report', async ({ page }) => {
  await page.goto('https://portal.example.com/reports/new');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Submitted')).toBeVisible();
});
`;

describe('run (top-level dispatch)', () => {
  it('prints help on --help', () => {
    const c = ctx();
    const code = run(['--help'], c);
    expect(code).toBe(0);
    expect(c.stdout.text).toContain('compile <command>');
    expect(c.stdout.text).toContain('parse');
  });

  it('prints help with no arguments', () => {
    const c = ctx();
    const code = run([], c);
    expect(code).toBe(0);
    expect(c.stdout.text).toContain('compile <command>');
  });

  it('rejects unknown commands', () => {
    const c = ctx();
    const code = run(['does-not-exist'], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain("unknown command 'does-not-exist'");
  });
});

describe('compile parse', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sfysh-cli-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits workflow JSON to stdout', () => {
    const file = join(dir, 'report.spec.ts');
    writeFileSync(file, samplePlaywright, 'utf8');

    const c = ctx();
    const code = run(['parse', file], c);

    expect(code).toBe(0);
    expect(c.stderr.text).toBe('');
    const parsed = JSON.parse(c.stdout.text);
    expect(parsed.name).toBe('submit a report');
    expect(parsed.id).toBe('submit_a_report');
    expect(parsed.steps.length).toBeGreaterThan(0);
  });

  it('writes to --out when supplied, keeping stdout empty', () => {
    const file = join(dir, 'report.spec.ts');
    const out = join(dir, 'report.workflow.json');
    writeFileSync(file, samplePlaywright, 'utf8');

    const c = ctx();
    const code = run(['parse', file, '--out', out], c);

    expect(code).toBe(0);
    expect(c.stdout.text).toBe('');
    expect(c.stderr.text).toContain(`Wrote ${out}`);
    expect(existsSync(out)).toBe(true);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(parsed.name).toBe('submit a report');
  });

  it('accepts the short -o alias', () => {
    const file = join(dir, 'report.spec.ts');
    const out = join(dir, 'report.workflow.json');
    writeFileSync(file, samplePlaywright, 'utf8');

    const c = ctx();
    const code = run(['parse', file, '-o', out], c);

    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it('shows help for parse --help', () => {
    const c = ctx();
    const code = run(['parse', '--help'], c);
    expect(code).toBe(0);
    expect(c.stdout.text).toContain('compile parse <file>');
    expect(c.stdout.text).toContain('--out');
  });

  it('errors on missing file argument', () => {
    const c = ctx();
    const code = run(['parse'], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain('missing <file> argument');
  });

  it('errors on extra positional argument', () => {
    const c = ctx();
    const code = run(['parse', 'one.ts', 'two.ts'], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain("unexpected argument 'two.ts'");
  });

  it('errors on unknown option', () => {
    const c = ctx();
    const code = run(['parse', 'x.ts', '--nope'], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain('compile parse:');
  });

  it('reports a clear error for missing files', () => {
    const c = ctx();
    const code = run(['parse', join(dir, 'does-not-exist.ts')], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain('file not found');
  });

  it('reports parse errors from the parser', () => {
    const file = join(dir, 'empty.ts');
    writeFileSync(file, 'const x = 1;\n', 'utf8');

    const c = ctx();
    const code = run(['parse', file], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain('No test() calls found');
  });
});

describe('runParseCommand', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sfysh-cli-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the workflow JSON when no out path given', () => {
    const file = join(dir, 'report.spec.ts');
    writeFileSync(file, samplePlaywright, 'utf8');

    const result = runParseCommand({ file });
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe('submit a report');
  });

  it('writes to disk and returns empty string when out path given', () => {
    const file = join(dir, 'report.spec.ts');
    const out = join(dir, 'report.workflow.json');
    writeFileSync(file, samplePlaywright, 'utf8');

    const result = runParseCommand({ file, out });
    expect(result).toBe('');
    expect(existsSync(out)).toBe(true);
    const disk = readFileSync(out, 'utf8');
    expect(disk.endsWith('\n')).toBe(true);
    expect(JSON.parse(disk).name).toBe('submit a report');
  });
});
