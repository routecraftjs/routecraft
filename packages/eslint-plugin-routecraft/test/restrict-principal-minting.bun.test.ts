import { describe, test } from "bun:test";
import { RuleTester } from "eslint";
import restrictPrincipalMintingRule from "../src/rules/restrict-principal-minting";

// ESLint's RuleTester registers describe/it blocks dynamically when
// `.run(...)` is called. Bun:test does not allow new test registrations
// from inside a running test() callback, so `.run(...)` must happen at
// module top-level. See .standards/testing.md § 2 for why RuleTester
// files use describe-level JSDoc instead of per-test JSDoc.
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
 * @case restrict-principal-minting rule: every minting form is flagged (route .authenticate() on craft chains, named, aliased, and namespace imports of authenticate/markAuthentic from @routecraft/routecraft); non-minting chains and same-named symbols from other modules pass
 * @preconditions Source snippets covering craft chains with and without .authenticate, helper imports from routecraft and from unrelated modules, aliased and namespace import call forms, and a sanctioned site using an eslint-disable comment
 * @expectedResult Valid cases produce no errors; each invalid case produces exactly one restrictedMint error per mint call
 */
ruleTester.run("restrict-principal-minting", restrictPrincipalMintingRule, {
  valid: [
    {
      code: `
        import { craft, direct, noop } from "@routecraft/routecraft";
        export default craft()
          .id("no-minting")
          .authorize({ actor: "none" })
          .from(direct())
          .to(noop());
      `,
    },
    {
      // .authenticate on something that is not a craft() chain
      code: `
        client.authenticate({ apiKey: "k" });
      `,
    },
    {
      // authenticate imported from another module is not routecraft minting
      code: `
        import { authenticate } from "./local-auth";
        authenticate({ subject: "user" });
      `,
    },
    {
      // delegate() narrows an already-branded subject; it cannot fabricate
      code: `
        import { delegate } from "@routecraft/routecraft";
        const narrowed = delegate(subject, actorClaims, { scopes: ["kb:read"] });
      `,
    },
    // Note: the sanctioning mechanism (a scoped eslint-disable comment or a
    // per-file config override) is ESLint-core behavior that RuleTester
    // deliberately does not process, so it cannot appear as a valid case
    // here; the rule only ever reports, and ESLint's own machinery grants
    // the exception.
  ],
  invalid: [
    {
      code: `
        import { craft, mail, noop } from "@routecraft/routecraft";
        export default craft()
          .id("mail-channel")
          .from(mail("INBOX"))
          .authenticate(mintFromSender)
          .to(noop());
      `,
      errors: [{ messageId: "restrictedMint" }],
    },
    {
      code: `
        import { authenticate } from "@routecraft/routecraft";
        const principal = authenticate({ subject: "hacker", roles: ["admin"] });
      `,
      errors: [{ messageId: "restrictedMint" }],
    },
    {
      // aliasing does not evade the rule
      code: `
        import { authenticate as mint } from "@routecraft/routecraft";
        const principal = mint({ subject: "hacker" });
      `,
      errors: [{ messageId: "restrictedMint" }],
    },
    {
      code: `
        import { markAuthentic } from "@routecraft/routecraft";
        markAuthentic(fakePrincipal);
      `,
      errors: [{ messageId: "restrictedMint" }],
    },
    {
      // namespace import does not evade the rule
      code: `
        import * as rc from "@routecraft/routecraft";
        const principal = rc.authenticate({ subject: "hacker" });
      `,
      errors: [{ messageId: "restrictedMint" }],
    },
    {
      // one report per mint call
      code: `
        import { craft, simple, noop, markAuthentic } from "@routecraft/routecraft";
        markAuthentic(fake);
        export default craft()
          .id("double")
          .from(simple({}))
          .authenticate(() => ({ subject: "x" }))
          .to(noop());
      `,
      errors: [
        { messageId: "restrictedMint" },
        { messageId: "restrictedMint" },
      ],
    },
  ],
});
