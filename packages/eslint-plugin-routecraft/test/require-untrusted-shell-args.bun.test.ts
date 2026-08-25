import { describe, test } from "bun:test";
import { RuleTester } from "eslint";
import requireUntrustedShellArgsRule from "../src/rules/require-untrusted-shell-args";

// Bind RuleTester runner hooks before any .run(); rule cases must be
// declared at module top-level under bun:test (it doesn't allow new
// test() registrations from inside a running test() callback).
// See .standards/testing.md § 2 for why RuleTester files use
// describe-level JSDoc instead of per-test JSDoc.
(
  RuleTester as unknown as { describe: typeof describe; it: typeof test }
).describe = describe;
(RuleTester as unknown as { describe: typeof describe; it: typeof test }).it =
  test;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

/**
 * @case require-untrusted-shell-args: exchange-derived shell() arguments must be wrapped in untrusted()
 * @preconditions shell() calls whose argument resolver does and does not read from the exchange parameter, plus literal and non-shell forms
 * @expectedResult A value read from the exchange parameter and passed unwrapped is reported; wrapped values, author literals, and resolvers that ignore the exchange pass
 */
ruleTester.run("require-untrusted-shell-args", requireUntrustedShellArgsRule, {
  valid: [
    // The value is marked, so flag protection applies to it.
    `shell("git", (ex) => ["clone", untrusted(ex.body.url), "/work"]);`,
    // Nothing here comes from the exchange.
    `shell("git", ["log", "--oneline"]);`,
    // A resolver that ignores its parameter builds arguments from the
    // author's own code.
    `shell("git", () => ["log", "--oneline"]);`,
    // Every exchange-derived element is marked.
    `shell("git", (ex) => ["clone", untrusted(ex.body.url), untrusted(ex.headers.ref)]);`,
    // A block body returning marked values.
    `shell("git", (ex) => { return ["clone", untrusted(ex.body.url)]; });`,
    // Not the shell adapter.
    `notShell("git", (ex) => ["clone", ex.body.url]);`,
  ],
  invalid: [
    {
      code: `shell("git", (ex) => ["clone", ex.body.url, "/work"]);`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      // A template literal carrying the value is just as attacker-influenced.
      code: 'shell("git", (ex) => ["clone", `${ex.body.url}`]);',
      errors: [{ messageId: "unmarked" }],
    },
    {
      // Passing it through a call does not launder it.
      code: `shell("git", (ex) => ["clone", String(ex.body.url)]);`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      // Both unmarked values are reported, not just the first.
      code: `shell("git", (ex) => ["clone", ex.body.url, ex.body.ref]);`,
      errors: [{ messageId: "unmarked" }, { messageId: "unmarked" }],
    },
    {
      // A block body is walked the same way as an expression body.
      code: `shell("git", (ex) => { return ["clone", ex.body.url]; });`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      // Both branches of a conditional resolver are checked.
      code: `shell("git", (ex) => ex.body.deep ? ["clone", ex.body.url] : ["fetch"]);`,
      errors: [{ messageId: "unmarked" }],
    },
  ],
});
