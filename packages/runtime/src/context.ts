// Per-run workflow container. Introduced by ADR 0010; extended by ADR 0013
// to carry a secret scrubber bound to this run's resolved vault values.
//
// Every workflow function receives one WorkflowContext per run. The context
// carries the browser page, a vault resolver bound to this run, an output
// sink bound to this run's buffer, and a `redact` helper that scrubs
// registered secret values from string output.
//
// Phase 2 adds `http: HttpClient` as a sibling field.

import type { Locator, Page } from './types.js';
import { asSecret, type Secret } from './secret.js';
import type { VaultResolver } from './vault.js';
import { EnvVaultResolver, VaultSecretMissingError } from './vault.js';
import {
  extractTable,
  extractValue,
  extractList,
  type ColumnSchema,
  type TableRow,
} from './emit.js';

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
   * the secret is missing or empty. The resolver is bound to this run
   * only. The returned value is branded `Secret` so callers can be flagged
   * by lint rules if they stringify it directly; the hard redaction
   * guarantee comes from `ctx.redact` on output boundaries.
   */
  vault: (name: string) => Secret;
  /** Typed extraction and output sink, bound to this run's output buffer. */
  emit: EmitSink;
  /**
   * Replace every registered secret value in `input` with
   * `[REDACTED:<name>]`. Each value is matched in its raw form and in its
   * JSON-escaped, percent-encoded, and base64 forms, longest first so that
   * a secret which is a substring of another does not leave fragments.
   * Safe to call with an empty string or with an input that contains no
   * registered values. Introduced by ADR 0013.
   */
  redact: (input: string) => string;
  /**
   * Flush this run's outputs. Writes to `process.env.COMPILE_OUTPUT_FILE`
   * if set, otherwise to stdout as a single JSON line. Called by generated
   * code at the end of a workflow that declared outputs. Strings inside
   * the outputs are passed through `redact` first.
   */
  flushOutputs: () => Promise<void>;
  /**
   * Return and clear this run's outputs. Used by the verifier to collect
   * outputs between replays. Tests use it to inspect outputs without
   * touching stdout. Strings inside the outputs are passed through
   * `redact` first, so a page that echoes a credential cannot carry it
   * into a report.
   */
  drainOutputs: () => unknown[];
}

/**
 * The emit sink exposed on WorkflowContext. `table` extracts rows from a
 * table locator; `output` pushes a value into the run's output buffer.
 */
export interface EmitSink {
  table<S extends ColumnSchema>(locator: Locator, schema: S): Promise<TableRow<S>[]>;
  value(locator: Locator): Promise<string | null>;
  list(locator: Locator): Promise<string[]>;
  output<T>(value: T): void;
}

/**
 * Secrets shorter than this are resolved but not registered with the
 * scrubber. See the warning in `vault` for the reasoning.
 */
export const MIN_REDACTABLE_SECRET_LENGTH = 4;

/**
 * Build the scrubber's search list. A secret rarely leaves the process in
 * its raw form only: a cassette stores call arguments as JSON, a URL
 * percent-encodes its query string, and an auth header may base64 it. Each
 * registered value is therefore searched for in every form it is likely to
 * take, longest first so a value that contains another does not fragment.
 *
 * Known limit: a secret that is base64-encoded as part of a larger string
 * (for example `user:password` in a Basic auth header) is not matched,
 * because the encoded bytes depend on what surrounds it.
 */
function buildNeedles(secrets: Map<string, string>): Array<{ needle: string; name: string }> {
  const out: Array<{ needle: string; name: string }> = [];
  const seen = new Set<string>();
  for (const [name, value] of secrets) {
    for (const needle of encodedForms(value)) {
      if (needle.length < MIN_REDACTABLE_SECRET_LENGTH || seen.has(needle)) continue;
      seen.add(needle);
      out.push({ needle, name });
    }
  }
  return out.sort((a, b) => b.needle.length - a.needle.length);
}

function encodedForms(value: string): string[] {
  const forms = [value, JSON.stringify(value).slice(1, -1)];
  try {
    const component = encodeURIComponent(value);
    forms.push(component, component.replace(/%20/g, '+'), encodeURI(value));
  } catch {
    // A lone surrogate cannot be percent-encoded. Nothing to add.
  }
  const base64 = Buffer.from(value, 'utf8').toString('base64');
  forms.push(base64, base64.replace(/=+$/, ''));
  const base64url = Buffer.from(value, 'utf8').toString('base64url');
  forms.push(base64url);
  return forms;
}

/**
 * Return a copy of `value` with `fn` applied to every string inside it.
 * Walks arrays and plain objects; anything else (numbers, dates, class
 * instances) is returned as is.
 */
function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (typeof value === 'object' && value !== null) {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, {
        value: mapStrings(v, fn),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

export interface WorkflowContextInit {
  page: Page;
  /**
   * Resolver used by `ctx.vault(name)`. Defaults to `EnvVaultResolver`, which
   * reads the environment variable `SFYSH_SECRET_` plus the upper-cased name.
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
  const secrets = new Map<string, string>();

  // Search strings for the scrubber, longest first. Rebuilt lazily after a
  // new secret is registered.
  let needles: Array<{ needle: string; name: string }> | null = null;
  const warnedShort = new Set<string>();

  const vault = (name: string): Secret => {
    const value = resolver.resolve(name);
    if (value === undefined || value === '') {
      throw new VaultSecretMissingError(name);
    }
    if (value.length < MIN_REDACTABLE_SECRET_LENGTH) {
      // Replacing a one or two character value would rewrite unrelated text
      // and reveal where those characters occur. The secret still resolves;
      // it is just not scrubbed, and the operator is told once per name.
      if (!warnedShort.has(name)) {
        warnedShort.add(name);
        process.emitWarning(
          `Vault secret '${name}' is shorter than ${MIN_REDACTABLE_SECRET_LENGTH} characters and will not be redacted from errors, outputs, or cassettes.`,
          { code: 'SFYSH_SHORT_SECRET' },
        );
      }
    } else if (secrets.get(name) !== value) {
      secrets.set(name, value);
      needles = null;
    }
    return asSecret(value);
  };

  const redact = (input: string): string => {
    if (input.length === 0 || secrets.size === 0) return input;
    needles ??= buildNeedles(secrets);
    let result = input;
    for (const { needle, name } of needles) {
      if (result.includes(needle)) {
        result = result.split(needle).join(`[REDACTED:${name}]`);
      }
    }
    return result;
  };

  const redactOutput = (value: unknown): unknown => {
    if (secrets.size === 0) return value;
    return mapStrings(value, redact);
  };

  const emit: EmitSink = {
    table: (locator, schema) => extractTable(locator, schema),
    value: (locator) => extractValue(locator),
    list: (locator) => extractList(locator),
    output: (value) => {
      outputs.push(value);
    },
  };

  const flushOutputs = async (): Promise<void> => {
    if (outputs.length === 0) return;
    const safe = outputs.map(redactOutput);
    const serialised = JSON.stringify(safe.length === 1 ? safe[0] : safe);
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
    const copy = outputs.map(redactOutput);
    outputs.length = 0;
    return copy;
  };

  return {
    page: init.page,
    vault,
    emit,
    redact,
    flushOutputs,
    drainOutputs,
  };
}
