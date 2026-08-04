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
 * @case restrict-principal-minting rule: every minting form is flagged with a branch-identifying message (route .authenticate() on craft chains including aliased and namespace craft, named, aliased, computed-member, and namespace imports of authenticate/markAuthentic from @routecraft/routecraft, import-after-use); non-minting chains, same-named symbols from other modules, shadowing locals, and foreign craft() pass; the chain report anchors on the .authenticate property so the documented eslint-disable-next-line placement suppresses it
 * @preconditions Source snippets covering craft chains with and without .authenticate, helper imports from routecraft and from unrelated modules, aliased, namespace, computed-member and hoisted import call forms, shadowed bindings, and a multi-line chain with line/column expectations
 * @expectedResult Valid cases produce no errors; each invalid case produces one restrictedMint error per mint call carrying the expected data.what, and the multi-line chain error anchors on the .authenticate line
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
      // a craft imported from another module is not the routecraft DSL
      code: `
        import { craft } from "some-other-lib";
        craft().connect().authenticate({ apiKey: "k" });
      `,
    },
    {
      // a shadowing local wins over the routecraft import in its scope
      code: `
        import { authenticate } from "@routecraft/routecraft";
        export function handler(authenticate) {
          return authenticate({ subject: "not-a-mint" });
        }
      `,
    },
    {
      // delegate() narrows an already-branded subject; it cannot fabricate
      code: `
        import { delegate } from "@routecraft/routecraft";
        const narrowed = delegate(subject, actorClaims, { scopes: ["kb:read"] });
      `,
    },
    {
      // knowingly uncovered: destructuring a namespace import (documented
      // in the rule JSDoc as review-visible laundering, out of lint scope)
      code: `
        import * as rc from "@routecraft/routecraft";
        const { authenticate } = rc;
        authenticate({ subject: "x" });
      `,
    },
    // Note: the sanctioning mechanism (a scoped eslint-disable comment or a
    // per-file config override) is ESLint-core behavior that RuleTester
    // deliberately does not process, so it cannot appear as a valid case
    // here; the rule only ever reports, and ESLint's own machinery grants
    // the exception. The line/column assertions on the multi-line chain
    // case below are what pin the disable-comment placement contract.
  ],
  invalid: [
    {
      // report anchors on the .authenticate property (line 6), NOT the
      // chain head (line 3): the documented eslint-disable-next-line
      // placed directly above .authenticate must suppress this report
      code: `
import { craft, mail, noop } from "@routecraft/routecraft";
export default craft()
  .id("mail-channel")
  .from(mail("INBOX", {}))
  .authenticate(mintFromSender)
  .to(noop());
      `,
      errors: [
        {
          messageId: "restrictedMint",
          data: { what: ".authenticate()" },
          line: 6,
          column: 4,
        },
      ],
    },
    {
      code: `
        import { authenticate } from "@routecraft/routecraft";
        const principal = authenticate({ subject: "hacker", roles: ["admin"] });
      `,
      errors: [
        { messageId: "restrictedMint", data: { what: "authenticate()" } },
      ],
    },
    {
      // aliasing does not evade the rule
      code: `
        import { authenticate as mint } from "@routecraft/routecraft";
        const principal = mint({ subject: "hacker" });
      `,
      errors: [
        { messageId: "restrictedMint", data: { what: "authenticate()" } },
      ],
    },
    {
      // hoisting does not evade the rule: import placed after the call
      code: `
        const principal = authenticate({ subject: "hacker" });
        import { authenticate } from "@routecraft/routecraft";
      `,
      errors: [
        { messageId: "restrictedMint", data: { what: "authenticate()" } },
      ],
    },
    {
      code: `
        import { markAuthentic } from "@routecraft/routecraft";
        markAuthentic(fakePrincipal);
      `,
      errors: [
        { messageId: "restrictedMint", data: { what: "markAuthentic()" } },
      ],
    },
    {
      // namespace import does not evade the rule
      code: `
        import * as rc from "@routecraft/routecraft";
        const principal = rc.authenticate({ subject: "hacker" });
      `,
      errors: [
        { messageId: "restrictedMint", data: { what: "authenticate()" } },
      ],
    },
    {
      // computed member access does not evade the rule
      code: `
        import * as rc from "@routecraft/routecraft";
        const principal = rc["markAuthentic"](fakePrincipal);
      `,
      errors: [
        { messageId: "restrictedMint", data: { what: "markAuthentic()" } },
      ],
    },
    {
      // an aliased craft import does not evade the chain detection
      code: `
        import { craft as route, direct, noop } from "@routecraft/routecraft";
        export default route().id("aliased").from(direct()).authenticate(mint).to(noop());
      `,
      errors: [
        { messageId: "restrictedMint", data: { what: ".authenticate()" } },
      ],
    },
    {
      // a namespace craft call does not evade the chain detection
      code: `
        import * as rc from "@routecraft/routecraft";
        export default rc.craft().id("ns").from(rc.direct()).authenticate(mint).to(rc.noop());
      `,
      errors: [
        { messageId: "restrictedMint", data: { what: ".authenticate()" } },
      ],
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
        { messageId: "restrictedMint", data: { what: "markAuthentic()" } },
        { messageId: "restrictedMint", data: { what: ".authenticate()" } },
      ],
    },
  ],
});
