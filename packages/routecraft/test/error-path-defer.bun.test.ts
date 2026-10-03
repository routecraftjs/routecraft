import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  HeadersKeys,
  MemoryDeferralStore,
  authenticate,
  craft,
  direct,
  isDeferred,
  noop,
  recovery,
  isRecovery,
  type CraftConfig,
  type Deferred,
  type Exchange,
  type Principal,
} from "../src/index.ts";
import { insufficientAuthorityOf } from "../src/auth/authorize.ts";
import { isRestored } from "../src/auth/restored.ts";
import { asDeferred, storeWith } from "./helpers/deferral.ts";

const SECRET = "error-path-defer-test-secret-0123456789";

const Decision = z.object({ approved: z.boolean() });

/** Config sharing one store, so a test can read the record back. */
function shared(store: MemoryDeferralStore): CraftConfig {
  return { deferral: { store, secret: SECRET } };
}

/** Mints the principal the ingress body names, standing in for a verifier. */
function asWho(ex: Exchange): Principal | undefined {
  const body = ex.body as { who?: string; scopes?: string[] } | null;
  return body?.who
    ? authenticate({
        subject: body.who,
        ...(body.scopes ? { scopes: body.scopes } : {}),
      })
    : undefined;
}

/** The mapper the resume doors in this file use. */
function payloadFrom(ex: Exchange) {
  const body = ex.body as { token: string; result?: unknown };
  return {
    token: body.token,
    result: "result" in body ? body.result : { approved: true },
  };
}

describe("recovery.defer: parking an exchange from the error path", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case The directive is branded like its siblings and the guard accepts it
   * @preconditions recovery.defer built with a bare request
   * @expectedResult isRecovery accepts it and reports kind "defer"; a look-alike carrying no request is not a directive
   */
  test("recovery.defer is a branded directive isRecovery accepts", () => {
    const directive = recovery.defer({ ttl: "1h" });

    expect(isRecovery(directive)).toBe(true);
    expect(directive.kind).toBe("defer");
    expect(isRecovery({ kind: "defer" })).toBe(false);
    // Brand plus shape: a hand-built object reusing the brand but carrying no
    // request must keep its plain-recovery-body meaning rather than parking
    // an exchange with nothing to park it on.
    const branded = { ...recovery.drop("x"), kind: "defer" } as unknown;
    expect(isRecovery(branded)).toBe(false);
  });

  /**
   * @case A route-scope handler parks a mid-pipeline failure at the failing step
   * @preconditions A three-step route whose middle step throws, and an .error() answering recovery.defer
   * @expectedResult Execution one answers with the Deferred acknowledgment, the deferred event carries the failing step's position, and the resume re-runs the failing step without re-running the step before it
   */
  test("a mid-pipeline failure parks at the failing step, re-entrantly", async () => {
    const store = new MemoryDeferralStore();
    const ran: string[] = [];
    let failOnce = true;
    const positions: number[] = [];

    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("work")
          .error(() => recovery.defer({ ttl: "1h" }))
          .from(direct())
          .transform((body) => {
            ran.push("first");
            return body;
          })
          .transform((body) => {
            ran.push("second");
            if (failOnce) {
              failOnce = false;
              throw new Error("needs a human");
            }
            return body;
          })
          .transform((body) => {
            ran.push("third");
            return body;
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(payloadFrom),
      ])
      .build();
    t.ctx.on("route:exchange:deferred", ({ details }) => {
      positions.push(details.position);
    });
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("work", {}));
    expect(ran).toEqual(["first", "second"]);
    // Position 1 in the pre-order walk: the second of the three transforms.
    expect(positions).toEqual([1]);

    const ack = (await t.client.sendDirect("answers", {
      token: deferred.token,
    })) as { status: string };

    expect(ack.status).toBe("resumed");
    // The failing step runs again (it failed part way through its own work)
    // and the step before it does not, which is what re-entrant means.
    expect(ran).toEqual(["first", "second", "second", "third"]);
  });

  /**
   * @case A pre-from failure parks as an admission, and its resume re-runs authorize
   * @preconditions A route gated by .authorize() refusing a caller for a missing scope, parked by an .error() handler
   * @expectedResult The park is recorded as an admission; resuming it through a door with no elevate is refused at .authorize() with RC5043, non-destructively
   */
  test("a pre-from failure parks at position 0 as an admission, and a door with no elevate is refused RC5043", async () => {
    const store = new MemoryDeferralStore();
    let bodyRan = false;

    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("archive")
          .authorize({ scopes: ["sessions:manage"] })
          // Conditional, as a real handler is: a handler that parks every
          // failure would park the resume's own RC5043 too, and the loop
          // that closes is the scope loop rather than this one.
          .error((error) =>
            insufficientAuthorityOf(error)
              ? recovery.defer({ ttl: "1h" })
              : recovery.rethrow(),
          )
          .from(direct())
          .transform((body) => {
            bodyRan = true;
            return body;
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(payloadFrom),
      ])
      .build();
    await t.startAndWaitReady();

    // Delivered by the transport, which is where a route-scope .authorize()
    // reads it: chain position #2 runs before any pipeline step, so a
    // mid-pipeline .authenticate() would be too late to be seen.
    const deferred = asDeferred(
      await t.client.sendDirect(
        "archive",
        {},
        {
          [HeadersKeys.AUTH_PRINCIPAL]: authenticate({
            subject: "agent",
            scopes: ["sessions:manage:owned"],
          }),
        },
      ),
    );
    expect(bodyRan).toBe(false);

    const record = await store.get(deferred.deferralId);
    expect(record?.errorPath?.origin).toBe("admission");
    // The framework recorded what the refusal named, which is the bound a
    // lend is later held to.
    expect(record?.errorPath?.refusedScopes).toEqual(["sessions:manage"]);

    // No elevate on the door, so the continuation carries the RESTORED
    // principal into the .authorize() that now runs again. RC5043 by design:
    // a shape read off disk is not a credential, which is what makes such a
    // park completable only by a door that elevates.
    const ack = (await t.client.sendDirect("answers", {
      token: deferred.token,
    })) as { continuation: { status: string; error?: { rc?: string } } };

    expect(ack.continuation.status).toBe("failed");
    expect(ack.continuation.error?.rc).toBe("RC5043");
    // Non-destructive for the route's own work: the body still never ran.
    expect(bodyRan).toBe(false);
    const settled = await store.get(deferred.deferralId);
    expect(settled?.continuation?.error?.rc).toBe("RC5043");
  });

  /**
   * @case An error-path park accepts a schema descriptively and never validates at resume
   * @preconditions A park declaring a schema, resumed with a payload that violates it
   * @expectedResult The acknowledgment renders the schema, the resume is accepted rather than refused with RC5049, and the door is left as the validator
   */
  test("schema is folded into the acknowledgment but never validated at resume", async () => {
    const store = new MemoryDeferralStore();
    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("work")
          .error(() => recovery.defer({ schema: Decision, ttl: "1h" }))
          .from(direct())
          .transform(() => {
            throw new Error("needs a human");
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(payloadFrom),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("work", {}));
    // Rendered descriptively, the same as a re-entrant site's.
    expect(deferred.schema).toBeDefined();

    // Violates the declared schema, and is accepted anyway: the live schema
    // lives in handler code and cannot be read back off the route, so RC5049
    // has nothing to run against and the door is the validator.
    const ack = (await t.client.sendDirect("answers", {
      token: deferred.token,
      result: { approved: "not a boolean" },
    })) as { status: string };
    expect(ack.status).toBe("resumed");
  });

  /**
   * @case notify runs after the record and before the event, with the caller's own acknowledgment
   * @preconditions A park whose notify records what it was handed and when
   * @expectedResult notify sees the same deferralId and token the caller receives, the record already exists when it runs, and the deferred event has not fired yet
   */
  test("notify commits after the record and before the event, with the caller's acknowledgment", async () => {
    const store = new MemoryDeferralStore();
    const order: string[] = [];
    let handed: Deferred | undefined;
    let recordExistedAtNotify = false;

    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("work")
          .error(() =>
            recovery.defer({
              ttl: "1h",
              notify: async (ack) => {
                handed = ack;
                order.push("notify");
                recordExistedAtNotify =
                  (await store.get(ack.deferralId)) !== undefined;
              },
            }),
          )
          .from(direct())
          .transform(() => {
            throw new Error("needs a human");
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(payloadFrom),
      ])
      .build();
    t.ctx.on("route:exchange:deferred", () => {
      order.push("event");
    });
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("work", {}));

    // After the record, so nobody is handed a token for a park that never
    // committed; before the event, so a notify that throws denies the record
    // without an announced park to contradict the failure that follows.
    expect(order).toEqual(["notify", "event"]);
    expect(recordExistedAtNotify).toBe(true);
    expect(handed?.deferralId).toBe(deferred.deferralId);
    expect(handed?.token).toBe(deferred.token);

    // The token it was handed verifies against that record, which is the
    // whole point of handing out the acknowledgment rather than an id.
    const ack = (await t.client.sendDirect("answers", {
      token: handed!.token,
    })) as { status: string };
    expect(ack.status).toBe("resumed");
  });

  /**
   * @case A park the framework refuses sends nothing external
   * @preconditions A handler answering recovery.defer with notify, for a step inside a .split() fan-out
   * @expectedResult The park is refused with RC5051 and notify never runs, so no token exists for a record that never will
   */
  test("a park refused with RC5051 runs no notify", async () => {
    const store = new MemoryDeferralStore();
    let notified = 0;

    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("fanned")
          .error(() =>
            recovery.defer({
              ttl: "1h",
              notify: () => {
                notified += 1;
              },
            }),
          )
          .from(direct())
          .split()
          .transform(() => {
            throw new Error("needs a human");
          })
          .aggregate()
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const result = await t.client
      .sendDirect("fanned", [1])
      .then(() => undefined)
      .catch((err: unknown) => err);

    expect(isDeferred(result)).toBe(false);
    expect(notified).toBe(0);
    // Nothing was written, so nothing can be resumed.
    expect(await store.get(`${String(result)}`)).toBeUndefined();
  });

  /**
   * @case A notification that did not go out leaves no live link
   * @preconditions A park whose notify throws, its token captured before the throw
   * @expectedResult The record is denied claim-first so a replay of that token reads RC5050, and the run fails carrying the notify failure as cause
   */
  test("a notify that throws denies the record claim-first", async () => {
    const store = new MemoryDeferralStore();
    let issued: Deferred | undefined;

    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("work")
          .error(() =>
            recovery.defer({
              ttl: "1h",
              notify: (ack) => {
                issued = ack;
                throw new Error("the mail server said no");
              },
            }),
          )
          .from(direct())
          .transform(() => {
            throw new Error("needs a human");
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(payloadFrom),
      ])
      .build();
    await t.startAndWaitReady();

    const failure = await t.client
      .sendDirect("work", {})
      .then(() => undefined)
      .catch((err: unknown) => err as { rc?: string; cause?: unknown });

    expect(failure?.rc).toBe("RC5067");
    expect((failure?.cause as Error | undefined)?.message).toBe(
      "the mail server said no",
    );

    const denied = await store.get(issued!.deferralId);
    expect(denied?.outcome?.kind).toBe("denied");

    // A recipient who did receive the link before the send failed finds it
    // dead rather than live.
    await expect(
      t.client.sendDirect("answers", { token: issued!.token }),
    ).rejects.toThrow(/RC5050|denied/);
  });

  /**
   * @case A notify failure produces exactly one terminal event, not two
   * @preconditions A park whose notify throws, with every terminal event on the exchange recorded
   * @expectedResult Only route:exchange:failed fires; route:exchange:deferred does not, because the park it would claim is already denied
   */
  test("a failed notify does not announce a park it then denies", async () => {
    const store = new MemoryDeferralStore();
    const terminal: string[] = [];

    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("work")
          .error(() =>
            recovery.defer({
              ttl: "1h",
              notify: () => {
                throw new Error("the mail server said no");
              },
            }),
          )
          .from(direct())
          .transform(() => {
            throw new Error("needs a human");
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(payloadFrom),
      ])
      .build();
    t.ctx.on("route:exchange:deferred", () => {
      terminal.push("deferred");
    });
    t.ctx.on("route:exchange:failed", () => {
      terminal.push("failed");
    });
    t.ctx.on("route:exchange:completed", () => {
      terminal.push("completed");
    });
    t.ctx.on("route:exchange:dropped", () => {
      terminal.push("dropped");
    });
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("work", {})).rejects.toThrow();

    // Zero terminal events was one bug and two is the same contract broken
    // the other way: an operator seeing `deferred` would be looking at a
    // record RC5067 had already denied.
    expect(terminal).toEqual(["failed"]);
  });

  /**
   * @case An unsettled notify neither holds the step nor leaves a live link
   * @preconditions A route whose .timeout() elapses while notify never settles
   * @expectedResult The hook is abandoned at the route's deadline and the record is denied claim-first, exactly as a throw denies it
   */
  test("an unsettled notify is abandoned at the route's own bound", async () => {
    const store = new MemoryDeferralStore();
    let issued: Deferred | undefined;

    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("work")
          .error(() =>
            recovery.defer({
              ttl: "1h",
              // Never settles. Without a bound this would hold the step,
              // which holds drain(), and the caller would wait behind it.
              notify: (ack) =>
                new Promise<void>(() => {
                  issued = ack;
                  // The route's intake signal is the bound, so stopping
                  // intake is what releases the hook. Raised from inside the
                  // hook rather than on a timer so the test is deterministic.
                  t!.ctx.getRouteById("work")!.stop();
                }),
            }),
          )
          .from(direct())
          .transform(() => {
            throw new Error("needs a human");
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const failure = await t.client
      .sendDirect("work", {})
      .then(() => undefined)
      .catch((err: unknown) => err as { rc?: string });

    expect(failure?.rc).toBe("RC5067");
    // An abort is treated exactly as a throw: nobody was told, so no live
    // link survives.
    const denied = await store.get(issued!.deferralId);
    expect(denied?.outcome?.kind).toBe("denied");
  });

  /**
   * @case A forward from inside notify runs as the parked exchange did
   * @preconditions A notify forwarding to a direct() route, on an exchange carrying a live principal
   * @expectedResult The target sees the SAME principal object, so its brand state is the parked exchange's rather than a copy's
   */
  test("a forward from notify carries the parked principal by reference", async () => {
    const store = new MemoryDeferralStore();
    let parked: Principal | undefined;
    let seen: Principal | undefined;

    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("work")
          .error((_error, _exchange, forward) =>
            recovery.defer({
              ttl: "1h",
              // The handler forwards rather than sending on its own: the
              // notification is then a route like any other, and `forward`
              // carries the parked exchange's identity into it.
              notify: async (ack) => {
                await forward("send-mail" as never, { token: ack.token });
              },
            }),
          )
          .from(direct())
          .authenticate(asWho)
          .transform((_body, ex) => {
            parked = ex.principal;
            throw new Error("needs a human");
          })
          .to(noop()),
        craft()
          .id("send-mail")
          .from(direct())
          .transform((body, ex) => {
            seen = ex.principal;
            return body;
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await t.client.sendDirect("work", { who: "agent" });

    expect(parked).toBeDefined();
    // Identity, not equality: a copy would be structurally identical and
    // would silently have lost the live brand the WeakSet holds.
    expect(seen).toBe(parked!);
    expect(isRestored(seen)).toBe(false);
  });

  /**
   * @case A cancelled run refuses to park rather than leaving a live link
   * @preconditions A context stopping while a handler answers recovery.defer
   * @expectedResult The run fails with RC5054 and nothing was written, matching the defer outcome case
   */
  test("a cancelled run refuses to park with RC5054", async () => {
    const store = new MemoryDeferralStore();
    let notified = 0;

    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("work")
          .error(() => {
            // In-flight work is being abandoned by the time the directive
            // reaches the executor, which is the condition the refusal is
            // about: the caller is being told the run failed, so nothing may
            // stay resumable behind it.
            t!.ctx.getRouteById("work")!.stop();
            return recovery.defer({
              ttl: "1h",
              notify: () => {
                notified += 1;
              },
            });
          })
          .from(direct())
          .transform(() => {
            throw new Error("needs a human");
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const failure = await t.client
      .sendDirect("work", {})
      .then(() => undefined)
      .catch((err: unknown) => err as { rc?: string });

    expect(failure?.rc).toBe("RC5054");
    expect(notified).toBe(0);
  });

  /**
   * @case A store that fails the write is reported without a notification
   * @preconditions A store whose create throws, under a park declaring notify
   * @expectedResult The run fails and notify never runs, because the record it would name does not exist
   */
  test("a failed store write runs no notify", async () => {
    let notified = 0;
    const store = storeWith(new MemoryDeferralStore(), {
      create: () => Promise.reject(new Error("disk is full")),
    });

    t = await testContext()
      .with({ deferral: { store, secret: SECRET } })
      .routes([
        craft()
          .id("work")
          .error(() =>
            recovery.defer({
              ttl: "1h",
              notify: () => {
                notified += 1;
              },
            }),
          )
          .from(direct())
          .transform(() => {
            throw new Error("needs a human");
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("work", {})).rejects.toThrow();
    expect(notified).toBe(0);
  });

  /**
   * @case A failure raised by the framework's own chain positions, after admission, is refused rather than replayed
   * @preconditions A route-scope .timeout() elapsing after two steps have already run, with a handler answering recovery.defer
   * @expectedResult RC5051 and nothing written, rather than an admission park that would re-run both completed steps on resume
   */
  test("a post-admission failure with no site is refused, not parked at position 0", async () => {
    const store = new MemoryDeferralStore();
    const ran: string[] = [];

    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("slow")
          .timeout(40)
          .error(() => recovery.defer({ ttl: "1h" }))
          .from(direct())
          .transform((body) => {
            ran.push("first");
            return body;
          })
          .transform(async (body) => {
            ran.push("second");
            await new Promise((resolve) => setTimeout(resolve, 200));
            return body;
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const failure = await t.client
      .sendDirect("slow", {})
      .then(() => undefined)
      .catch((err: unknown) => err as { rc?: string });

    // The deadline is thrown by a synthetic segment carrier the defer-site
    // walk never visits, and two steps had already completed. Parking it as
    // an admission would store position 0 with the whole body as the
    // continuation and charge both steps' side effects again on resume.
    expect(ran).toEqual(["first", "second"]);
    expect(failure?.rc).toBe("RC5051");
    expect(await store.list({ limit: 10, state: "waiting" })).toHaveLength(0);
  });

  /**
   * @case A step failure INSIDE a route-scope segment still resolves to the real step
   * @preconditions A route-scope .retry() around a pipeline whose second step throws
   * @expectedResult The park lands at the failing step re-entrantly rather than being refused, because the nested run noted the real step before rethrowing
   */
  test("a step failure inside a resilience segment still finds its own position", async () => {
    const store = new MemoryDeferralStore();
    const ran: string[] = [];

    t = await testContext()
      .with(shared(store))
      .routes([
        craft()
          .id("retried")
          .retry({ maxAttempts: 2, backoff: 1 })
          .error(() => recovery.defer({ ttl: "1h" }))
          .from(direct())
          .transform((body) => {
            ran.push("first");
            return body;
          })
          .transform(() => {
            throw new Error("needs a human");
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("retried", {}));
    const record = await store.get(deferred.deferralId);

    // Resolved to the failing step itself, not to the retry carrier the
    // outer loop was holding, and not downgraded to an admission park.
    expect(record?.errorPath?.origin).toBe("step");
    expect(record?.position).toBe(1);
    // Both attempts ran the first step; what matters is that the park landed
    // at the second one rather than at position 0.
    expect(ran).toEqual(["first", "first"]);
  });

  /**
   * @case A step-scope .error() wrapper cannot park, and says why
   * @preconditions An .error() attached after .from(), answering recovery.defer
   * @expectedResult RC5051 naming the reason, rather than a park at a position the walk never addressed
   */
  test("a step-scope .error() wrapper refuses recovery.defer with a named reason", async () => {
    t = await testContext()
      .with({ deferral: { store: new MemoryDeferralStore(), secret: SECRET } })
      .routes([
        craft()
          .id("work")
          .from(direct())
          .error(() => recovery.defer({ ttl: "1h" }))
          .transform(() => {
            throw new Error("needs a human");
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("work", {})).rejects.toThrow(
      /step-scope \.error\(\) handler that answered with recovery\.defer\(\)/,
    );
  });

  /**
   * @case The two deferral hooks state their opposite commit orderings and name each other
   * @preconditions The shipped source of the directive and of deferAside
   * @expectedResult Each JSDoc states its own ordering and points at the other, so the two can never be read as the same hook
   */
  test("notify and deferAside's announce each document their ordering and name the other", async () => {
    const directive = await readFile(
      new URL("../src/recovery.ts", import.meta.url),
      "utf8",
    );
    const aside = await readFile(
      new URL("../src/deferral/defer.ts", import.meta.url),
      "utf8",
    );

    // The directive's hook: after its write, and it names announce.
    expect(directive).toMatch(/notify\?:/);
    expect(directive).toMatch(/AFTER the record is written/);
    expect(directive).toMatch(/OPPOSITE of `deferAside`'s `announce`/);

    // The aside's hook: before its write, and it names notify.
    expect(aside).toMatch(/BEFORE the record is written/);
    expect(aside).toMatch(/`notify` hook/);
  });
});
