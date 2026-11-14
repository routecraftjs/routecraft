import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  MemoryDeferralStore,
  craft,
  direct,
  noop,
  type CraftConfig,
} from "../src/index.ts";
import * as entry from "../src/index.ts";
import { isCraftContext, isExchange, isRoute } from "../src/brand.ts";
import { asDeferred } from "./helpers/deferral.ts";

const SECRET = "deferral-leaks-test-secret-key-0123456789";

const Approval = z.object({ approved: z.boolean() });

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

describe("what the defer and resume paths write down", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * Everything the application logged or emitted, and every error a caller
   * saw, as text. An event's reference to a live exchange, route or context
   * is left out: the resume door's exchange holds the request its caller
   * sent, token included, and that is the caller's own copy.
   */
  function written(context: TestContext, seen: unknown[]): string {
    const logged = [context.logger, context.contextLogger].flatMap((logger) =>
      LEVELS.flatMap((level) => logger[level].mock.calls),
    );
    const visited = new WeakSet<object>();
    return JSON.stringify([logged, seen], (_key, value: unknown) => {
      if (isExchange(value) || isRoute(value) || isCraftContext(value)) {
        return undefined;
      }
      if (value instanceof Error) {
        return { ...value, message: value.message, cause: value.cause };
      }
      if (typeof value === "object" && value !== null) {
        if (visited.has(value)) return undefined;
        visited.add(value);
      }
      return value;
    });
  }

  /**
   * @case A park, a resume and each refusal leave no resume token and no signing secret behind
   * @preconditions A route that reads the facet token in a tap and then parks; the token is then presented forged (RC5041), with a payload the schema refuses (RC5049), validly, and again after it settled; every log call at every level, every event and every error is collected
   * @expectedResult None of them contains either token, a token's signature or the secret: a token reaches the route's own tap and the caller's acknowledgment, and nowhere else
   */
  test("no token and no secret in a log line, an event or an error", async () => {
    const seen: unknown[] = [];
    const notified: string[] = [];
    t = await testContext()
      .with({ deferral: { secret: SECRET } })
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .tap((ex) => {
            notified.push(ex.deferral.token);
          })
          .defer({ input: Approval })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    t.ctx.on("*", (payload) => {
      seen.push(payload);
    });
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("payout", { n: 1 }));
    const answer = (token: string, input: unknown) =>
      t!.client.sendDirect("answers", { token, input }).catch((error) => {
        seen.push(error, (error as Error).message, (error as Error).stack);
        return error as { rc?: string };
      });

    const forged = await answer(`${deferred.token}x`, { approved: true });
    const refused = await answer(deferred.token, { approved: "yes" });
    await answer(deferred.token, { approved: true });
    const settled = await answer(deferred.token, { approved: true });
    await t.drain();

    expect(forged).toMatchObject({ rc: "RC5041" });
    expect(refused).toMatchObject({ rc: "RC5049" });
    expect(settled).toMatchObject({ status: "duplicate" });
    expect(notified).toHaveLength(1);

    const text = written(t, seen);
    expect(text).toContain("Exchange deferred");
    expect(text).toContain("route:exchange:deferred");
    for (const token of [deferred.token, notified[0]!]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(token.split(".")[1]!);
    }
    expect(text).not.toContain(SECRET);
  });

  /**
   * @case A resume refused because the route changed leaves no token behind either
   * @preconditions The exchange parks in one application; a second, sharing the store, edits a step after the defer point and takes the resume; logs, events and the error are collected in the second
   * @expectedResult RC5048 reaches the caller and the route's error handler, and nothing written contains the token or the secret
   */
  test("the changed-continuation refusal carries no token", async () => {
    const store = new MemoryDeferralStore();
    const shared: CraftConfig = { deferral: { store, secret: SECRET } };
    const first = await testContext()
      .with(shared)
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ input: Approval })
          .transform(() => 1)
          .to(noop()),
      ])
      .build();
    await first.startAndWaitReady();
    const deferred = asDeferred(
      await first.client.sendDirect("payout", { n: 1 }),
    );
    await first.stop();

    const seen: unknown[] = [];
    t = await testContext()
      .with(shared)
      .routes([
        craft()
          .id("payout")
          .error((error) => {
            seen.push(error, (error as Error).message);
            return { reasked: true };
          })
          .from(direct())
          .defer({ input: Approval })
          .transform(() => 2)
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    t.ctx.on("*", (payload) => {
      seen.push(payload);
    });
    await t.startAndWaitReady();

    const refusal = await t.client
      .sendDirect("answers", {
        token: deferred.token,
        input: { approved: true },
      })
      .catch((error) => error as Error & { rc?: string });
    seen.push(refusal, (refusal as Error).message, (refusal as Error).stack);

    expect(refusal).toMatchObject({ rc: "RC5048" });
    const text = written(t, seen);
    expect(text).not.toContain(deferred.token);
    expect(text).not.toContain(SECRET);
  });

  /**
   * @case The public entry exports nothing whose name says signer, signing secret or deferral runtime
   * @preconditions The main entry's runtime exports
   * @expectedResult Nothing that builds a signer or resolves the signing secret is exported: a token is minted through the facet, the acknowledgment or the continuations facade
   */
  test("the entry exports nothing named for a signer", () => {
    const names = Object.keys(entry).filter((name) =>
      /signer|signingsecret|deferralruntime/i.test(name),
    );
    expect(names).toEqual([]);
  });
});
