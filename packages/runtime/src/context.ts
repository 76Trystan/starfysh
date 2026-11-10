// Per-run workflow container. Introduced by ADR 0010.
//
// Every workflow function receives one WorkflowContext per run. The context
// carries the browser page, a vault resolver bound to this run, and an
// output sink bound to this run's buffer. No module-level singletons are
// involved.
//
// Phase 2 adds `http: HttpClient` as a sibling field. The ADR 0013 secret
// scrubber will attach a per-run list of resolved secrets here.

import type { Locator, Page } from './types.js';
import type { VaultResolver } from './vault.js';
import { EnvVaultResolver, VaultSecretMissingError } from './vault.js';
import { extractTable, type ColumnSchema, type TableRow } from './emit.js';

/**
 * The per-run container passed to every workflow function. Generated code
 * destructures `page`, `vault`, and `emit` from this object at the top of
 * the function body.
 */
export interface WorkflowContext {
  /** The browser page the workflow drives. */
  page: Page;
  /**
   * Resolve a vault secret by name. Throws `VaultSecretMissingError` when
   * the secret is missing or empty. The resolver is bound to this run only.
   */
  vault: (name: string) => string;
  /** Typed extraction and output sink, bound to this run's output buffer. */
  emit: EmitSink;
  /**
   * Flush this run's outputs. Writes to `process.env.COMPILE_OUTPUT_FILE`
   * if set, otherwise to stdout as a single JSON line. Called by generated
   * code at the end of a workflow that declared outputs.
   */
  flushOutputs: () => Promise<void>;
  /**
   * Return and clear this run's outputs. Used by the verifier to collect
   * outputs between replays. Tests use it to inspect outputs without
   * touching stdout.
   */
  drainOutputs: () => unknown[];
}

/**
 * The emit sink exposed on WorkflowContext. `table` extracts rows from a
 * table locator; `output` pushes a value into the run's output buffer.
 */
export interface EmitSink {
  table<S extends ColumnSchema>(locator: Locator, schema: S): Promise<TableRow<S>[]>;
  output<T>(value: T): void;
}

export interface WorkflowContextInit {
  page: Page;
  /**
   * Resolver used by `ctx.vault(name)`. Defaults to `EnvVaultResolver` which
   * reads `process.env[NAME.toUpperCase()]`.
   */
  vaultResolver?: VaultResolver;
}

/**
 * Build a fresh WorkflowContext bound to a Page and (optionally) a specific
 * VaultResolver. Every caller that runs a workflow constructs one of these
 * per run: the verifier's replay loop, the Playwright adapter's
 * `wrapWorkflowForTest`, and any production scheduler.
 */
export function createWorkflowContext(init: WorkflowContextInit): WorkflowContext {
  const resolver = init.vaultResolver ?? new EnvVaultResolver();
  const outputs: unknown[] = [];

  const vault = (name: string): string => {
    const value = resolver.resolve(name);
    if (value === undefined || value === '') {
      throw new VaultSecretMissingError(name);
    }
    return value;
  };

  const emit: EmitSink = {
    table: (locator, schema) => extractTable(locator, schema),
    output: (value) => {
      outputs.push(value);
    },
  };

  const flushOutputs = async (): Promise<void> => {
    if (outputs.length === 0) return;
    const serialised = JSON.stringify(outputs.length === 1 ? outputs[0] : outputs);
    const outFile = process.env['COMPILE_OUTPUT_FILE'];
    if (outFile) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(outFile, serialised, 'utf-8');
    } else {
      process.stdout.write(serialised + '\n');
    }
    outputs.length = 0;
  };

  const drainOutputs = (): unknown[] => {
    const copy = outputs.slice();
    outputs.length = 0;
    return copy;
  };

  return {
    page: init.page,
    vault,
    emit,
    flushOutputs,
    drainOutputs,
  };
}
