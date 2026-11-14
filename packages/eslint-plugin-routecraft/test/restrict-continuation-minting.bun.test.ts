import { describe, test } from "bun:test";
import { RuleTester } from "eslint";
import restrictContinuationMintingRule from "../src/rules/restrict-continuation-minting";

// See restrict-principal-minting.bun.test.ts for why `.run(...)` sits at
// module top-level and the JSDoc is on the describe level.
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
 * @case restrict-continuation-minting rule: each act on a parked exchange is flagged with a message naming it (mintToken, resume and rewriteStepState on a member named continuations, on a local or parameter named continuations, on a destructured one and on a const or let holding one; deferral.tokenFor, through the facet or deferralOf(); signer.mint reached through require(CONTINUATIONS) or lookup(CONTINUATIONS), directly, through an optional chain and through a const), including inside a project.craft() chain; reading a token, the read view's methods, sweep, a same-named import from another module, a shadowing local, a signer that is not the continuations signer and an unrelated resume() pass; the report anchors on the method name so a disable comment directly above the call suppresses it
 * @preconditions Source snippets covering plugin hooks, route chains, helper functions and unrelated objects that share a method name
 * @expectedResult Valid cases produce no errors; each invalid case produces one error per call with the message for its act and the expected data.what, and the multi-line case anchors on the line of the method
 */
ruleTester.run(
  "restrict-continuation-minting",
  restrictContinuationMintingRule,
  {
    valid: [
      {
        // the documented route-author path: a link to one's own deferral
        code: `
          import { craft, direct, noop } from "@routecraft/routecraft";
          export default craft()
            .id("approval")
            .from(direct())
            .tap((ex) => notify(ex.deferral.token))
            .defer({})
            .to(noop());
        `,
      },
      {
        // reads and the sweep are not acts this rule covers
        code: `
          export const plugin = {
            async start(c) {
              await c.continuations.get("id");
              await c.continuations.list({ limit: 10 });
              c.continuations.verifyToken(token);
              await c.continuations.sweep();
            },
          };
        `,
      },
      {
        // the read view carries no act, and resume() on something else is not ours
        code: `
          import { continuationsOf } from "@routecraft/routecraft";
          const view = continuationsOf(ex);
          await view.get(id);
          player.resume();
          session.resume({ token });
        `,
      },
      {
        // an import named continuations from another module is somebody else's object
        code: `
          import { continuations } from "./my-own-thing";
          continuations.mintToken("x");
        `,
      },
      {
        // a const that does not hold the facade
        code: `
          const continuations = makeSomething();
          continuations.mintToken("x");
        `,
      },
      {
        // a signer that is not the continuations signer
        code: `
          import { CONTINUATIONS } from "./local";
          c.require(CONTINUATIONS).signer.mint(id);
          jwt.signer.mint(claims);
          const signer = makeSigner();
          signer.mint(id);
        `,
      },
      {
        // tokenFor on something that is not the deferral facet
        code: `
          cache.tokenFor("key");
        `,
      },
      {
        // aliases that name each other end without a report, never a crash
        code: `
          var a = b, b = a;
          a.mintToken(id);
        `,
      },
    ],
    invalid: [
      {
        // a let alias, a destructured facade, a template-quoted member and deferralOf()
        code: `
          import { deferralOf } from "@routecraft/routecraft";
          export const plugin = {
            start(c) {
              let held = c.continuations;
              held.mintToken(id);
              const { continuations } = c;
              continuations.mintToken(id);
              c[\`continuations\`].mintToken(id);
              deferralOf(exchange).tokenFor("call");
            },
          };
        `,
        errors: [
          {
            messageId: "restrictedMint",
            data: { what: "continuations.mintToken()" },
          },
          {
            messageId: "restrictedMint",
            data: { what: "continuations.mintToken()" },
          },
          {
            messageId: "restrictedMint",
            data: { what: "continuations.mintToken()" },
          },
          {
            messageId: "restrictedMint",
            data: { what: "deferral.tokenFor()" },
          },
        ],
      },
      {
        // a plugin hook, each act once
        code: `
          export const plugin = {
            async start(c) {
              const token = c.continuations.mintToken(id);
              await c.continuations.resume({ token, input: undefined });
              await c.continuations.rewriteStepState(id, (state) => state);
            },
          };
        `,
        errors: [
          {
            messageId: "restrictedMint",
            data: { what: "continuations.mintToken()" },
          },
          {
            messageId: "restrictedResume",
            data: { what: "continuations.resume()" },
          },
          {
            messageId: "restrictedRewrite",
            data: { what: "continuations.rewriteStepState()" },
          },
        ],
      },
      {
        // the application holding its context, a parameter and a const
        code: `
          context.continuations.mintToken(id);
          export function compact(continuations, id) {
            return continuations.rewriteStepState(id, shrink);
          }
          const held = t.ctx.continuations;
          held.resume({ token, input: {} });
        `,
        errors: [
          {
            messageId: "restrictedMint",
            data: { what: "continuations.mintToken()" },
          },
          {
            messageId: "restrictedRewrite",
            data: { what: "continuations.rewriteStepState()" },
          },
          {
            messageId: "restrictedResume",
            data: { what: "continuations.resume()" },
          },
        ],
      },
      {
        // a token for a call binding, inside a project.craft() chain
        code: `
          export default project
            .craft()
            .id("fan-out")
            .from(direct())
            .process((ex) => ({ link: ex.deferral.tokenFor("call-1") }))
            .to(noop());
        `,
        errors: [
          {
            messageId: "restrictedMint",
            data: { what: "deferral.tokenFor()" },
          },
        ],
      },
      {
        // the signer behind the port: direct, optional chain, and held in consts
        code: `
          import { CONTINUATIONS } from "@routecraft/routecraft";
          c.require(CONTINUATIONS).signer.mint(id);
          context.lookup(CONTINUATIONS)?.signer.mint(id, new Date());
          const runtime = c.lookup(CONTINUATIONS);
          runtime.signer.mint(id);
          const signer = c.require(CONTINUATIONS).signer;
          signer.mint(id);
        `,
        errors: [
          { messageId: "restrictedMint", data: { what: "signer.mint()" } },
          { messageId: "restrictedMint", data: { what: "signer.mint()" } },
          { messageId: "restrictedMint", data: { what: "signer.mint()" } },
          { messageId: "restrictedMint", data: { what: "signer.mint()" } },
        ],
      },
      {
        // anchored on the method (line 4), so a disable comment directly above it suppresses the report
        code: `
          const token = c
            .continuations
            .mintToken(id);
        `,
        errors: [
          {
            messageId: "restrictedMint",
            data: { what: "continuations.mintToken()" },
            line: 4,
          },
        ],
      },
    ],
  },
);
