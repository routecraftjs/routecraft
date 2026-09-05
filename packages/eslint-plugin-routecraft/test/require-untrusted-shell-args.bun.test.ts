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
 * @preconditions shell() calls whose argument resolver does and does not read from the exchange parameter, plus literal and non-shell forms, markers that are shadowed or aliased rather than the real export, returns belonging to a nested helper rather than the resolver, comma expressions whose yielded operand is and is not exchange-derived, and locals bound to an exchange value directly, by destructuring, by assignment, through an assignment chain, or from another local
 * @expectedResult A value read from the exchange parameter and passed unwrapped is reported, including where the marker around it is not the real one; wrapped values, author literals, resolvers that ignore the exchange, and a nested helper's own returns pass
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
    // The docker tier's route shape: the command stays static, the data
    // travels through args under the marker, and options that resolve
    // from the exchange are not arguments.
    `import { shell, untrusted } from "@routecraft/os";
     shell("sh", (ex) => ["-lc", untrusted(ex.body.cmd)], {
       isolation: "docker",
       image: (ex) => ex.body.image,
       mounts: (ex) => [{ host: "/work/" + ex.body.session, container: "/workspace" }],
     });`,
    // A block body returning marked values.
    `shell("git", (ex) => { return ["clone", untrusted(ex.body.url)]; });`,
    // Not the shell adapter.
    `notShell("git", (ex) => ["clone", ex.body.url]);`,
    // The real marker, imported from the package that exports it.
    `import { shell, untrusted } from "@routecraft/os";
     shell("git", (ex) => ["clone", untrusted(ex.body.url)]);`,
    // A nested helper's returns are its own. Reporting them attributed an
    // argv the resolver never returned to the resolver.
    `import { shell } from "@routecraft/os";
     shell("git", (ex) => { function helper() { return [ex.body.url]; } return ["status"]; });`,
    // A comma expression yields its last operand, so this passes a literal
    // however many exchange reads precede it.
    `import { shell } from "@routecraft/os";
     shell("git", (ex) => ["push", (ex.body.log, "origin")]);`,
    // A local the resolver built itself carries nothing from outside.
    `import { shell } from "@routecraft/os";
     shell("git", (ex) => { const flag = "--oneline"; return ["log", flag]; });`,
    // Marking the local is the fix the rule asks for, so it must satisfy it.
    `import { shell, untrusted } from "@routecraft/os";
     shell("git", (ex) => { const url = ex.body.url; return ["clone", untrusted(url)]; });`,
    // A local assigned a literal is the author's own, however it was
    // declared.
    `import { shell } from "@routecraft/os";
     shell("git", (ex) => { let flag; flag = "--oneline"; return ["log", flag]; });`,
    // A nested helper's own locals are its own, and must not taint the
    // resolver's names.
    `import { shell } from "@routecraft/os";
     shell("git", (ex) => { function helper() { const u = ex.body.url; return u; } return ["status"]; });`,
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
    {
      // An early return inside an if is the ordinary way a resolver
      // branches, and was invisible to the rule.
      code: `shell("git", (ex) => { if (ex.body.useFetch) { return ["fetch", ex.body.url]; } return ["clone"]; });`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      // A spread expands into arguments, so what it spreads can pose as
      // an option just as an element written out can.
      code: `shell("git", (ex) => ["clone", ...ex.body.args]);`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      // A locally defined untrusted() carries no protection, so the name
      // alone must not exempt the argument.
      code: `function untrusted(v) { return v; }
             shell("git", (ex) => ["clone", untrusted(ex.body.url)]);`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      // A binding declared inside the resolver shadows the import at the
      // use site, so resolving from outside the resolver found a marker
      // that no longer applies there.
      code: `import { shell, untrusted } from "@routecraft/os";
             shell("git", (ex) => { const untrusted = (v) => v; return ["clone", untrusted(ex.body.url)]; });`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      // The right module is not enough: another export aliased to the
      // marker's name carries none of its protection.
      code: `import { shell, shellPlugin as untrusted } from "@routecraft/os";
             shell("git", (ex) => ["clone", untrusted(ex.body.url)]);`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      // The value a comma expression yields is its last operand, and here
      // that operand is the exchange value reaching argv unmarked.
      code: `import { shell } from "@routecraft/os";
             shell("git", (ex) => ["clone", (audit(ex), ex.body.url)]);`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      // Naming the value before using it is how most people write this,
      // and seeing only the inline form left the rule blind to it.
      code: `import { shell } from "@routecraft/os";
             shell("git", (ex) => { const url = ex.body.url; return ["clone", url]; });`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      // Destructuring binds an exchange value as plainly as an assignment.
      code: `import { shell } from "@routecraft/os";
             shell("git", (ex) => { const { url } = ex.body; return ["clone", url]; });`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      // Declaring and assigning separately binds the exchange as plainly
      // as a declarator does.
      code: `import { shell } from "@routecraft/os";
             shell("git", (ex) => { let url; url = ex.body.url; return ["clone", url]; });`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      // An assignment evaluates to its right side, so a chain hands the
      // value to every name in it.
      code: `import { shell } from "@routecraft/os";
             shell("git", (ex) => { let a, b; a = b = ex.body.url; return ["clone", a]; });`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      // Assigned in a branch: the local is safe on one path and not on
      // the other, and the unsafe path is the one that decides.
      code: `import { shell } from "@routecraft/os";
             shell("git", (ex) => { let u = "x"; if (ex.body.deep) { u = ex.body.url; } return ["clone", u]; });`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      // A local derived from a tainted local is still attacker-influenced,
      // so one pass over the declarations is not enough.
      code: `import { shell } from "@routecraft/os";
             shell("git", (ex) => { const raw = ex.body.url; const url = raw.trim(); return ["clone", url]; });`,
      errors: [{ messageId: "unmarked" }],
    },
  ],
});
