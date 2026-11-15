// AST walker over Playwright TypeScript source. Produces a structural
// description of every top-level `test()` call and the method chains inside
// it, in source order. This layer is deliberately syntax-only: it does not
// know what `getByRole` means, nor which methods are actions versus
// assertions. Interpreting the chains into IR actions, selector candidates,
// and pre/post conditions is the next layer's job.

import {
  Project,
  SyntaxKind,
  ScriptTarget,
  type Node,
  type CallExpression,
  type ForOfStatement as ForOfStatementNode,
} from 'ts-morph';

/** 1-based line and column in the source file. */
export interface SourcePos {
  line: number;
  column: number;
}

/** One method invocation in a chain. `args` are raw TypeScript source strings. */
export interface ChainLink {
  method: string;
  args: string[];
}

/**
 * A chain of method calls starting from a root identifier.
 *
 * `page.getByRole('button', { name: 'Submit' }).click()` becomes:
 * ```
 * {
 *   root: 'page',
 *   links: [
 *     { method: 'getByRole', args: ["'button'", "{ name: 'Submit' }"] },
 *     { method: 'click', args: [] },
 *   ],
 * }
 * ```
 *
 * `text` is the raw TypeScript source of the call expression with any
 * surrounding `await` stripped, so downstream layers can quote user source
 * when reporting unsupported methods.
 *
 * `bind` is the variable name when the chain is the initializer of a
 * `const`/`let`/`var` declaration (e.g. `const name = await locator.textContent()`).
 * Downstream code uses this for extract-step binding; absent for bare
 * expression statements.
 */
export interface CallChain {
  root: string;
  links: ChainLink[];
  position: SourcePos;
  text: string;
  bind?: string;
}

/**
 * A `for (const x of await chain.all()) { ... }` loop found in a test body.
 * The iterable is the chain up to (but not including) the trailing `.all()`.
 */
export interface ForOfLoop {
  kind: 'for-of';
  iterable: { root: string; links: ChainLink[] };
  variable: string;
  body: CallChain[];
  position: SourcePos;
}

/** Discriminated union of items the walker extracts from a test body. */
export type WalkerItem = CallChain | ForOfLoop;

/** One `test('name', async ({ page }) => { ... })` call found at file scope. */
export interface WalkedTest {
  name: string;
  calls: WalkerItem[];
  position: SourcePos;
}

/**
 * Parse a Playwright TypeScript source string and return every top-level
 * `test(...)` call, each with the ordered sequence of method chains in its
 * body.
 *
 * Current scope: only bare `test('name', async ({page}) => {...})` calls at
 * file scope. Modifiers (`test.skip`, `test.only`), test groups
 * (`test.describe`), options objects, and control flow inside bodies are
 * handled in later ToDo items.
 */
export function walkFile(source: string, filename = 'input.ts'): WalkedTest[] {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { target: ScriptTarget.ESNext, allowJs: false },
  });
  const sourceFile = project.createSourceFile(filename, source, { overwrite: true });

  const tests: WalkedTest[] = [];
  for (const statement of sourceFile.getStatements()) {
    const call = topLevelCall(statement);
    if (!call) continue;
    const walked = tryWalkTestCall(call);
    if (walked) tests.push(walked);
  }
  return tests;
}

function topLevelCall(statement: Node): CallExpression | undefined {
  const exprStmt = statement.asKind(SyntaxKind.ExpressionStatement);
  if (!exprStmt) return undefined;
  return exprStmt.getExpression().asKind(SyntaxKind.CallExpression);
}

function tryWalkTestCall(call: CallExpression): WalkedTest | undefined {
  const callee = call.getExpression().asKind(SyntaxKind.Identifier);
  if (!callee || callee.getText() !== 'test') return undefined;

  const args = call.getArguments();
  if (args.length < 2) return undefined;

  const nameLit = args[0]?.asKind(SyntaxKind.StringLiteral);
  if (!nameLit) return undefined;
  const name = nameLit.getLiteralText();

  const bodyArg = args[args.length - 1];
  const body =
    bodyArg?.asKind(SyntaxKind.ArrowFunction) ?? bodyArg?.asKind(SyntaxKind.FunctionExpression);
  if (!body) return undefined;

  const block = body.getBody().asKind(SyntaxKind.Block);
  if (!block) return undefined;

  const calls: WalkerItem[] = [];
  for (const stmt of block.getStatements()) {
    const item = extractItem(stmt);
    if (item) calls.push(item);
  }

  return { name, calls, position: positionOf(call) };
}

function extractItem(statement: Node): WalkerItem | undefined {
  return (
    extractFromExpressionStatement(statement) ??
    extractFromVariableStatement(statement) ??
    extractFromForOfStatement(statement)
  );
}

function extractFromExpressionStatement(statement: Node): CallChain | undefined {
  const exprStmt = statement.asKind(SyntaxKind.ExpressionStatement);
  if (!exprStmt) return undefined;

  let expr: Node = exprStmt.getExpression();
  const awaitExpr = expr.asKind(SyntaxKind.AwaitExpression);
  if (awaitExpr) expr = awaitExpr.getExpression();

  const call = expr.asKind(SyntaxKind.CallExpression);
  if (!call) return undefined;

  const built = buildChain(call);
  if (!built) return undefined;
  return { ...built, position: positionOf(statement), text: expr.getText() };
}

// Picks up `const name = await locator.textContent()` so the resulting
// CallChain carries the identifier as `bind`. Only single-declaration,
// non-destructuring patterns are supported in v1; `const { a, b } = ...`
// and `const [x] = ...` return undefined and fall through to the dropped
// path like any other unrecognised statement.
function extractFromVariableStatement(statement: Node): CallChain | undefined {
  const varStmt = statement.asKind(SyntaxKind.VariableStatement);
  if (!varStmt) return undefined;

  const decls = varStmt.getDeclarationList().getDeclarations();
  if (decls.length !== 1) return undefined;
  const decl = decls[0]!;

  const ident = decl.getNameNode().asKind(SyntaxKind.Identifier);
  if (!ident) return undefined;

  let init: Node | undefined = decl.getInitializer();
  if (!init) return undefined;

  const awaitExpr = init.asKind(SyntaxKind.AwaitExpression);
  if (awaitExpr) init = awaitExpr.getExpression();

  const call = init.asKind(SyntaxKind.CallExpression);
  if (!call) return undefined;

  const built = buildChain(call);
  if (!built) return undefined;

  return {
    ...built,
    position: positionOf(statement),
    text: init.getText(),
    bind: ident.getText(),
  };
}

// Picks up `for (const row of await page.locator('tr').all()) { ... }`.
// The iterable is the chain up to (but not including) the trailing `.all()`.
// Body statements are walked recursively for CallChains.
function extractFromForOfStatement(statement: Node): ForOfLoop | undefined {
  const forOf = statement.asKind(SyntaxKind.ForOfStatement) as ForOfStatementNode | undefined;
  if (!forOf) return undefined;

  const initializer = forOf.getInitializer();
  const varDeclList = initializer.asKind(SyntaxKind.VariableDeclarationList);
  if (!varDeclList) return undefined;
  const decls = varDeclList.getDeclarations();
  if (decls.length !== 1) return undefined;
  const loopVar = decls[0]!.getNameNode().asKind(SyntaxKind.Identifier);
  if (!loopVar) return undefined;

  let expr: Node = forOf.getExpression();
  const awaitExpr = expr.asKind(SyntaxKind.AwaitExpression);
  if (awaitExpr) expr = awaitExpr.getExpression();

  const allCall = expr.asKind(SyntaxKind.CallExpression);
  if (!allCall) return undefined;
  const allAccess = allCall.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
  if (!allAccess || allAccess.getName() !== 'all') return undefined;

  const innerCall = allAccess.getExpression().asKind(SyntaxKind.CallExpression);
  if (!innerCall) return undefined;
  const iterable = buildChain(innerCall);
  if (!iterable) return undefined;

  const body: CallChain[] = [];
  const block = forOf.getStatement().asKind(SyntaxKind.Block);
  if (block) {
    for (const stmt of block.getStatements()) {
      const chain = extractFromExpressionStatement(stmt) ?? extractFromVariableStatement(stmt);
      if (chain) body.push(chain);
    }
  }

  return {
    kind: 'for-of',
    iterable,
    variable: loopVar.getText(),
    body,
    position: positionOf(statement),
  };
}

function buildChain(call: CallExpression): { root: string; links: ChainLink[] } | undefined {
  const links: ChainLink[] = [];
  let current: Node = call;

  while (true) {
    const c = current.asKind(SyntaxKind.CallExpression);
    if (!c) break;
    const callee = c.getExpression();
    const args = c.getArguments().map((a) => a.getText());

    const propAccess = callee.asKind(SyntaxKind.PropertyAccessExpression);
    if (propAccess) {
      links.unshift({ method: propAccess.getName(), args });
      current = propAccess.getExpression();
      continue;
    }

    const ident = callee.asKind(SyntaxKind.Identifier);
    if (ident) {
      // Top of the chain is a bare function call like `expect(...)`.
      // Model it as a link whose `object` happens to equal the root.
      return { root: ident.getText(), links: [{ method: ident.getText(), args }, ...links] };
    }

    return undefined;
  }

  const rootIdent = current.asKind(SyntaxKind.Identifier);
  if (!rootIdent) return undefined;
  return { root: rootIdent.getText(), links };
}

function positionOf(node: Node): SourcePos {
  const sourceFile = node.getSourceFile();
  const { line, column } = sourceFile.getLineAndColumnAtPos(node.getStart());
  return { line, column };
}
