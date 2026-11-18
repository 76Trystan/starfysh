// CLI dispatch and command implementations. Pure functions: argv in, exit
// code out, with stdout and stderr passed as parameters. This keeps the
// surface testable without spawning subprocesses. The bin entry (bin.ts) is a
// thin shim that wires process.argv, process.stdout, and process.stderr in.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { parse, ParseError, type ParseWarning, type UnsupportedCall } from '@sfysh/parser';
import {
  runVerifyCommand,
  reportIsGreen,
  VerifyLoadError,
  type VerifyCommandOptions,
} from './verify.js';
import {
  HealCommandError,
  PROVIDER_NAMES,
  runApproveCommand,
  runHealCommand,
  runRejectCommand,
  runRevertCommand,
  type HealCommandOptions,
  type ProviderName,
  type ReviewCommandResult,
} from './heal.js';

export interface WritableStream {
  write(chunk: string): boolean;
}

export interface RunContext {
  stdout: WritableStream;
  stderr: WritableStream;
}

export function run(argv: string[], ctx: RunContext): number | Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    ctx.stdout.write(topLevelHelp());
    return 0;
  }

  const [command, ...rest] = argv;

  switch (command) {
    case 'parse':
      return parseCommand(rest, ctx);
    case 'verify':
      return verifyCommand(rest, ctx);
    case 'heal':
      return healCommand(rest, ctx);
    case 'approve':
      return reviewCommand('approve', rest, ctx);
    case 'reject':
      return reviewCommand('reject', rest, ctx);
    case 'revert':
      return reviewCommand('revert', rest, ctx);
    default:
      ctx.stderr.write(`compile: unknown command '${command}'\n\n`);
      ctx.stderr.write(topLevelHelp());
      return 1;
  }
}

export interface ParseCommandOptions {
  file: string;
  out?: string;
}

export interface ParseCommandResult {
  /**
   * Formatted workflow JSON. Empty string when `out` is set, because the JSON
   * was written to disk instead of returned to the caller.
   */
  output: string;
  unsupported: UnsupportedCall[];
  /** Literal values the parser replaced with vault secrets, or kept and flagged. */
  warnings: ParseWarning[];
}

/**
 * Pure form of the parse command. Reads the given file, parses it into IR,
 * and returns the formatted JSON alongside any unsupported Playwright calls
 * the parser could not map to IR steps. If `out` is supplied, writes the
 * JSON to disk and returns an empty `output`. Throws ParseError on parse
 * failure and standard Node errors on file IO failure.
 */
export function runParseCommand(opts: ParseCommandOptions): ParseCommandResult {
  const source = readFileSync(opts.file, 'utf8');
  const { workflow, unsupported, warnings } = parse(source);
  const json = JSON.stringify(workflow, null, 2);

  if (opts.out) {
    writeFileSync(opts.out, json + '\n', 'utf8');
    return { output: '', unsupported, warnings };
  }

  return { output: json, unsupported, warnings };
}

function formatUnsupported(unsupported: UnsupportedCall[]): string {
  const lines: string[] = [];
  lines.push(`Unsupported Playwright calls dropped from workflow (${unsupported.length}):`);
  for (const call of unsupported) {
    lines.push(`  line ${call.position.line}:${call.position.column}  ${call.text}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Render parser warnings for stderr. Each lifted credential gets its own
 * line because the user has to act on it (add the secret to the vault).
 * Ordinary literal fills are summarised in one line to keep the output
 * readable on long scripts.
 */
function formatWarnings(warnings: ParseWarning[]): string {
  const lines: string[] = [];
  const lifted = warnings.filter((w) => w.kind === 'literal-secret');
  if (lifted.length > 0) {
    lines.push(`Literal credentials replaced with vault secrets (${lifted.length}):`);
    for (const w of lifted) {
      lines.push(
        `  line ${w.position.line}:${w.position.column}  ${w.stepId} -> secret '${w.secret}'`,
      );
    }
    lines.push('  Supply these through the vault before running the workflow.');
  }
  const kept = warnings.filter((w) => w.kind === 'literal-fill');
  if (kept.length > 0) {
    const where = kept.map((w) => `${w.position.line}`).join(', ');
    lines.push(
      `Literal fill values copied into the workflow (${kept.length}, line ${where}). Replace any sensitive ones with vault secrets.`,
    );
  }
  return lines.join('\n') + '\n';
}

function parseCommand(args: string[], ctx: RunContext): number {
  const config: ParseArgsConfig = {
    args,
    options: {
      out: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  };

  let parsed;
  try {
    parsed = parseArgs(config);
  } catch (err) {
    ctx.stderr.write(`compile parse: ${(err as Error).message}\n\n`);
    ctx.stderr.write(parseHelp());
    return 1;
  }

  if (parsed.values.help) {
    ctx.stdout.write(parseHelp());
    return 0;
  }

  const positionals = parsed.positionals;
  if (positionals.length === 0) {
    ctx.stderr.write('compile parse: missing <file> argument\n\n');
    ctx.stderr.write(parseHelp());
    return 1;
  }

  if (positionals.length > 1) {
    ctx.stderr.write(`compile parse: unexpected argument '${positionals[1]}'\n\n`);
    ctx.stderr.write(parseHelp());
    return 1;
  }

  const file = positionals[0]!;
  const out = typeof parsed.values.out === 'string' ? parsed.values.out : undefined;

  try {
    const result = runParseCommand({ file, out });
    if (out) {
      ctx.stderr.write(`Wrote ${out}\n`);
    } else {
      ctx.stdout.write(result.output + '\n');
    }
    if (result.unsupported.length > 0) {
      ctx.stderr.write(formatUnsupported(result.unsupported));
    }
    if (result.warnings.length > 0) {
      ctx.stderr.write(formatWarnings(result.warnings));
    }
    return 0;
  } catch (err) {
    if (err instanceof ParseError) {
      ctx.stderr.write(`compile parse: ${err.message}\n`);
      return 1;
    }
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      ctx.stderr.write(`compile parse: file not found: ${file}\n`);
      return 1;
    }
    throw err;
  }
}

async function verifyCommand(args: string[], ctx: RunContext): Promise<number> {
  const config: ParseArgsConfig = {
    args,
    options: {
      backend: { type: 'string', short: 'b' },
      runs: { type: 'string', short: 'n' },
      json: { type: 'boolean' },
      out: { type: 'string', short: 'o' },
      record: { type: 'string' },
      cassette: { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  };

  let parsed;
  try {
    parsed = parseArgs(config);
  } catch (err) {
    ctx.stderr.write(`compile verify: ${(err as Error).message}\n\n`);
    ctx.stderr.write(verifyHelp());
    return 1;
  }

  if (parsed.values.help) {
    ctx.stdout.write(verifyHelp());
    return 0;
  }

  const positionals = parsed.positionals;
  if (positionals.length === 0) {
    ctx.stderr.write('compile verify: missing <file> argument\n\n');
    ctx.stderr.write(verifyHelp());
    return 1;
  }
  if (positionals.length > 1) {
    ctx.stderr.write(`compile verify: unexpected argument '${positionals[1]}'\n\n`);
    ctx.stderr.write(verifyHelp());
    return 1;
  }

  const backendOpt = parsed.values.backend;
  if (typeof backendOpt !== 'string' || backendOpt.length === 0) {
    ctx.stderr.write('compile verify: missing --backend <path>\n\n');
    ctx.stderr.write(verifyHelp());
    return 1;
  }

  let runs: number | undefined;
  if (typeof parsed.values.runs === 'string') {
    const n = Number(parsed.values.runs);
    if (!Number.isInteger(n) || n < 1) {
      ctx.stderr.write(
        `compile verify: --runs must be a positive integer, got '${parsed.values.runs}'\n`,
      );
      return 1;
    }
    runs = n;
  }

  let runTimeoutMs: number | undefined;
  if (typeof parsed.values.timeout === 'string') {
    const n = Number(parsed.values.timeout);
    if (!Number.isInteger(n) || n < 1) {
      ctx.stderr.write(
        `compile verify: --timeout must be a positive number of milliseconds, got '${parsed.values.timeout}'\n`,
      );
      return 1;
    }
    runTimeoutMs = n;
  }

  const file = positionals[0]!;
  const out = typeof parsed.values.out === 'string' ? parsed.values.out : undefined;
  const record = typeof parsed.values.record === 'string' ? parsed.values.record : undefined;
  const cassette = typeof parsed.values.cassette === 'string' ? parsed.values.cassette : undefined;
  const format = parsed.values.json ? 'json' : 'human';

  if (record && cassette) {
    ctx.stderr.write('compile verify: --record and --cassette are mutually exclusive\n');
    return 1;
  }

  const opts: VerifyCommandOptions = {
    file,
    backend: backendOpt,
    format,
    ...(runs !== undefined ? { runs } : {}),
    ...(out ? { out } : {}),
    ...(record ? { record } : {}),
    ...(cassette ? { cassette } : {}),
    ...(runTimeoutMs !== undefined ? { runTimeoutMs } : {}),
  };

  let result;
  try {
    result = await runVerifyCommand(opts);
  } catch (err) {
    if (err instanceof VerifyLoadError) {
      ctx.stderr.write(`compile verify: ${err.message}\n`);
      return 1;
    }
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      ctx.stderr.write(`compile verify: file not found: ${file}\n`);
      return 1;
    }
    throw err;
  }

  if (out) {
    ctx.stderr.write(`Wrote ${out}\n`);
  } else {
    ctx.stdout.write(result.output.endsWith('\n') ? result.output : result.output + '\n');
  }
  if (result.recordedTo) {
    ctx.stderr.write(`Recorded cassette: ${result.recordedTo}\n`);
  }

  return reportIsGreen(result.report) ? 0 : 2;
}

async function healCommand(args: string[], ctx: RunContext): Promise<number> {
  const config: ParseArgsConfig = {
    args,
    options: {
      backend: { type: 'string', short: 'b' },
      provider: { type: 'string', short: 'p' },
      model: { type: 'string', short: 'm' },
      'known-good': { type: 'string' },
      dir: { type: 'string' },
      runs: { type: 'string', short: 'n' },
      timeout: { type: 'string' },
      json: { type: 'boolean' },
      'auto-promote': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  };

  let parsed;
  try {
    parsed = parseArgs(config);
  } catch (err) {
    ctx.stderr.write(`compile heal: ${(err as Error).message}\n\n`);
    ctx.stderr.write(healHelp());
    return 1;
  }
  if (parsed.values.help) {
    ctx.stdout.write(healHelp());
    return 0;
  }

  const usage = (message: string): number => {
    ctx.stderr.write(`compile heal: ${message}\n\n`);
    ctx.stderr.write(healHelp());
    return 1;
  };
  if (parsed.positionals.length === 0) return usage('missing <file> argument');
  if (parsed.positionals.length > 1) {
    return usage(`unexpected argument '${parsed.positionals[1]}'`);
  }
  const backend = parsed.values.backend;
  if (typeof backend !== 'string' || backend.length === 0) {
    return usage('missing --backend <path>');
  }

  const provider = parsed.values.provider;
  if (provider !== undefined && !(PROVIDER_NAMES as readonly unknown[]).includes(provider)) {
    return usage(
      `--provider must be one of ${PROVIDER_NAMES.join(', ')}, got '${String(provider)}'`,
    );
  }
  const model = parsed.values.model;
  if (model !== undefined && provider === undefined) return usage('--model needs --provider');

  let runs: number | undefined;
  if (typeof parsed.values.runs === 'string') {
    const n = Number(parsed.values.runs);
    if (!Number.isInteger(n) || n < 3) {
      return usage(`--runs must be a whole number of at least 3, got '${parsed.values.runs}'`);
    }
    runs = n;
  }
  let runTimeoutMs: number | undefined;
  if (typeof parsed.values.timeout === 'string') {
    const n = Number(parsed.values.timeout);
    if (!Number.isInteger(n) || n < 1) {
      return usage(
        `--timeout must be a positive number of milliseconds, got '${parsed.values.timeout}'`,
      );
    }
    runTimeoutMs = n;
  }

  const knownGood = parsed.values['known-good'];
  const dir = parsed.values.dir;
  const opts: HealCommandOptions = {
    file: parsed.positionals[0]!,
    backend,
    format: parsed.values.json ? 'json' : 'human',
    ...(parsed.values['auto-promote'] ? { autoPromote: true } : {}),
    ...(provider !== undefined ? { provider: provider as ProviderName } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof knownGood === 'string' ? { knownGood } : {}),
    ...(typeof dir === 'string' ? { stateDir: dir } : {}),
    ...(runs !== undefined ? { runs } : {}),
    ...(runTimeoutMs !== undefined ? { runTimeoutMs } : {}),
  };

  let result;
  try {
    result = await runHealCommand(opts);
  } catch (err) {
    if (err instanceof HealCommandError || err instanceof VerifyLoadError) {
      ctx.stderr.write(`compile heal: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  ctx.stdout.write(result.output.endsWith('\n') ? result.output : result.output + '\n');
  return result.exitCode;
}

async function reviewCommand(
  command: 'approve' | 'reject' | 'revert',
  args: string[],
  ctx: RunContext,
): Promise<number> {
  const help = command === 'approve' ? approveHelp : command === 'reject' ? rejectHelp : revertHelp;
  const config: ParseArgsConfig = {
    args,
    options: {
      reviewer: { type: 'string', short: 'r' },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      ...(command === 'approve'
        ? { out: { type: 'string', short: 'o' } }
        : { note: { type: 'string' } }),
    },
    allowPositionals: true,
    strict: true,
  };

  let parsed;
  try {
    parsed = parseArgs(config);
  } catch (err) {
    ctx.stderr.write(`compile ${command}: ${(err as Error).message}\n\n`);
    ctx.stderr.write(help());
    return 1;
  }
  if (parsed.values.help) {
    ctx.stdout.write(help());
    return 0;
  }
  const usage = (message: string): number => {
    ctx.stderr.write(`compile ${command}: ${message}\n\n`);
    ctx.stderr.write(help());
    return 1;
  };
  if (parsed.positionals.length === 0) return usage('missing <heal-id> argument');
  if (parsed.positionals.length > 1) {
    return usage(`unexpected argument '${parsed.positionals[1]}'`);
  }
  const reviewer = parsed.values.reviewer;
  if (typeof reviewer !== 'string' || reviewer.trim() === '') {
    return usage('missing --reviewer <name>');
  }

  const dir = parsed.values.dir;
  const common = {
    healId: parsed.positionals[0]!,
    reviewer,
    ...(typeof dir === 'string' ? { stateDir: dir } : {}),
  };

  let result: ReviewCommandResult;
  try {
    if (command === 'approve') {
      const out = parsed.values.out;
      result = await runApproveCommand({ ...common, ...(typeof out === 'string' ? { out } : {}) });
    } else {
      const note = parsed.values.note;
      const withNote = { ...common, ...(typeof note === 'string' ? { note } : {}) };
      result =
        command === 'reject' ? await runRejectCommand(withNote) : await runRevertCommand(withNote);
    }
  } catch (err) {
    if (err instanceof HealCommandError || err instanceof VerifyLoadError) {
      ctx.stderr.write(`compile ${command}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  ctx.stdout.write(result.output + '\n');
  return 0;
}

function healHelp(): string {
  return `compile heal <file> [options]

Run a Starfysh IR workflow once against a live backend with the IR
interpreter. If it passes, its outputs are saved as the known-good outputs
every later patch is held to. If it fails, triage decides whether the
healer may act; if so, a model proposes a patch to the failed step, the
patched workflow is replayed live and must reproduce the known-good
outputs, and the patch is saved for a person to approve. Nothing a model
wrote is applied without 'compile approve'. Every heal is recorded in
the corpus.

A run that passes only on a fallback selector is degraded. The working
selector is moved to the front of its step (a promotion, no model),
verified the same way, and held for approval; with --auto-promote it is
applied without asking. Undo any applied patch with 'compile revert'.

The backend module must export 'pageFactory'. It may also export
'provider' (used when --provider is not given), 'params', 'dispose',
'vaultResolver' and 'tolerance'. Its 'runner' is not used.

Options:
  -b, --backend <path>      Path to the backend module (required).
  -p, --provider <name>     Model provider: ${PROVIDER_NAMES.join(', ')}.
                            Each reads its API key from its usual
                            environment variable.
  -m, --model <name>        Model for --provider. Default: the provider's own.
      --known-good <path>   JSON outputs to hold patches to, instead of the
                            saved ones (an array, or { "outputs": [...] }).
      --dir <path>          State directory (default .compile).
  -n, --runs <count>        Live runs to verify a patch with (default and
                            minimum 3).
      --timeout <ms>        Fail a run that takes longer than this.
      --json                Emit JSON instead of a human-readable review.
      --auto-promote        Apply a verified promotion of a working fallback
                            selector without asking. Model-written patches
                            still wait. Shows a risk notice the first time.
  -h, --help                Show this message.

Exit codes:
  0   the workflow passed (or passed on a retry), including a degraded pass
      whose promotion was applied or could not be made
  1   usage, IO or validation error, or no known-good outputs yet
  2   the failure was not healed (routed elsewhere, capped, or no patch
      verified)
  3   a verified patch is waiting for approval
`;
}

function approveHelp(): string {
  return `compile approve <heal-id> --reviewer <name> [options]

Approve a patch that 'compile heal' left waiting, and write the patched
workflow over the original file. The patch is checked again against the
workflow file as it is now; if the file changed since the heal, run the
heal again.

Options:
  -r, --reviewer <name>   Who is approving (required). Recorded in the corpus.
  -o, --out <path>        Write the patched workflow here instead.
      --dir <path>        State directory (default .compile).
  -h, --help              Show this message.
`;
}

function rejectHelp(): string {
  return `compile reject <heal-id> --reviewer <name> [options]

Reject a patch that 'compile heal' left waiting. The workflow is not
changed. The rejection is recorded in the corpus.

Options:
  -r, --reviewer <name>   Who is rejecting (required).
      --note <text>       Why, for the record.
      --dir <path>        State directory (default .compile).
  -h, --help              Show this message.
`;
}

function revertHelp(): string {
  return `compile revert <heal-id> --reviewer <name> [options]

Undo a patch that was applied by 'compile approve' or by --auto-promote:
write back the workflow exactly as it was before. Refused if the workflow
file has changed since the patch was applied. Recorded in the corpus.

Options:
  -r, --reviewer <name>   Who is reverting (required).
      --note <text>       Why, for the record.
      --dir <path>        State directory (default .compile).
  -h, --help              Show this message.
`;
}

function topLevelHelp(): string {
  return `compile <command> [options]

Commands:
  parse <file>     Parse a Playwright TypeScript file into Starfysh IR JSON.
  verify <file>    Replay an IR workflow against a Page backend and report.
  heal <file>      Run a workflow; if it fails, propose a patch for review.
  approve <id>     Approve a pending heal and write the patched workflow.
  reject <id>      Reject a pending heal.
  revert <id>      Undo an applied heal.

Options:
  -h, --help       Show this message.

Run 'compile <command> --help' for command-specific options.
`;
}

function parseHelp(): string {
  return `compile parse <file> [options]

Parse a Playwright TypeScript file into Starfysh IR JSON.

Options:
  -o, --out <path>   Write JSON to <path> instead of stdout.
  -h, --help         Show this message.
`;
}

function verifyHelp(): string {
  return `compile verify <file> [options]

Replay a Starfysh IR workflow against a Page backend, evaluate terminal
postconditions, and compare outputs across runs. The backend module is
imported at runtime and must export a 'pageFactory' and 'runner'; it may
also export 'dispose' and a 'tolerance' map.

Options:
  -b, --backend <path>   Path to the backend module (required).
  -n, --runs <count>     Number of replays (default 3).
      --json             Emit a JSON report instead of a human-readable one.
  -o, --out <path>       Write the report to <path> instead of stdout.
      --record <path>    Record a cassette from the last live replay and
                         write it to <path>. Mutually exclusive with
                         --cassette.
      --timeout <ms>     Fail a replay that runs longer than this many
                         milliseconds. No limit by default.
      --cassette <path>  Replay against an existing cassette instead of a
                         live site. The backend's 'runner' is still used;
                         'pageFactory' and 'dispose' are not called.
  -h, --help             Show this message.

Exit codes:
  0   all replays passed and outputs were stable
  1   usage, IO, or workflow-validation error
  2   one or more replays failed or outputs drifted across runs
`;
}
