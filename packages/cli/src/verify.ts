// `compile verify` command. Loads an IR workflow from disk, pulls a Page
// backend from a user-supplied module, runs the verifier, and prints either
// a human-readable report or a stable JSON report.
//
// The CLI stays browser-agnostic: it never imports Playwright or any other
// backend directly. The caller supplies a backend module whose exports
// follow the contract documented in BackendModule below. This lets the
// same command verify Playwright-driven workflows today and any other
// backend Starfysh grows later without churning the CLI itself.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { validateWorkflow } from '@sfysh/ir';
import type { Workflow } from '@sfysh/ir';
import {
  replay,
  humanReport,
  jsonReport,
  type PageDisposer,
  type PageFactory,
  type RunnerFn,
  type ToleranceMap,
  type VerifyReport,
} from '@sfysh/verifier';

/**
 * Shape a `--backend` module must expose. `pageFactory` and `runner` are
 * mandatory; `dispose` and `tolerance` are optional. Any other exports are
 * ignored. Keeping this a loose named-exports contract (rather than a
 * default export) makes backends trivial to write as plain `.mjs` files.
 */
export interface BackendModule {
  pageFactory: PageFactory;
  runner: RunnerFn;
  dispose?: PageDisposer;
  tolerance?: ToleranceMap;
}

export interface VerifyCommandOptions {
  file: string;
  backend: string;
  runs?: number;
  tolerance?: ToleranceMap;
  format?: 'human' | 'json';
  out?: string;
}

export interface VerifyCommandResult {
  /** Rendered report, in the requested format. */
  output: string;
  /** Raw report object for callers that want structured access. */
  report: VerifyReport;
}

export class VerifyLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyLoadError';
  }
}

/**
 * Pure form of the verify command. Reads a workflow file + backend module,
 * runs the verifier, and returns the rendered report. Throws VerifyLoadError
 * for user-facing load / validation problems and standard Node errors for
 * file IO problems. Any backend-runtime exception bubbles up unchanged.
 */
export async function runVerifyCommand(opts: VerifyCommandOptions): Promise<VerifyCommandResult> {
  const workflow = loadWorkflow(opts.file);
  const backend = await loadBackend(opts.backend);
  const tolerance = opts.tolerance ?? backend.tolerance;

  const report = await replay(workflow, {
    pageFactory: backend.pageFactory,
    runner: backend.runner,
    ...(backend.dispose ? { dispose: backend.dispose } : {}),
    ...(opts.runs !== undefined ? { runs: opts.runs } : {}),
    ...(tolerance ? { tolerance } : {}),
  });

  const format = opts.format ?? 'human';
  const output = format === 'json' ? jsonReport(report) : humanReport(report);

  if (opts.out) {
    writeFileSync(opts.out, output.endsWith('\n') ? output : output + '\n', 'utf8');
  }

  return { output, report };
}

/**
 * True if the report represents a fully green run: every replay passed and
 * outputs were stable across runs. Callers use this to pick an exit code.
 */
export function reportIsGreen(report: VerifyReport): boolean {
  return report.failed === 0 && report.stability.stable;
}

function loadWorkflow(file: string): Workflow {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      throw new VerifyLoadError(`file not found: ${file}`);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new VerifyLoadError(`workflow file is not valid JSON: ${message}`);
  }

  const result = validateWorkflow(parsed);
  if (!result.valid || !result.value) {
    const first = result.errors[0];
    const detail = first ? `${first.path} ${first.message}` : 'unknown validation error';
    throw new VerifyLoadError(`workflow failed IR validation: ${detail}`);
  }

  return result.value;
}

async function loadBackend(backendPath: string): Promise<BackendModule> {
  const absolute = resolvePath(backendPath);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new VerifyLoadError(`failed to import backend module '${backendPath}': ${message}`);
  }

  if (typeof mod.pageFactory !== 'function') {
    throw new VerifyLoadError(
      `backend module '${backendPath}' must export a 'pageFactory' function`,
    );
  }
  if (typeof mod.runner !== 'function') {
    throw new VerifyLoadError(`backend module '${backendPath}' must export a 'runner' function`);
  }
  if (mod.dispose !== undefined && typeof mod.dispose !== 'function') {
    throw new VerifyLoadError(
      `backend module '${backendPath}' exported a 'dispose' that is not a function`,
    );
  }
  if (
    mod.tolerance !== undefined &&
    (typeof mod.tolerance !== 'object' || mod.tolerance === null)
  ) {
    throw new VerifyLoadError(
      `backend module '${backendPath}' exported a 'tolerance' that is not an object`,
    );
  }

  return {
    pageFactory: mod.pageFactory as PageFactory,
    runner: mod.runner as RunnerFn,
    ...(mod.dispose ? { dispose: mod.dispose as PageDisposer } : {}),
    ...(mod.tolerance ? { tolerance: mod.tolerance as ToleranceMap } : {}),
  };
}
