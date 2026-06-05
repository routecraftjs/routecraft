import type { AstPath, Doc, Parser, Plugin, Printer } from "prettier";
import { printers as estreePrinters } from "prettier/plugins/estree";
import { parsers as typescriptParsers } from "prettier/plugins/typescript";
import { parsers as babelParsers } from "prettier/plugins/babel";

/**
 * Name of the AST format this plugin registers. The wrapped parsers point
 * their `astFormat` here so Prettier dispatches every node to our printer,
 * which delegates back to the built-in estree printer for everything that is
 * not a Routecraft DSL closure.
 */
const AST_FORMAT = "routecraft-estree";

/**
 * Minimal structural view of the estree-like nodes this plugin inspects.
 * Prettier does not export estree node types, so we model only the fields we
 * read while walking fluent chains. Optional fields cover the variations the
 * TypeScript and Babel parsers can emit (optional chaining, non-null
 * assertions, type annotations).
 */
interface DslNode {
  type: string;
  name?: string;
  async?: boolean;
  object?: DslNode;
  callee?: DslNode;
  expression?: DslNode;
  body?: DslNode;
  params?: DslNode[];
  typeAnnotation?: unknown;
  returnType?: unknown;
  typeParameters?: unknown;
}

/**
 * Walk to the head of a fluent member/call chain and return its identifier
 * name, or `null` when the chain does not bottom out at a bare identifier
 * (for example `direct(...).send(...)`, whose head is a call, not a name).
 */
function chainHeadName(node: DslNode): string | null {
  let cur: DslNode | undefined = node;
  while (cur) {
    switch (cur.type) {
      case "CallExpression":
      case "OptionalCallExpression":
        cur = cur.callee;
        break;
      case "MemberExpression":
      case "OptionalMemberExpression":
        cur = cur.object;
        break;
      case "ChainExpression":
      case "TSNonNullExpression":
        cur = cur.expression;
        break;
      default:
        return cur.type === "Identifier" ? (cur.name ?? null) : null;
    }
  }
  return null;
}

/**
 * Whether a chain ultimately roots at a `craft()` call. This is what scopes
 * the plugin to the Routecraft DSL: arbitrary fluent chains such as
 * `arr.map(...)` are left to Prettier's defaults.
 */
function rootsAtCraft(node: DslNode): boolean {
  let cur: DslNode | undefined = node;
  while (cur) {
    switch (cur.type) {
      case "CallExpression":
      case "OptionalCallExpression":
        cur = cur.callee;
        break;
      case "MemberExpression":
      case "OptionalMemberExpression":
        cur = cur.object;
        break;
      case "ChainExpression":
      case "TSNonNullExpression":
        cur = cur.expression;
        break;
      default:
        return cur.type === "Identifier" && cur.name === "craft";
    }
  }
  return false;
}

/** Whether any ancestor call expression is part of a `craft()` chain. */
function isInsideCraftChain(path: AstPath): boolean {
  let depth = 0;
  let parent = path.getParentNode(depth) as DslNode | null;
  while (parent) {
    if (parent.type === "CallExpression" && rootsAtCraft(parent)) {
      return true;
    }
    depth += 1;
    parent = path.getParentNode(depth) as DslNode | null;
  }
  return false;
}

/**
 * A "DSL arrow" is a single-parameter arrow whose body threads that parameter
 * straight into a fluent chain, for example `(c) => c.when(...).otherwise(...)`
 * or the trivial `(b) => b`. These are the sub-route builder closures that
 * Prettier breaks across too many lines. Async arrows, arrows with explicit
 * return types or type parameters, and closures whose body does not start from
 * the parameter are left untouched so we never drop a type annotation or
 * fight Prettier on shapes we do not own.
 */
function isDslArrow(node: DslNode, path: AstPath): boolean {
  if (node.type !== "ArrowFunctionExpression") return false;
  if (node.async) return false;
  if (node.returnType || node.typeParameters) return false;

  const params = node.params;
  if (!params || params.length !== 1) return false;

  const param = params[0];
  if (!param || param.type !== "Identifier" || !param.name) return false;

  const body = node.body;
  if (!body || body.type === "BlockStatement") return false;
  if (chainHeadName(body) !== param.name) return false;

  return isInsideCraftChain(path);
}

const estreePrinter = estreePrinters.estree;

/**
 * Our printer wraps the built-in estree printer. For DSL arrows it keeps the
 * threaded parameter on the same line as the arrow (`(c) => c`) and lets the
 * body's own member-chain layout supply the indentation, which collapses the
 * extra "body on its own line" break and one level of indentation that
 * Prettier would otherwise add. Every other node falls through unchanged.
 */
const routecraftPrinter: Printer = {
  ...estreePrinter,
  print(path, options, print, args): Doc {
    const node = path.node as DslNode;
    if (node && isDslArrow(node, path)) {
      const param = node.params?.[0];
      const arrowParens = options.arrowParens ?? "always";
      const omitParens = arrowParens === "avoid" && !param?.typeAnnotation;
      const paramDoc = path.call(print, "params", 0);
      const bodyDoc = path.call(print, "body");
      const open = omitParens ? "" : "(";
      const close = omitParens ? "" : ")";
      return [open, paramDoc, close, " => ", bodyDoc];
    }
    return estreePrinter.print(path, options, print, args);
  },
};

/** Wrap a built-in parser so it dispatches to our printer. */
function withRoutecraftPrinter(parser: Parser): Parser {
  return { ...parser, astFormat: AST_FORMAT };
}

export const parsers: Record<string, Parser> = {
  typescript: withRoutecraftPrinter(typescriptParsers.typescript),
  babel: withRoutecraftPrinter(babelParsers.babel),
  "babel-ts": withRoutecraftPrinter(babelParsers["babel-ts"]),
};

export const printers: Record<string, Printer> = {
  [AST_FORMAT]: routecraftPrinter,
};

const plugin: Plugin = { parsers, printers };

export default plugin;
