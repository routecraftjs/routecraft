import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  AUTHORITY,
  authorityOf,
  authorize,
  craft,
  CraftContext,
  defaultAuthority,
  definePlugin,
  direct,
  noop,
  type Authority,
  type Principal,
} from "../src/index.ts";

/**
 * Every mint and every trust check goes through the application's
 * `AUTHORITY`, so a replacement decides both sides and a gate never
 * disagrees with the step that minted.
 */
describe("the principals port", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A replaced authority mints in .authenticate() and is consulted by .authorize()
   * @preconditions A plugin replaces AUTHORITY with one that delegates to the default and records mint and isAuthentic calls; a route authenticates then validates with authorize()
   * @expectedResult The exchange passes the gate, and both the mint and the trust check reached the replacement
   */
  test("a replacement authority both mints and decides trust", async () => {
    const calls: string[] = [];
    const recording: Authority = {
      ...defaultAuthority,
      mint(claims) {
        calls.push("mint");
        return defaultAuthority.mint(claims);
      },
      isAuthentic(principal: unknown): principal is Principal {
        calls.push("isAuthentic");
        return defaultAuthority.isAuthentic(principal);
      },
    };
    const replacement = definePlugin({
      id: "test.authority",
      provides: [AUTHORITY],
      replaces: [AUTHORITY],
      bind(c) {
        c.provide(AUTHORITY, recording);
      },
    });

    t = await testContext()
      .with({ plugins: [replacement] })
      .routes(
        craft()
          .id("gated")
          .from(direct())
          .authenticate(() => ({ scheme: "test", subject: "ada" }))
          .validate(authorize())
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();

    await t.client.sendDirect("gated", "x");
    expect(calls).toContain("mint");
    expect(calls).toContain("isAuthentic");
  });

  /**
   * @case A plugin that replaces the authority is named at boot
   * @preconditions A plugin brought in through another plugin's installs, declaring replaces: [AUTHORITY]
   * @expectedResult One warning at build names the replacing plugin, the port and the displaced default. A replacement can arrive through a dependency rather than the application's own config, and who decides identity is a trust decision an operator must be able to see
   */
  test("a replaced authority is announced at boot, even when brought", async () => {
    const replacement = definePlugin({
      id: "test.authority",
      provides: [AUTHORITY],
      replaces: [AUTHORITY],
      bind(c) {
        c.provide(AUTHORITY, defaultAuthority);
      },
    });
    const carrier = definePlugin({
      id: "test.carrier",
      installs: [replacement],
    });

    t = await testContext()
      .with({ plugins: [carrier] })
      .build();

    const announced = t.contextLogger.warn.mock.calls.filter(
      (call) =>
        typeof call[1] === "string" &&
        call[1].includes("replaces the provider of"),
    );
    expect(announced).toHaveLength(1);
    expect(announced[0]![0]).toMatchObject({
      port: AUTHORITY.name,
      plugin: "test.authority",
      displaced: ["routecraft.principals"],
    });
  });

  /**
   * @case A principal the default authority branded is not trusted by a replacement that does not recognise it
   * @preconditions A replacement authority whose isAuthentic always answers false; a route authenticates then validates with authorize()
   * @expectedResult The gate refuses with RC5023, because trust is the application's authority's call alone
   */
  test("a replacement's answer is the gate's answer", async () => {
    const distrusting: Authority = {
      ...defaultAuthority,
      isAuthentic(principal: unknown): principal is Principal {
        void principal;
        return false;
      },
    };
    const replacement = definePlugin({
      id: "test.distrusting",
      provides: [AUTHORITY],
      replaces: [AUTHORITY],
      bind(c) {
        c.provide(AUTHORITY, distrusting);
      },
    });

    t = await testContext()
      .with({ plugins: [replacement] })
      .routes(
        craft()
          .id("refused")
          .from(direct())
          .authenticate(() => ({ scheme: "test", subject: "ada" }))
          .validate(authorize())
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("refused", "x")).rejects.toMatchObject({
      rc: "RC5023",
    });
  });

  /**
   * @case An application that displaces the principals plugin without providing an authority
   * @preconditions A plugin with the id routecraft.principals that provides nothing, so the default is not installed; no plugin provides AUTHORITY
   * @expectedResult authorityOf(context) is RC1104 rather than the default authority, while authorityOf(undefined) still answers the default
   */
  test("a displaced principals plugin is RC1104, never the default", async () => {
    const displacing = definePlugin({ id: "routecraft.principals" });
    t = await testContext()
      .with({ plugins: [displacing] })
      .build();
    await t.startAndWaitReady();

    expect(() => authorityOf(t!.ctx)).toThrow(
      expect.objectContaining({ rc: "RC1104" }),
    );
    expect(authorityOf(undefined)).toBe(defaultAuthority);
  });

  /**
   * @case A context asked for its authority before its plugins are installed
   * @preconditions A CraftContext that has not started
   * @expectedResult RC1104, so a custom authority the context will install is never stood in for by the default
   */
  test("a context without its plugins is RC1104, never the default", () => {
    const context = new CraftContext();
    expect(() => authorityOf(context)).toThrow(
      expect.objectContaining({ rc: "RC1104" }),
    );
  });

  /**
   * @case A plugin resolves the authority through its own context
   * @preconditions A replacement authority, and a second plugin declaring AUTHORITY optional whose bind calls authorityOf(c) with its plugin context
   * @expectedResult The plugin sees the replacement, not the default: a lookup that is not a CraftContext is still a lookup
   */
  test("a plugin context resolves the application's authority", async () => {
    const replacing: Authority = { ...defaultAuthority };
    const replacement = definePlugin({
      id: "test.replacing",
      provides: [AUTHORITY],
      replaces: [AUTHORITY],
      bind(c) {
        c.provide(AUTHORITY, replacing);
      },
    });
    let seen: Authority | undefined;
    const reader = definePlugin({
      id: "test.reader",
      optional: [AUTHORITY],
      bind(c) {
        seen = authorityOf(c);
      },
    });

    t = await testContext()
      .with({ plugins: [replacement, reader] })
      .build();
    await t.startAndWaitReady();

    expect(seen).toBe(replacing);
  });
});
