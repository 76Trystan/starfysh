// CLI dispatch and command implementations. Pure functions: argv in, exit
// code out, with stdout and stderr passed as parameters. This keeps the
// surface testable without spawning subprocesses. The bin entry (bin.ts) is a
// thin shim that wires process.argv, process.stdout, and process.stderr in.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { parse, ParseError } from '@sfysh/parser';

export interface WritableStream {
  write(chunk: string): boolean;
}

export interface RunContext {
  stdout: WritableStream;
  stderr: WritableStream;
}

export function run(argv: string[], ctx: RunContext): number {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    ctx.stdout.write(topLevelHelp());
    return 0;
  }

  const [command, ...rest] = argv;

  switch (command) {
    case 'parse':
      return parseCommand(rest, ctx);
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

function topLevelHelp(): string {
  return `compile <command> [options]

Commands:
  parse <file>     Parse a Playwright TypeScript file into Starfysh IR JSON.

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
