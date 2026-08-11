import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  http,
  noop,
  otherwise,
  when,
  type CraftConfig,
  type EventName,
  type HttpPluginOptions,
  type Source,
  type Subscription,
} from "../src/index.ts";
import { suspending } from "./helpers/suspension.ts";

const Approval = z.object({ approved: z.boolean() });

/**
 * A mail-shaped source: one message, payload on `body` and envelope on
 * `routecraft.mail.*` headers, exactly as the mail adapter emits it.
 *
 * Hand-rolled rather than driven through IMAP because what is under test is
 * the framework's behaviour for a source with no way to answer a caller,
 * not the mail adapter.
 */
function mailbox(message: {
  from: string;
  subject: string;
  text: string;
}): Source<unknown> {
  return {
    adapterId: "routecraft.adapter.test.mailbox",
    async subscribe(sub: Subscription): Promise<void> {
      sub.ready();
      await sub.emit({
        message: { text: message.text },
        headers: {
          "routecraft.mail.from": message.from,
          "routecraft.mail.subject": message.subject,
        },
      });
      sub.complete();
    },
  };
}

/**
 * A queue-shaped source that records how each delivery settled.
 *
 * The contract under test is the epic's: a suspend must ACK, never nack.
 * The work is durably parked in the suspension store, so redelivery would
 * create a second suspension for the same message and ask the approver
 * twice.
 */
function queueSource(
  payload: unknown,
  settled: Array<"ack" | "nack">,
): Source<unknown> {
  return {
    adapterId: "routecraft.adapter.test.queue",
    async subscribe(sub: Subscription): Promise<void> {
      sub.ready();
      try {
        await sub.emit({ message: payload });
        settled.push("ack");
      } catch {
        settled.push("nack");
      }
      sub.complete();
    },
  };
}

describe("suspend and resume across transports", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case An http() ingress parks and answers 202 with the acknowledgment
   * @preconditions POST route whose pipeline reaches .suspend({ ttl }) before its destination
   * @expectedResult 202 Accepted, a Retry-After derived from the ttl, and the Suspended value as the JSON body; a later resume drives the continuation
   */
  test("http() answers 202 with the Suspended body", async () => {
    let port = 0;
    t = await testContext()
      .on(
        "plugin:http:server:listening" as EventName,
        ((payload: { details: { port: number } }) => {
          port = payload.details.port;
        }) as never,
      )
      .with({ ...suspending(), http: { port: 0 } } as CraftConfig &
        HttpPluginOptions)
      .routes([
        craft()
          .id("payout")
          .from(http({ path: "/payouts", method: "POST" }))
          .suspend({ expect: Approval, ttl: "72h" })
          .transform(() => ({ paid: true }))
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();
    expect(port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${port}/payouts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountCents: 90_000 }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      status: string;
      token: string;
      suspensionId: string;
      expiresAt: string;
    };
    expect(body.status).toBe("suspended");
    expect(body.token).toBeString();
    // 72h, minus the milliseconds this test took.
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(
      71 * 3600,
    );

    const acknowledgment = (await t.client.sendDirect("answers", {
      token: body.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string; body: unknown } };
    expect(acknowledgment.status).toBe("resumed");
    expect(acknowledgment.outcome.body).toEqual({ paid: true });
  });

  /**
   * @case A route whose exchange never parks is unaffected by the 202 path
   * @preconditions The same http() route, taking a .choice() branch that does not suspend
   * @expectedResult 200 with the route's declared output, so the acknowledgment rendering never leaks into ordinary responses
   */
  test("http() still answers 200 when the exchange does not park", async () => {
    let port = 0;
    t = await testContext()
      .on(
        "plugin:http:server:listening" as EventName,
        ((payload: { details: { port: number } }) => {
          port = payload.details.port;
        }) as never,
      )
      .with({ ...suspending(), http: { port: 0 } } as CraftConfig &
        HttpPluginOptions)
      .routes([
        craft()
          .id("payout")
          .from<{ amountCents: number }>(
            http({ path: "/payouts", method: "POST" }),
          )
          .choice(
            when<{ amountCents: number }>(
              (ex) => ex.body.amountCents >= 50_000,
              (b) => b.suspend({ expect: Approval }),
            ),
            otherwise((b) => b),
          )
          .transform(() => ({ paid: true }))
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const response = await fetch(`http://127.0.0.1:${port}/payouts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountCents: 100 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paid: true });
  });

  /**
   * @case A mail-born exchange is continued by an answer from a different transport
   * @preconditions A mail-shaped source parks the exchange; an http() ingress route ending in .resume() receives the answer
   * @expectedResult The continuation runs with the mail envelope intact and the answer in place, without the original source taking any part in execution two
   */
  test("a mail-born exchange resumes from an http ingress", async () => {
    let port = 0;
    const continued: Array<{ from: unknown; approved: boolean }> = [];
    const parked: string[] = [];

    t = await testContext()
      .on(
        "plugin:http:server:listening" as EventName,
        ((payload: { details: { port: number } }) => {
          port = payload.details.port;
        }) as never,
      )
      .with({ ...suspending(), http: { port: 0 } } as CraftConfig &
        HttpPluginOptions)
      .routes([
        craft()
          .id("expense-approval")
          .from(
            mailbox({
              from: "employee@acme.test",
              subject: "Expense claim",
              text: "Taxi to the airport, 84 EUR",
            }),
          )
          // The notification step: mints the token BEFORE the park, which is
          // what the approver's link would carry.
          .tap((ex) => {
            parked.push(ex.suspension.token);
          })
          .suspend({ expect: Approval })
          .tap((ex) => {
            continued.push({
              from: ex.headers["routecraft.mail.from"],
              approved: ex.suspension.result.approved,
            });
          })
          .to(noop()),
        craft()
          .id("approve")
          .from(http({ path: "/approve", method: "POST" }))
          .resume((ex) => {
            const body = ex.body as { token: string; verdict: string };
            return {
              token: body.token,
              result: { approved: body.verdict === "yes" },
            };
          })
          .transform(() => ({ recorded: true }))
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();
    await t.drain();

    expect(parked).toHaveLength(1);

    const response = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: parked[0], verdict: "yes" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: true });
    expect(continued).toEqual([{ from: "employee@acme.test", approved: true }]);
  });

  /**
   * @case A queue-shaped source acks a suspended delivery
   * @preconditions A source that acks when the handler resolves and nacks when it rejects
   * @expectedResult The delivery is acked: the work is parked in the suspension store, so a redelivery would ask the approver a second time
   */
  test("a queue source acks on suspend rather than nacking", async () => {
    const settled: Array<"ack" | "nack"> = [];
    t = await testContext()
      .with(suspending())
      .routes([
        craft()
          .id("queued")
          .from(queueSource({ amountCents: 90_000 }, settled))
          .suspend({ expect: Approval })
          .to(noop()),
      ])
      .build();

    await t.ctx.start();
    await t.drain();

    expect(settled).toEqual(["ack"]);
  });
});
