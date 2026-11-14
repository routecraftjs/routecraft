import { afterEach, describe, expect, test } from "bun:test";
import {
  CONTINUATIONS,
  MemoryDeferralStore,
  OperationType,
  applicationState,
  definePlugin,
  defineProject,
  deferralOf,
  direct,
  rcError,
  step,
  type DeferralRuntime,
  type DeferralStore,
  type PluginContext,
  type ResumeAcknowledgment,
  type ResumeTokenPayload,
  type ResumeTokenSigning,
} from "@routecraft/routecraft";
import {
  asDeferred,
  deferralStoreConformance,
  spy,
  testContext,
  type TestContext,
} from "@routecraft/testing";

const WHEN = new Date("2026-03-01T08:00:00.000Z");
const BYTES = new Uint8Array([1, 2, 3]);

interface Answer {
  readonly approved: boolean;
}

/** A Standard Schema written by hand, as a package with no schema library would. */
const AnswerSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "acme",
    validate: (value: unknown) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { approved?: unknown }).approved === "boolean"
        ? { value: value as Answer }
        : { issues: [{ message: "approved must be a boolean" }] },
  },
};

interface DoorRequest {
  readonly token: string;
  readonly answer: unknown;
}

const hosts = applicationState<PluginContext>();
let holdRuns = 0;

const approvals = definePlugin({
  id: "acme.approvals",
  requires: [CONTINUATIONS],
  bind(c) {
    hosts.set(c.application, c);
  },
  steps: {
    hold: () =>
      step<unknown, { held: unknown; answer: unknown }>(
        (_exchange, ctx) => {
          holdRuns += 1;
          const revived = ctx.defer.revived;
          if (revived)
            return { held: revived.stepState, answer: revived.input };
          return ctx.defer({ stepState: { when: WHEN, bytes: BYTES } });
        },
        { defers: { revival: "this-step" } },
      ),
    wait: () =>
      step<unknown, unknown>((_exchange, ctx) => ctx.defer({ ttl: "1h" }), {
        defers: { revival: "next-step", input: AnswerSchema },
      }),
    door: () =>
      step<DoorRequest, ResumeAcknowledgment>(
        (exchange, ctx) =>
          ctx.resume({
            token: exchange.body.token,
            input: exchange.body.answer,
          }),
        { resumes: true },
      ),
    namingDoor: () =>
      step<DoorRequest, ResumeAcknowledgment>(
        (exchange, ctx) =>
          ctx.resume({
            token: exchange.body.token,
            input: exchange.body.answer,
            resumedBy: { subject: "mallory@acme.test" },
          } as never),
        { resumes: true },
      ),
    remember: () =>
      step<unknown, unknown>(
        async (exchange, ctx) => {
          const revived = ctx.defer.revived;
          if (revived) return { later: revived.stepState, with: revived.input };
          const { deferralId } = await ctx.defer.aside({
            stepState: (id) => ({ remembered: id }),
          });
          return { parked: deferralId, body: exchange.body };
        },
        { defers: { revival: "this-step" } },
      ),
    reviveLater: () =>
      step<{ id: string; input: unknown }, ResumeAcknowledgment>((exchange) => {
        const c = hosts.of(exchange)!;
        return c.continuations.resume({
          token: c.continuations.mintToken(exchange.body.id),
          input: exchange.body.input,
        });
      }),
    forged: () =>
      step<unknown, unknown>({
        operation: OperationType.PROCESS,
        adapter: { adapterId: "acme.forged" },
        execute: async (exchange: unknown) => ({
          kind: "defer",
          exchange,
          request: { site: { position: 0, continuation: [] } },
        }),
      } as never),
  },
});

/**
 * A signer written against the port's type. The keyed checksum stands in
 * for a real MAC, which a suite that imports nothing but the published
 * packages cannot reach synchronously.
 */
function acmeSigner(secret: string): ResumeTokenSigning {
  const sign = (body: string): string => {
    let hash = 0x811c9dc5;
    for (const char of `${secret}.${body}.${secret}`) {
      hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
    }
    return hash.toString(36);
  };
  return {
    source: "config",
    mint(id, now = new Date(), sub) {
      const payload: ResumeTokenPayload = {
        id,
        iat: now.getTime(),
        ...(sub !== undefined ? { sub } : {}),
      };
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return `${body}.${sign(body)}`;
    },
    verify(token) {
      const [body = "", signature = ""] = token.split(".");
      if (body === "" || sign(body) !== signature) {
        throw rcError("RC5041", undefined, {
          message: "The resume token is not one this application minted.",
        });
      }
      return JSON.parse(
        Buffer.from(body, "base64url").toString("utf8"),
      ) as ResumeTokenPayload;
    },
  };
}

/** A store an outsider owns: every call is its own, the shipped one keeps the rows. */
function acmeStore(): DeferralStore {
  const rows = new MemoryDeferralStore();
  return {
    create: (record) => rows.create(record),
    get: (id) => rows.get(id),
    markResumed: (...args) => rows.markResumed(...args),
    recordContinuation: (...args) => rows.recordContinuation(...args),
    claimExpiry: (...args) => rows.claimExpiry(...args),
    renewClaim: (...args) => rows.renewClaim(...args),
    markExpired: (...args) => rows.markExpired(...args),
    markDenied: (...args) => rows.markDenied(...args),
    releaseClaims: (...args) => rows.releaseClaims(...args),
    findExpired: (...args) => rows.findExpired(...args),
    resumedWithoutContinuation: (...args) =>
      rows.resumedWithoutContinuation(...args),
    list: (...args) => rows.list(...args),
    pending: () => rows.pending(),
    purgeSettled: (...args) => rows.purgeSettled(...args),
    replaceStepState: (...args) => rows.replaceStepState(...args),
    close: () => rows.close(),
  };
}

const acmeContinuations = definePlugin({
  id: "acme.continuations",
  provides: [CONTINUATIONS],
  bind(c) {
    const runtime: DeferralRuntime = {
      store: acmeStore(),
      signer: acmeSigner("acme-continuations-secret"),
      expiryLeaseMs: 60_000,
    };
    c.provide(CONTINUATIONS, runtime);
    c.onDispose(() => runtime.store.close());
  },
});

deferralStoreConformance("an outsider's store", () => acmeStore(), {
  describe,
  test,
  afterEach,
  expect,
});

describe("outsider: steps that defer and resume, on the published entry", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
    holdRuns = 0;
  });

  const project = defineProject({ plugins: [approvals] });
  const shipped = { ...project.config, deferral: {} };

  /**
   * @case A third-party step defers itself and is run again with what it stored
   * @preconditions A step declaring a "this-step" deferral whose stepState holds a Date and a Uint8Array; a third-party resume door
   * @expectedResult The first run answers deferred; the door's resume runs the step again with the Date and the bytes intact and the door's input, and the rest of the route runs once
   */
  test("acme.hold defers and is revived with its state", async () => {
    const sink = spy();
    t = await testContext()
      .with(shipped)
      .routes([
        project.craft().id("held").from(direct()).hold().to(sink),
        project.craft().id("door").from(direct<DoorRequest>()).door(),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("held", "work"));
    expect(sink.received).toHaveLength(0);

    const ack = (await t.client.sendDirect("door", {
      token: deferred.token,
      answer: { approved: true },
    })) as ResumeAcknowledgment;

    expect(ack.status).toBe("resumed");
    expect(sink.received).toHaveLength(1);
    const body = sink.received[0]!.body as {
      held: { when: unknown; bytes: unknown };
      answer: unknown;
    };
    expect(body.held.when).toEqual(WHEN);
    expect(body.held.bytes).toEqual(BYTES);
    expect(body.answer).toEqual({ approved: true });
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A deferring step under a retry is not run again by the retry
   * @preconditions The same step with a step-scope .retry() ahead of it
   * @expectedResult The step runs once and the exchange is deferred: a deferral is an outcome, not a failure to retry
   */
  test("acme.hold under .retry() defers once", async () => {
    t = await testContext()
      .with(shipped)
      .routes([
        project
          .craft()
          .id("held")
          .from(direct())
          .retry({ maxAttempts: 3 })
          .hold(),
      ])
      .build();
    await t.startAndWaitReady();

    asDeferred(await t.client.sendDirect("held", "work"));

    expect(holdRuns).toBe(1);
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A third-party step parks the exchange for the next step, with a declared input
   * @preconditions A step declaring a "next-step" deferral with a hand-written Standard Schema; a third-party door
   * @expectedResult An answer the schema refuses is RC5049 and leaves the exchange parked; a valid answer resumes at the next step, which reads it from the deferral facet
   */
  test("acme.wait validates the answer and resumes at the next step", async () => {
    const seen: unknown[] = [];
    t = await testContext()
      .with(shipped)
      .routes([
        project
          .craft()
          .id("waiting")
          .from(direct())
          .wait()
          .process((exchange) => {
            seen.push(deferralOf(exchange).input);
            return exchange;
          }),
        project.craft().id("door").from(direct<DoorRequest>()).door(),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("waiting", "work"));

    await expect(
      t.client.sendDirect("door", { token: deferred.token, answer: "yes" }),
    ).rejects.toMatchObject({ rc: "RC5049" });
    expect(seen).toHaveLength(0);

    await t.client.sendDirect("door", {
      token: deferred.token,
      answer: { approved: true },
    });
    expect(seen).toEqual([{ approved: true }]);
  });

  /**
   * @case The resuming party is the principal the door's route verified
   * @preconditions A door route that authenticates its caller; a second door whose step names a resumedBy of its own
   * @expectedResult The revived exchange reports the authenticated subject as resumedBy; the door that names one is refused with RC5003 and resumes nothing
   */
  test("acme.door records its own principal and cannot name another", async () => {
    const resumedBy: unknown[] = [];
    const approver = () => ({
      scheme: "test",
      subject: "approver@acme.test",
      issuer: "https://idp.test",
    });
    t = await testContext()
      .with(shipped)
      .routes([
        project
          .craft()
          .id("waiting")
          .from(direct())
          .wait()
          .process((exchange) => {
            resumedBy.push(deferralOf(exchange).resumedBy?.subject);
            return exchange;
          }),
        project
          .craft()
          .id("naming")
          .from(direct<DoorRequest>())
          .authenticate(approver)
          .namingDoor(),
        project
          .craft()
          .id("door")
          .from(direct<DoorRequest>())
          .authenticate(approver)
          .door(),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("waiting", "work"));
    const answer = { token: deferred.token, answer: { approved: true } };

    await expect(t.client.sendDirect("naming", answer)).rejects.toMatchObject({
      rc: "RC5003",
    });
    expect(resumedBy).toHaveLength(0);

    await t.client.sendDirect("door", answer);
    expect(resumedBy).toEqual(["approver@acme.test"]);
  });

  /**
   * @case A third-party step stores a continuation aside and its plugin revives it later
   * @preconditions A "this-step" step that calls ctx.defer.aside and lets the exchange complete; the plugin mints a token for the record and resumes it from another route
   * @expectedResult The first exchange completes with the record's id and reaches the sink; the revival runs the step again with the state it stored, and that run reaches the sink too
   */
  test("acme.aside completes now and is revived by its plugin", async () => {
    const sink = spy();
    t = await testContext()
      .with(shipped)
      .routes([
        project.craft().id("noted").from(direct()).remember().to(sink),
        project
          .craft()
          .id("later")
          .from(direct<{ id: string; input: unknown }>())
          .reviveLater(),
      ])
      .build();
    await t.startAndWaitReady();

    const first = (await t.client.sendDirect("noted", "work")) as {
      parked: string;
    };
    expect(sink.received).toHaveLength(1);

    await t.client.sendDirect("later", { id: first.parked, input: "nudge" });

    expect(sink.received).toHaveLength(2);
    expect(sink.received[1]!.body).toEqual({
      later: { remembered: first.parked },
      with: "nudge",
    });
    expect(t.errors).toHaveLength(0);
  });

  /**
   * @case A step that builds a defer outcome by hand is refused
   * @preconditions A raw step returning { kind: "defer" } with a request it made up
   * @expectedResult RC5032: the kernel defers only on a ticket ctx.defer issued, so nothing is parked
   */
  test("a hand-built defer outcome is RC5032", async () => {
    t = await testContext()
      .with(shipped)
      .routes([project.craft().id("forging").from(direct()).forged()])
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("forging", "work")).rejects.toMatchObject({
      rc: "RC5032",
    });
    expect(await t.ctx.continuations.list({ limit: 10 })).toHaveLength(0);
  });

  /**
   * @case An outsider's plugin provides the continuations port
   * @preconditions No deferral configuration; a plugin providing its own store and signer under CONTINUATIONS, with the third-party steps and door on top
   * @expectedResult The exchange parks in the outsider's store and resumes with a token the outsider's signer minted; a token signed with another secret is RC5041
   */
  test("acme.continuations replaces the store and the signer", async () => {
    const own = defineProject({ plugins: [acmeContinuations, approvals] });
    const sink = spy();
    t = await testContext()
      .with(own.config)
      .routes([
        own.craft().id("waiting").from(direct()).wait().to(sink),
        own.craft().id("door").from(direct<DoorRequest>()).door(),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(await t.client.sendDirect("waiting", "work"));
    expect(
      acmeSigner("acme-continuations-secret").verify(deferred.token).id,
    ).toBe(deferred.deferralId);

    await expect(
      t.client.sendDirect("door", {
        token: acmeSigner("another-secret").mint(deferred.deferralId),
        answer: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5041" });
    expect(sink.received).toHaveLength(0);

    await t.client.sendDirect("door", {
      token: deferred.token,
      answer: { approved: true },
    });
    expect(sink.received).toHaveLength(1);
  });
});
