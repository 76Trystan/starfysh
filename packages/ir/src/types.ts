// Generated from JSON Schema. Do not edit by hand.
// Run `pnpm --filter @asc/ir regen-types` to regenerate.

/**
 * A single step in a workflow. Every step carries an id, a natural-language intent (used by the healer when the step fails), and action-specific fields enforced by the discriminator on the 'action' property.
 */
export type Step = CommonFields &
  (Navigate | Click | Fill | Extract | Wait | Assert | Guard | Loop);
/**
 * Repeated execution. Exactly one of foreach or while must be provided. 'foreach' iterates over elements matching a Target; 'while' repeats until a Condition stops holding. maxIterations is a safety cap.
 */
export type Loop = {
  action: 'loop';
  foreach?: Target;
  /**
   * A boolean assertion about page state. Used in pre, post, assert, guard.if, and loop.while.
   */
  while?:
    | {
        /**
         * Regex or substring the current URL must match.
         */
        urlMatches: string;
      }
    | {
        /**
         * Exact URL the current page must have.
         */
        urlEquals: string;
      }
    | {
        /**
         * CSS selector that must resolve to a visible element.
         */
        selectorVisible: string;
      }
    | {
        /**
         * CSS selector that must not resolve to any element.
         */
        selectorAbsent: string;
      }
    | {
        /**
         * Text that must appear anywhere on the page.
         */
        textPresent: string;
      }
    | {
        /**
         * HTTP response status the most recent navigation or XHR must have returned.
         */
        responseStatus: number;
      };
  /**
   * Hard cap on iterations to prevent runaway loops when a 'while' condition fails to flip.
   */
  maxIterations?: number;
  /**
   * @minItems 1
   */
  do: [Step, ...Step[]];
} & (
  | {
      [k: string]: unknown;
    }
  | {
      [k: string]: unknown;
    }
);

/**
 * A compiled browser-automation workflow in Agent Script Compiler's intermediate representation (IR). This document is the single source of truth. The compiler emits Playwright code from it; the healer patches it; the verifier replays it.
 */
export interface Workflow {
  /**
   * Optional pointer to the JSON Schema that validates this document. Used by editors for IntelliSense; not interpreted by ASC.
   */
  $schema?: string;
  /**
   * Semantic version of the IR schema this workflow conforms to. Breaking changes require a major bump plus a migration.
   */
  irVersion: string;
  /**
   * Stable workflow identifier, lowercase, snake_case or kebab-case. Must be unique within a registry.
   */
  id: string;
  /**
   * Human-readable workflow name.
   */
  name: string;
  /**
   * Prose description of what this workflow does. Surfaced to the healer as context when a step fails.
   */
  description?: string;
  /**
   * Typed inputs the workflow accepts at run time. Keys are parameter names; values are JSON Schema fragments describing allowed types.
   */
  parameters?: {
    [k: string]: {};
  };
  /**
   * Names of secrets the workflow requires. Resolved at run time from the configured vault. Literal secret values must never appear in the IR or generated code.
   */
  secrets?: string[];
  /**
   * JSON Schema describing the shape of the workflow's output. Used by the verifier to check output stability.
   */
  outputs?: {};
  /**
   * Ordered list of steps the workflow executes.
   *
   * @minItems 1
   */
  steps: [Step, ...Step[]];
  /**
   * Free-form metadata (author, tags, created, source trace id, etc.). Not interpreted by the compiler.
   */
  metadata?: {
    [k: string]: unknown;
  };
}
export interface CommonFields {
  /**
   * Step identifier, unique within the workflow. Referenced by the healer and in semantic diffs.
   */
  id?: string;
  /**
   * Natural-language description of what this step achieves. Load-bearing: the healer uses this to re-derive the step when selectors fail.
   */
  intent?: string;
  /**
   * The kind of action this step performs. Discriminator for the oneOf branches.
   */
  action?: 'navigate' | 'click' | 'fill' | 'extract' | 'wait' | 'assert' | 'guard' | 'loop';
  /**
   * Preconditions that must hold before this step runs. Failure here routes to triage, typically classifying as a site change or auth decay.
   */
  pre?: (
    | {
        /**
         * Regex or substring the current URL must match.
         */
        urlMatches: string;
      }
    | {
        /**
         * Exact URL the current page must have.
         */
        urlEquals: string;
      }
    | {
        /**
         * CSS selector that must resolve to a visible element.
         */
        selectorVisible: string;
      }
    | {
        /**
         * CSS selector that must not resolve to any element.
         */
        selectorAbsent: string;
      }
    | {
        /**
         * Text that must appear anywhere on the page.
         */
        textPresent: string;
      }
    | {
        /**
         * HTTP response status the most recent navigation or XHR must have returned.
         */
        responseStatus: number;
      }
  )[];
  /**
   * Postconditions that must hold after this step completes. The product of these across the workflow is what makes healing tractable.
   */
  post?: (
    | {
        /**
         * Regex or substring the current URL must match.
         */
        urlMatches: string;
      }
    | {
        /**
         * Exact URL the current page must have.
         */
        urlEquals: string;
      }
    | {
        /**
         * CSS selector that must resolve to a visible element.
         */
        selectorVisible: string;
      }
    | {
        /**
         * CSS selector that must not resolve to any element.
         */
        selectorAbsent: string;
      }
    | {
        /**
         * Text that must appear anywhere on the page.
         */
        textPresent: string;
      }
    | {
        /**
         * HTTP response status the most recent navigation or XHR must have returned.
         */
        responseStatus: number;
      }
  )[];
  /**
   * What to do when this step fails after triage. 'retry' handles only transient flake; 'escalate_to_healer' is the default for selector/site-change failures.
   */
  onFail?: 'retry' | 'escalate_to_healer' | 'stop' | 'continue';
  /**
   * Maximum time this step is allowed to take before the verifier marks it as 'possibly stuck'.
   */
  timeoutMs?: number;
}
/**
 * Navigate to a URL. Equivalent to page.goto().
 */
export interface Navigate {
  action: 'navigate';
  /**
   * A value supplied to a step. May be a literal string, a reference to a workflow parameter, or a reference to a vault secret. Secrets are never inlined.
   */
  url:
    | string
    | {
        /**
         * Name of a workflow parameter declared in Workflow.parameters.
         */
        param: string;
      }
    | {
        /**
         * Name of a secret declared in Workflow.secrets. Resolved from the vault at run time.
         */
        secret: string;
      };
  /**
   * Load state to wait for after navigation.
   */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}
/**
 * Click an element. Equivalent to locator.click().
 */
export interface Click {
  action: 'click';
  target: Target;
}
/**
 * A ranked list of ways to find the element this step acts on. Candidates are tried in order; order should be role -> testid -> text -> css -> visual.
 */
export interface Target {
  /**
   * @minItems 1
   */
  candidates: [SelectorCandidate, ...SelectorCandidate[]];
}
export interface SelectorCandidate {
  /**
   * Selector strategy. Role-based locators survive redesigns best (they encode meaning, not layout); visual embeddings are the last-resort fallback.
   */
  kind: 'role' | 'testid' | 'text' | 'label' | 'css' | 'visual';
  /**
   * The selector string, in the form expected by the 'kind'. For 'role': 'button[name="Submit"]'. For 'testid': 'submit-button'. For 'visual': an embedding reference such as 'emb_4f2a'.
   */
  value: string;
}
/**
 * Type a value into a form field. Equivalent to locator.fill().
 */
export interface Fill {
  action: 'fill';
  target: Target;
  /**
   * A value supplied to a step. May be a literal string, a reference to a workflow parameter, or a reference to a vault secret. Secrets are never inlined.
   */
  value:
    | string
    | {
        /**
         * Name of a workflow parameter declared in Workflow.parameters.
         */
        param: string;
      }
    | {
        /**
         * Name of a secret declared in Workflow.secrets. Resolved from the vault at run time.
         */
        secret: string;
      };
}
/**
 * Pull structured data out of the page into a typed shape. The schema field is a JSON Schema fragment the extracted value must conform to.
 */
export interface Extract {
  action: 'extract';
  target: Target;
  /**
   * JSON Schema describing the shape of the extracted value. The verifier uses this to check output stability across runs.
   */
  schema: {};
  /**
   * Variable name to bind the extracted value to for use by later steps or as workflow output.
   */
  bind?: string;
}
/**
 * Wait for a condition to become true, or for a fixed duration. Prefer forCondition over millis; fixed waits are brittle.
 */
export interface Wait {
  action: 'wait';
  /**
   * A boolean assertion about page state. Used in pre, post, assert, guard.if, and loop.while.
   */
  forCondition?:
    | {
        /**
         * Regex or substring the current URL must match.
         */
        urlMatches: string;
      }
    | {
        /**
         * Exact URL the current page must have.
         */
        urlEquals: string;
      }
    | {
        /**
         * CSS selector that must resolve to a visible element.
         */
        selectorVisible: string;
      }
    | {
        /**
         * CSS selector that must not resolve to any element.
         */
        selectorAbsent: string;
      }
    | {
        /**
         * Text that must appear anywhere on the page.
         */
        textPresent: string;
      }
    | {
        /**
         * HTTP response status the most recent navigation or XHR must have returned.
         */
        responseStatus: number;
      };
  /**
   * Fixed wait in milliseconds. Avoid when forCondition is possible.
   */
  millis?: number;
}
/**
 * Assert a condition explicitly as a step. Fails the workflow if the condition is false.
 */
export interface Assert {
  action: 'assert';
  /**
   * A boolean assertion about page state. Used in pre, post, assert, guard.if, and loop.while.
   */
  condition:
    | {
        /**
         * Regex or substring the current URL must match.
         */
        urlMatches: string;
      }
    | {
        /**
         * Exact URL the current page must have.
         */
        urlEquals: string;
      }
    | {
        /**
         * CSS selector that must resolve to a visible element.
         */
        selectorVisible: string;
      }
    | {
        /**
         * CSS selector that must not resolve to any element.
         */
        selectorAbsent: string;
      }
    | {
        /**
         * Text that must appear anywhere on the page.
         */
        textPresent: string;
      }
    | {
        /**
         * HTTP response status the most recent navigation or XHR must have returned.
         */
        responseStatus: number;
      };
}
/**
 * Conditional execution. Runs 'then' if 'if' holds, otherwise runs 'else' (if provided). Modelled after the design doc's 'cookie banner may or may not appear' pattern.
 */
export interface Guard {
  action: 'guard';
  /**
   * A boolean assertion about page state. Used in pre, post, assert, guard.if, and loop.while.
   */
  if:
    | {
        /**
         * Regex or substring the current URL must match.
         */
        urlMatches: string;
      }
    | {
        /**
         * Exact URL the current page must have.
         */
        urlEquals: string;
      }
    | {
        /**
         * CSS selector that must resolve to a visible element.
         */
        selectorVisible: string;
      }
    | {
        /**
         * CSS selector that must not resolve to any element.
         */
        selectorAbsent: string;
      }
    | {
        /**
         * Text that must appear anywhere on the page.
         */
        textPresent: string;
      }
    | {
        /**
         * HTTP response status the most recent navigation or XHR must have returned.
         */
        responseStatus: number;
      };
  /**
   * @minItems 1
   */
  then: [Step, ...Step[]];
  else?: Step[];
}
