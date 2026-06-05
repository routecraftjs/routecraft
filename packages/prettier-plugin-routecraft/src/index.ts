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
  arguments?: DslNode[];
  comments?: unknown[];
  typeAnnotation?: unknown;
  returnType?: unknown;
  typeParameters?: unknown;
}

/** Whether Prettier attached any comments directly to this node. */
function hasComments(node: DslNode): boolean {
  return Array.isArray(node.comments) && node.comments.length > 0;
}

/**
 * Walk to the head of a fluent member/call chain and return the terminal node
 * (the first node that is not a chain link). For `c.when(...).otherwise(...)`
 * this is the identifier `c`; for `direct(...).send(...)` it is the `direct`
 * identifier reached through the leading call. Callers inspect the result to
 * distinguish parameter-threaded builders from factory-rooted callbacks and to
 * detect `craft()`-rooted chains.
 */
function chainHead(node: DslNode): DslNode {
  let cur: DslNode = node;
  while (true) {
    let next: DslNode | undefined;
    switch (cur.type) {
      case "CallExpression":
      case "OptionalCallExpression":
        next = cur.callee;
        break;
      case "MemberExpression":
      case "OptionalMemberExpression":
        next = cur.object;
        break;
      case "ChainExpression":
      case "TSNonNullExpression":
        next = cur.expression;
        break;
      default:
        return cur;
    }
    if (!next) return cur;
    cur = next;
  }
}

/**
 * The identifier name at the head of a chain, or `null` when it does not bottom
 * out at a bare identifier. Used to tell parameter-threaded builders
 * (`(c) => c.when(...)`, head is the param) from factory-rooted callbacks
 * (`(ex) => direct(...).send(...)`, head is a call).
 */
function chainHeadName(node: DslNode): string | null {
  const head = chainHead(node);
  return head.type === "Identifier" ? (head.name ?? null) : null;
}

/**
 * Whether a chain ultimately roots at a `craft()` call. This is what scopes
 * the plugin to the Routecraft DSL: arbitrary fluent chains such as
 * `arr.map(...)` are left to Prettier's defaults.
 */
function rootsAtCraft(node: DslNode): boolean {
  return chainHeadName(node) === "craft";
}

/**
 * Whether the node sits directly in a call's argument list, for example the
 * closure in `.enrich((ex) => ..., only(...))`. This keeps the plugin to DSL
 * callback arguments and leaves arrows that are object or array values (such as
 * `path: (ex) => path.join(...)` inside an adapter's options) to Prettier.
 */
function isDirectCallArgument(node: DslNode, path: AstPath): boolean {
  const parent = path.getParentNode(0) as DslNode | null;
  if (!parent || parent.type !== "CallExpression") return false;
  return Array.isArray(parent.arguments) && parent.arguments.includes(node);
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
 * A "DSL arrow" is a single-parameter arrow that threads its parameter straight
 * into a fluent chain (`(c) => c.when(...).otherwise(...)`, or the trivial
 * `(b) => b`), passed directly as a call argument inside a `craft()` chain.
 * These are the sub-route builder closures Prettier breaks across too many
 * lines, so we keep the parameter on the arrow line.
 *
 * Everything else falls through to Prettier: factory-rooted callbacks such as
 * `(ex) => direct(...).send(...)` (whose head is a call, not the parameter) get
 * Prettier's natural arrow layout, which keeps short bodies inline and breaks
 * long ones onto the next line. Async arrows and arrows with explicit return
 * types or type parameters are left untouched so we never drop a type
 * annotation, as are arrows used as object or array values (adapter option
 * callbacks) and non-chain bodies (template literals, conditionals, ...).
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

  // Bail to Prettier's default printer when the arrow or its immediate body
  // carries comments. Our hand-built doc does not reproduce the default arrow
  // printer's comment placement, and a comment between `=>` and the body would
  // otherwise produce non-idempotent output. Comments deeper in the chain
  // attach to other nodes and are printed correctly via recursion.
  if (hasComments(node) || hasComments(body)) return false;

  return isDirectCallArgument(node, path) && isInsideCraftChain(path);
}

const estreePrinter = estreePrinters.estree;

/**
 * Our printer wraps the built-in estree printer. For parameter-threaded DSL
 * builders (`(c) => c.when(...)`) it keeps the parameter on the arrow line and
 * lets the body's own member-chain layout supply the indentation, collapsing
 * the extra "body on its own line" break and one level of indentation Prettier
 * would otherwise add. Every other node falls through to the built-in printer
 * unchanged.
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
