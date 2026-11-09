// CLI dispatch and command implementations. Pure functions: argv in, exit
// code out, with stdout and stderr passed as parameters. This keeps the
// surface testable without spawning subprocesses. The bin entry (bin.ts) is a
// thin shim that wires process.argv, process.stdout, and process.stderr in.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { parse, ParseError } from '@sfysh/parser';
import {
  runVerifyCommand,
  reportIsGreen,
  VerifyLoadError,
  type VerifyCommandOptions,
} from './verify.js';

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

/**
 * Pure form of the parse command. Reads the given file, parses it into IR,
 * and returns the formatted JSON. If `out` is supplied, writes the JSON to
 * disk and returns an empty string. Throws ParseError on parse failure and
 * standard Node errors on file IO failure.
 */
export function runParseCommand(opts: ParseCommandOptions): string {
  const source = readFileSync(opts.file, 'utf8');
  const workflow = parse(source);
  const json = JSON.stringify(workflow, null, 2);

  if (opts.out) {
    writeFileSync(opts.out, json + '\n', 'utf8');
    return '';
  }

  return json;
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
    const output = runParseCommand({ file, out });
    if (out) {
      ctx.stderr.write(`Wrote ${out}\n`);
    } else {
      ctx.stdout.write(output + '\n');
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

  const file = positionals[0]!;
  const out = typeof parsed.values.out === 'string' ? parsed.values.out : undefined;
  const format = parsed.values.json ? 'json' : 'human';

  const opts: VerifyCommandOptions = {
    file,
    backend: backendOpt,
    format,
    ...(runs !== undefined ? { runs } : {}),
    ...(out ? { out } : {}),
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

  return reportIsGreen(result.report) ? 0 : 2;
}

function topLevelHelp(): string {
  return `compile <command> [options]

Commands:
  parse <file>     Parse a Playwright TypeScript file into Starfysh IR JSON.
  verify <file>    Replay an IR workflow against a Page backend and report.

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
  -h, --help             Show this message.

Exit codes:
  0   all replays passed and outputs were stable
  1   usage, IO, or workflow-validation error
  2   one or more replays failed or outputs drifted across runs
`;
}
