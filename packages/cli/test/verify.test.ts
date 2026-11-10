import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, runVerifyCommand, reportIsGreen, VerifyLoadError } from '../src/index.js';

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

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const backendSuccess = resolvePath(fixturesDir, 'backend-success.mjs');
const backendFails = resolvePath(fixturesDir, 'backend-fails.mjs');
const backendDrift = resolvePath(fixturesDir, 'backend-drift.mjs');
const backendMissingRunner = resolvePath(fixturesDir, 'backend-missing-runner.mjs');
const backendRecording = resolvePath(fixturesDir, 'backend-recording.mjs');

const minimalWorkflow = {
  irVersion: '1.0.0',
  id: 'wf_test',
  name: 'Test Workflow',
  steps: [
    {
      id: 'step_one',
      intent: 'open the test page',
      action: 'navigate',
      url: 'https://example.com/',
    },
  ],
};

function writeWorkflow(dir: string, name = 'workflow.json'): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(minimalWorkflow, null, 2), 'utf8');
  return path;
}

describe('compile verify (dispatch and CLI parsing)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sfysh-cli-verify-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is listed in top-level help', () => {
    const c = ctx();
    const code = run(['--help'], c);
    expect(code).toBe(0);
    expect(c.stdout.text).toContain('verify');
  });

  it('prints command-specific help on --help', async () => {
    const c = ctx();
    const code = await run(['verify', '--help'], c);
    expect(code).toBe(0);
    expect(c.stdout.text).toContain('compile verify <file>');
    expect(c.stdout.text).toContain('--backend');
    expect(c.stdout.text).toContain('--runs');
    expect(c.stdout.text).toContain('Exit codes');
  });

  it('errors when the workflow file is missing', async () => {
    const c = ctx();
    const code = await run(['verify'], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain('missing <file> argument');
  });

  it('errors when --backend is omitted', async () => {
    const workflow = writeWorkflow(dir);
    const c = ctx();
    const code = await run(['verify', workflow], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain('missing --backend');
  });

  it('errors on extra positional argument', async () => {
    const workflow = writeWorkflow(dir);
    const c = ctx();
    const code = await run(['verify', workflow, 'extra.json', '--backend', backendSuccess], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain("unexpected argument 'extra.json'");
  });

  it('errors on unknown option', async () => {
    const workflow = writeWorkflow(dir);
    const c = ctx();
    const code = await run(['verify', workflow, '--backend', backendSuccess, '--nope'], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain('compile verify:');
  });

  it('errors when --runs is not a positive integer', async () => {
    const workflow = writeWorkflow(dir);
    const c = ctx();
    const code = await run(['verify', workflow, '--backend', backendSuccess, '--runs', 'zero'], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain('--runs must be a positive integer');
  });

  it('reports a clear error for missing workflow files', async () => {
    const c = ctx();
    const code = await run(
      ['verify', join(dir, 'does-not-exist.json'), '--backend', backendSuccess],
      c,
    );
    expect(code).toBe(1);
    expect(c.stderr.text).toContain('file not found');
  });

  it('reports a clear error for invalid JSON', async () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{ not: json', 'utf8');
    const c = ctx();
    const code = await run(['verify', path, '--backend', backendSuccess], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain('not valid JSON');
  });

  it('reports a clear error when the workflow fails IR validation', async () => {
    const path = join(dir, 'invalid.json');
    writeFileSync(path, JSON.stringify({ id: 'bad' }), 'utf8');
    const c = ctx();
    const code = await run(['verify', path, '--backend', backendSuccess], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain('failed IR validation');
  });

  it('reports a clear error when the backend is missing the runner export', async () => {
    const workflow = writeWorkflow(dir);
    const c = ctx();
    const code = await run(['verify', workflow, '--backend', backendMissingRunner], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain("'runner' function");
  });
});

describe('compile verify (happy path and reporting)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sfysh-cli-verify-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs the verifier and prints a human-readable report, exit 0 when green', async () => {
    const workflow = writeWorkflow(dir);
    const c = ctx();
    const code = await run(['verify', workflow, '--backend', backendSuccess, '--runs', '2'], c);

    expect(code).toBe(0);
    expect(c.stderr.text).toBe('');
    expect(c.stdout.text).toContain('Test Workflow');
    expect(c.stdout.text).toContain('Runs: 2');
    expect(c.stdout.text).toContain('Passed: 2');
    expect(c.stdout.text).toContain('Stability: stable');
  });

  it('emits JSON when --json is passed', async () => {
    const workflow = writeWorkflow(dir);
    const c = ctx();
    const code = await run(
      ['verify', workflow, '--backend', backendSuccess, '--runs', '2', '--json'],
      c,
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.text);
    expect(parsed.workflowId).toBe('wf_test');
    expect(parsed.runs).toBe(2);
    expect(parsed.passed).toBe(2);
  });

  it('writes the report to --out when supplied, keeping stdout empty', async () => {
    const workflow = writeWorkflow(dir);
    const outPath = join(dir, 'report.txt');
    const c = ctx();
    const code = await run(
      ['verify', workflow, '--backend', backendSuccess, '--runs', '1', '--out', outPath],
      c,
    );

    expect(code).toBe(0);
    expect(c.stdout.text).toBe('');
    expect(c.stderr.text).toContain(`Wrote ${outPath}`);
    expect(existsSync(outPath)).toBe(true);
    const contents = readFileSync(outPath, 'utf8');
    expect(contents).toContain('Test Workflow');
    expect(contents.endsWith('\n')).toBe(true);
  });

  it('exits 2 and surfaces the error when a replay fails', async () => {
    const workflow = writeWorkflow(dir);
    const c = ctx();
    const code = await run(['verify', workflow, '--backend', backendFails, '--runs', '1'], c);

    expect(code).toBe(2);
    expect(c.stdout.text).toContain('FAILED');
    expect(c.stdout.text).toContain('simulated runner failure');
  });

  it('exits 2 when outputs drift across replays', async () => {
    const workflow = writeWorkflow(dir);
    const c = ctx();
    const code = await run(['verify', workflow, '--backend', backendDrift, '--runs', '2'], c);

    expect(code).toBe(2);
    expect(c.stdout.text).toContain('drift detected');
  });

  it('accepts the short -b alias for --backend', async () => {
    const workflow = writeWorkflow(dir);
    const c = ctx();
    const code = await run(['verify', workflow, '-b', backendSuccess, '-n', '1'], c);
    expect(code).toBe(0);
  });
});

describe('runVerifyCommand (library form)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sfysh-cli-verify-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the rendered output and the raw report', async () => {
    const workflow = writeWorkflow(dir);
    const result = await runVerifyCommand({
      file: workflow,
      backend: backendSuccess,
      runs: 1,
      format: 'json',
    });

    expect(result.report.workflowId).toBe('wf_test');
    expect(result.report.runs).toBe(1);
    expect(JSON.parse(result.output).workflowId).toBe('wf_test');
    expect(reportIsGreen(result.report)).toBe(true);
  });

  it('throws VerifyLoadError for malformed workflows', async () => {
    const path = join(dir, 'invalid.json');
    writeFileSync(path, JSON.stringify({ id: 'bad' }), 'utf8');
    await expect(
      runVerifyCommand({ file: path, backend: backendSuccess, runs: 1 }),
    ).rejects.toBeInstanceOf(VerifyLoadError);
  });

  it('throws VerifyLoadError when the backend module cannot be imported', async () => {
    const workflow = writeWorkflow(dir);
    await expect(
      runVerifyCommand({
        file: workflow,
        backend: join(dir, 'missing-backend.mjs'),
        runs: 1,
      }),
    ).rejects.toBeInstanceOf(VerifyLoadError);
  });
});

describe('compile verify (--record and --cassette)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sfysh-cli-verify-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a cassette from a live run and writes it to --record', async () => {
    const workflow = writeWorkflow(dir);
    const cassettePath = join(dir, 'recorded.cassette.json');
    const c = ctx();
    const code = await run(
      ['verify', workflow, '--backend', backendRecording, '--runs', '1', '--record', cassettePath],
      c,
    );

    expect(code).toBe(0);
    expect(existsSync(cassettePath)).toBe(true);
    expect(c.stderr.text).toContain(`Recorded cassette: ${cassettePath}`);

    const cassette = JSON.parse(readFileSync(cassettePath, 'utf8'));
    expect(cassette.version).toBe(1);
    expect(cassette.workflowId).toBe('wf_test');
    expect(cassette.queries).toHaveProperty('url');
    expect(cassette.queries).toHaveProperty('locator("#submit").isVisible');
    expect(cassette.queries).toHaveProperty('getByText("Submitted").count');
    expect(cassette.effects.map((e: { call: string }) => e.call)).toContain(
      'locator("#submit").click',
    );
  });

  it('replays against a recorded cassette with --cassette and reaches green', async () => {
    const workflow = writeWorkflow(dir);
    const cassettePath = join(dir, 'recorded.cassette.json');

    const recorded = await runVerifyCommand({
      file: workflow,
      backend: backendRecording,
      runs: 1,
      record: cassettePath,
    });
    expect(recorded.recordedTo).toBe(cassettePath);

    const c = ctx();
    const code = await run(
      [
        'verify',
        workflow,
        '--backend',
        backendRecording,
        '--runs',
        '2',
        '--cassette',
        cassettePath,
      ],
      c,
    );

    expect(code).toBe(0);
    expect(c.stdout.text).toContain('Passed: 2');
    expect(c.stdout.text).toContain('Stability: stable');
  });

  it('rejects --record and --cassette together at the CLI layer', async () => {
    const workflow = writeWorkflow(dir);
    const cassettePath = join(dir, 'c.json');
    const outCassette = join(dir, 'out.json');
    const c = ctx();
    const code = await run(
      [
        'verify',
        workflow,
        '--backend',
        backendSuccess,
        '--record',
        outCassette,
        '--cassette',
        cassettePath,
      ],
      c,
    );
    expect(code).toBe(1);
    expect(c.stderr.text).toContain('mutually exclusive');
  });

  it('rejects --record and --cassette together at the library layer', async () => {
    const workflow = writeWorkflow(dir);
    await expect(
      runVerifyCommand({
        file: workflow,
        backend: backendSuccess,
        runs: 1,
        record: join(dir, 'out.json'),
        cassette: join(dir, 'in.json'),
      }),
    ).rejects.toBeInstanceOf(VerifyLoadError);
  });

  it('reports a clear error when the cassette file does not exist', async () => {
    const workflow = writeWorkflow(dir);
    const c = ctx();
    const code = await run(
      ['verify', workflow, '--backend', backendSuccess, '--cassette', join(dir, 'nope.json')],
      c,
    );
    expect(code).toBe(1);
    expect(c.stderr.text).toContain('cassette file not found');
  });

  it('reports a clear error when the cassette file is invalid', async () => {
    const workflow = writeWorkflow(dir);
    const bad = join(dir, 'bad.cassette.json');
    writeFileSync(bad, '{ not: json', 'utf8');
    const c = ctx();
    const code = await run(['verify', workflow, '--backend', backendSuccess, '--cassette', bad], c);
    expect(code).toBe(1);
    expect(c.stderr.text).toContain('is invalid');
  });

  it('--cassette replay does not call the backend pageFactory', async () => {
    const workflow = writeWorkflow(dir);
    const cassettePath = join(dir, 'recorded.cassette.json');

    // First record a cassette from the recording backend (which has a
    // real pageFactory).
    await runVerifyCommand({
      file: workflow,
      backend: backendRecording,
      runs: 1,
      record: cassettePath,
    });

    // Build a sentinel backend whose pageFactory throws if called. If the
    // CLI touches it during --cassette mode, the test fails.
    const sentinel = join(dir, 'backend-sentinel.mjs');
    writeFileSync(
      sentinel,
      `
      export const pageFactory = () => {
        throw new Error('pageFactory should not be invoked in cassette mode');
      };
      export const runner = async (ctx) => {
        const { page } = ctx;
        page.url();
        await page.locator('#submit').isVisible();
        await page.getByText('Submitted').count();
        await page.locator('#submit').click();
      };
      `,
      'utf8',
    );

    const result = await runVerifyCommand({
      file: workflow,
      backend: sentinel,
      runs: 1,
      cassette: cassettePath,
    });
    expect(reportIsGreen(result.report)).toBe(true);
  });
});
