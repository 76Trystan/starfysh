// AST walker over Playwright TypeScript source. Produces a structural
// description of every top-level `test()` call and the method chains inside
// it, in source order. This layer is deliberately syntax-only: it does not
// know what `getByRole` means, nor which methods are actions versus
// assertions. Interpreting the chains into IR actions, selector candidates,
// and pre/post conditions is the next layer's job.

import { Project, SyntaxKind, ScriptTarget, type Node, type CallExpression } from 'ts-morph';

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
 */
export interface CallChain {
  root: string;
  links: ChainLink[];
  position: SourcePos;
}

/** One `test('name', async ({ page }) => { ... })` call found at file scope. */
export interface WalkedTest {
  name: string;
  calls: CallChain[];
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

  const calls: CallChain[] = [];
  for (const stmt of block.getStatements()) {
    const chain = extractChain(stmt);
    if (chain) calls.push(chain);
  }

  return { name, calls, position: positionOf(call) };
}

function extractChain(statement: Node): CallChain | undefined {
  const exprStmt = statement.asKind(SyntaxKind.ExpressionStatement);
  if (!exprStmt) return undefined;

  let expr: Node = exprStmt.getExpression();
  const awaitExpr = expr.asKind(SyntaxKind.AwaitExpression);
  if (awaitExpr) expr = awaitExpr.getExpression();

  const call = expr.asKind(SyntaxKind.CallExpression);
  if (!call) return undefined;

  const built = buildChain(call);
  if (!built) return undefined;
  return { ...built, position: positionOf(statement) };
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
