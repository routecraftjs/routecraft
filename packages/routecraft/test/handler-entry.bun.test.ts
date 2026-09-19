import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  noop,
  recovery,
  type EntryContext,
  type Exchange,
} from "../src/index.ts";

describe("context handlers: the entry point", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A handler decorates the exchange before the first user step runs
   * @preconditions One entry handler returning { headers }, and a route reading that header
   * @expectedResult The first step sees the header the handler stamped
   */
  test("a decoration reaches the first user step", async () => {
    let seen: unknown;
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform((body, ex) => {
            seen = (ex as Exchange).headers["x-tenant"];
            return body;
          })
          .to(noop()),
      ])
      .build();
    t.ctx.registerHandler("entry", () => ({ headers: { "x-tenant": "acme" } }));
    await t.startAndWaitReady();

    await t.client.sendDirect("work", {});

    expect(seen).toBe("acme");
  });

  /**
   * @case Two decorating handlers at one point both take effect
   * @preconditions Two entry handlers each stamping a different header
   * @expectedResult Both headers are present, and the second handler saw the first one's work
   */
  test("decorations accumulate rather than the first winning", async () => {
    const carried: unknown[] = [];
    let seen: Record<string, unknown> = {};
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform((body, ex) => {
            const headers = (ex as Exchange).headers;
            seen = {
              tenant: headers["x-tenant"],
              audit: headers["x-audit"],
            };
            return body;
          })
          .to(noop()),
      ])
      .build();
    t.ctx.registerHandler("entry", () => ({ headers: { "x-tenant": "acme" } }));
    t.ctx.registerHandler("entry", (ctx: EntryContext) => {
      // The accumulation is what the next handler sees, which is the half a
      // single-rule chain would lose: it would see the original exchange.
      carried.push(ctx.exchange.headers["x-tenant"]);
      return { headers: { "x-audit": "on" } };
    });
    await t.startAndWaitReady();

    await t.client.sendDirect("work", {});

    expect(seen).toEqual({ tenant: "acme", audit: "on" });
    expect(carried).toEqual(["acme"]);
  });

  /**
   * @case A refusal ends the chain
   * @preconditions A refusing handler registered before a decorating one
   * @expectedResult The later handler is never consulted and no user step runs
   */
  test("a refusal stops the handler after it and the route body", async () => {
    let later = false;
    let ran = false;
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform((body) => {
            ran = true;
            return body;
          })
          .to(noop()),
      ])
      .build();
    t.ctx.registerHandler("entry", () => recovery.drop("not for this tenant"));
    t.ctx.registerHandler("entry", () => {
      later = true;
      return undefined;
    });
    await t.startAndWaitReady();

    // The drop reaches a request/reply caller as RC5031, the same answer a
    // `.filter()` rejection gives, rather than as a failure.
    await expect(t.client.sendDirect("work", {})).rejects.toThrow(
      /dropped the exchange/,
    );

    expect(later).toBe(false);
    expect(ran).toBe(false);
  });

  /**
   * @case A handler that throws does not take the point down with it
   * @preconditions A first handler that throws and a second that decorates
   * @expectedResult The second still runs and its decoration reaches the route
   */
  test("a throwing handler is reported and the chain continues", async () => {
    let seen: unknown;
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .from(direct())
          .transform((body, ex) => {
            seen = (ex as Exchange).headers["x-audit"];
            return body;
          })
          .to(noop()),
      ])
      .build();
    const failures: number[] = [];
    t.ctx.on("route:handler:failed", ({ details }) => {
      failures.push(details.handlerIndex);
    });
    t.ctx.registerHandler("entry", () => {
      throw new Error("handler is broken");
    });
    t.ctx.registerHandler("entry", () => ({ headers: { "x-audit": "on" } }));
    await t.startAndWaitReady();

    await t.client.sendDirect("work", {});

    expect(failures).toEqual([0]);
    expect(seen).toBe("on");
  });

  /**
   * @case The point sits below input validation
   * @preconditions A route declaring .input() and a body that violates it
   * @expectedResult The handler is never consulted, because the chain refused above it
   */
  test("a body that fails input never reaches the point", async () => {
    let consulted = false;
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .input({
            "~standard": {
              version: 1,
              vendor: "test",
              validate: (value: unknown) =>
                typeof (value as { ok?: unknown })?.ok === "boolean"
                  ? { value }
                  : { issues: [{ message: "ok must be a boolean" }] },
            },
          })
          .from(direct())
          .to(noop()),
      ])
      .build();
    t.ctx.registerHandler("entry", () => {
      consulted = true;
      return undefined;
    });
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("work", { ok: "no" })).rejects.toThrow();

    expect(consulted).toBe(false);
  });

  /**
   * @case The point sits above throttle, so a refusal spends no token
   * @preconditions A route with a one-per-hour throttle and a handler refusing every exchange
   * @expectedResult Two refusals in a row, rather than the second being rate limited
   */
  test("a refusal spends no throttle token", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .throttle({ rate: 1, per: "hour" })
          .from(direct())
          .to(noop()),
      ])
      .build();
    let refusals = 0;
    t.ctx.registerHandler("entry", () => {
      refusals += 1;
      return recovery.drop("refused");
    });
    await t.startAndWaitReady();

    // A refusal drops the exchange, which a request/reply caller is told
    // about: RC5031 is the drop reaching the caller, not a throttle refusal.
    await expect(t.client.sendDirect("work", {})).rejects.toThrow(
      /dropped the exchange/,
    );
    await expect(t.client.sendDirect("work", {})).rejects.toThrow(
      /dropped the exchange/,
    );

    // Two consultations, and neither exchange was refused by the throttle
    // instead: the gate below the point never saw them.
    expect(refusals).toBe(2);
  });

  /**
   * @case A selector scopes the registration
   * @preconditions Two routes, with the handler registered for one of them by id
   * @expectedResult Only the named route consults it
   */
  test("a selector by route id applies to those routes and no others", async () => {
    const seen: string[] = [];
    t = await testContext()
      .routes([
        craft().id("mine").from(direct()).to(noop()),
        craft().id("theirs").from(direct()).to(noop()),
      ])
      .build();
    t.ctx.registerHandler(
      "entry",
      (ctx: EntryContext) => {
        seen.push(ctx.route.definition.id);
        return undefined;
      },
      { routes: ["mine"] },
    );
    await t.startAndWaitReady();

    await t.client.sendDirect("mine", {});
    await t.client.sendDirect("theirs", {});

    expect(seen).toEqual(["mine"]);
  });

  /**
   * @case A handler answering with neither vocabulary is told so
   * @preconditions A handler returning a plain object that is not { headers }
   * @expectedResult It is reported as a failed handler rather than silently changing nothing
   */
  test("an unreadable answer is reported rather than ignored", async () => {
    t = await testContext()
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    const failures: unknown[] = [];
    t.ctx.on("route:handler:failed", ({ details }) => {
      failures.push(details.point);
    });
    t.ctx.registerHandler("entry", () => ({ notHeaders: true }) as never);
    await t.startAndWaitReady();

    await t.client.sendDirect("work", {});

    expect(failures).toEqual(["entry"]);
  });
});
