import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  HeadersKeys,
  MemoryDeferralStore,
  authenticate,
  craft,
  delegate,
  direct,
  noop,
  recovery,
  type CraftConfig,
  type Exchange,
  type Principal,
} from "../src/index.ts";
import { insufficientAuthorityOf } from "../src/auth/authorize.ts";
import { isAuthentic } from "../src/auth/authentic.ts";
import { isRestored } from "../src/auth/restored.ts";
import { asDeferred } from "./helpers/deferral.ts";

const SECRET = "resume-elevate-test-secret-0123456789";

/** The scope the gate reads and the agent does not hold. */
const LENT = "sessions:manage";
/** What the agent holds on its own. */
const HELD = "sessions:manage:owned";

function shared(store: MemoryDeferralStore): CraftConfig {
  return { deferral: { store, secret: SECRET } };
}

/**
 * The delegated identity the named consumer parks with: a member as subject,
 * the agent acting for them, and the gate reading the EFFECTIVE ring.
 */
function agentActingFor(actorScopes: string[]): Principal {
  return delegate(
    authenticate({ subject: "member-1", email: "member@acme.test" }),
    { subject: "agent-1", roles: ["agent"], scopes: actorScopes },
  );
}

/** The mapper every door in this file uses. */
function payloadFrom(ex: Exchange) {
  const body = ex.body as { token: string; result?: unknown };
  return {
    token: body.token,
    result: "result" in body ? body.result : { approved: true },
  };
}

/**
 * A route that refuses for a missing scope on the effective ring, parks the
 * refusal, and records what ran.
 */
function archiveRoute(ran: { body: number }) {
  return (
    craft()
      .id("archive")
      // `actor: "any"` because the default refuses delegation outright, and
      // this whole case is an agent acting for a member.
      .authorize({ scopes: [LENT], effective: true, actor: "any" })
      .error((error) =>
        insufficientAuthorityOf(error)
          ? recovery.defer({ ttl: "4h" })
          : recovery.rethrow(),
      )
      .from(direct())
      .transform((body) => {
        ran.body += 1;
        return body;
      })
      .to(noop())
  );
}

/** Park an exchange by calling the route with an under-scoped identity. */
async function park(t: TestContext) {
  return asDeferred(
    await t.client.sendDirect(
      "archive",
      {},
      { [HeadersKeys.AUTH_PRINCIPAL]: agentActingFor([HELD]) },
    ),
  );
}

describe("the resume elevate hook", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A lend on the actor's ring satisfies the gate that refused it
   * @preconditions A park raised by an effective-ring gate, resumed through a door that re-mints with the missing scope on the actor
   * @expectedResult The continuation re-runs .authorize(), passes, and the route body finally runs
   */
  test("an elevated continuation re-runs authorize and passes", async () => {
    const store = new MemoryDeferralStore();
    const ran = { body: 0 };

    t = await testContext()
      .with(shared(store))
      .routes([
        archiveRoute(ran),
        craft()
          .id("answers")
          .from(direct())
          .resume(payloadFrom, {
            elevate: () => agentActingFor([HELD, LENT]),
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = await park(t);
    expect(ran.body).toBe(0);

    const ack = (await t.client.sendDirect("answers", {
      token: deferred.token,
    })) as { continuation: { status: string } };

    expect(ack.continuation.status).toBe("completed");
    expect(ran.body).toBe(1);
  });

  /**
   * @case A door with no elevate behaves exactly as it did before the hook existed
   * @preconditions The same park, resumed through a door declaring only a mapper
   * @expectedResult The continuation carries the restored principal and is refused at .authorize() with RC5043
   */
  test("a door with no elevate carries the restored principal", async () => {
    const store = new MemoryDeferralStore();
    const ran = { body: 0 };

    t = await testContext()
      .with(shared(store))
      .routes([
        archiveRoute(ran),
        craft().id("answers").from(direct()).resume(payloadFrom),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = await park(t);
    const ack = (await t.client.sendDirect("answers", {
      token: deferred.token,
    })) as { continuation: { status: string; error?: { rc?: string } } };

    expect(ack.continuation.status).toBe("failed");
    expect(ack.continuation.error?.rc).toBe("RC5043");
    expect(ran.body).toBe(0);
  });

  /**
   * @case A lend the refusal never named is refused, non-destructively
   * @preconditions A door re-minting with a scope outside the recorded bound
   * @expectedResult RC5056, the record is left exactly as it was found, and the rightful lend then works
   */
  test("a lend wider than the recorded refusal is RC5056", async () => {
    const store = new MemoryDeferralStore();
    const ran = { body: 0 };
    let wide = true;

    t = await testContext()
      .with(shared(store))
      .routes([
        archiveRoute(ran),
        craft()
          .id("answers")
          .from(direct())
          .resume(payloadFrom, {
            elevate: () =>
              wide
                ? agentActingFor([HELD, LENT, "billing:write"])
                : agentActingFor([HELD, LENT]),
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = await park(t);

    await expect(
      t.client.sendDirect("answers", { token: deferred.token }),
    ).rejects.toThrow(/elevate hook refused/);

    // Non-destructive: the rightful principal's single-use link is intact.
    const untouched = await store.get(deferred.deferralId);
    expect(untouched?.state).toBe("waiting");
    expect(untouched?.claimedAt).toBeUndefined();
    expect(untouched?.outcome).toBeUndefined();

    wide = false;
    const ack = (await t.client.sendDirect("answers", {
      token: deferred.token,
    })) as { continuation: { status: string } };
    expect(ack.continuation.status).toBe("completed");
    expect(ran.body).toBe(1);
  });

  /**
   * @case Anything but scopes is compared structurally, and any difference is refused
   * @preconditions Doors re-minting with a changed subject, a changed role, and a changed actor identity
   * @expectedResult Each is RC5056 and none of them touches the record
   */
  test("a re-mint that changes anything other than scopes is refused", async () => {
    const store = new MemoryDeferralStore();
    const ran = { body: 0 };
    const substitutions: Array<() => Principal> = [
      // A different person entirely.
      () =>
        delegate(
          authenticate({ subject: "someone-else", email: "member@acme.test" }),
          { subject: "agent-1", roles: ["agent"], scopes: [HELD, LENT] },
        ),
      // The same person with a role the park never carried.
      () =>
        delegate(
          authenticate({
            subject: "member-1",
            email: "member@acme.test",
            roles: ["admin"],
          }),
          { subject: "agent-1", roles: ["agent"], scopes: [HELD, LENT] },
        ),
      // A different agent driving the same person's work.
      () =>
        delegate(
          authenticate({ subject: "member-1", email: "member@acme.test" }),
          { subject: "agent-2", roles: ["agent"], scopes: [HELD, LENT] },
        ),
    ];
    let which = 0;

    t = await testContext()
      .with(shared(store))
      .routes([
        archiveRoute(ran),
        craft()
          .id("answers")
          .from(direct())
          .resume(payloadFrom, { elevate: () => substitutions[which]!() }),
      ])
      .build();
    await t.startAndWaitReady();

    for (which = 0; which < substitutions.length; which++) {
      const deferred = await park(t);
      await expect(
        t.client.sendDirect("answers", { token: deferred.token }),
      ).rejects.toThrow(/elevate hook refused/);
      const untouched = await store.get(deferred.deferralId);
      expect(untouched?.state).toBe("waiting");
      expect(untouched?.outcome).toBeUndefined();
    }
    expect(ran.body).toBe(0);
  });

  /**
   * @case A principal that was not verified live is refused
   * @preconditions A door returning a plain object shaped like the parked principal
   * @expectedResult RC5056, because a re-mint is by construction a fresh verification
   */
  test("a principal that is not live-branded is refused", async () => {
    const store = new MemoryDeferralStore();
    const ran = { body: 0 };

    t = await testContext()
      .with(shared(store))
      .routes([
        archiveRoute(ran),
        craft()
          .id("answers")
          .from(direct())
          .resume(payloadFrom, {
            // Structurally correct and self-asserted: exactly the laundering
            // the live brand exists to refuse.
            elevate: ({ deferred }) =>
              ({
                ...(deferred as Principal),
                scopes: [HELD, LENT],
              }) as Principal,
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = await park(t);
    await expect(
      t.client.sendDirect("answers", { token: deferred.token }),
    ).rejects.toThrow(/elevate hook refused/);
    expect(ran.body).toBe(0);
  });

  /**
   * @case A restored principal is never re-branded authentic
   * @preconditions The hook handed the parked principal, which came out of the store
   * @expectedResult What the hook receives is restored and not authentic, so handing it straight back cannot pass
   */
  test("the parked principal reaches the hook restored, never authentic", async () => {
    const store = new MemoryDeferralStore();
    const ran = { body: 0 };
    let handed: Principal | undefined;

    t = await testContext()
      .with(shared(store))
      .routes([
        archiveRoute(ran),
        craft()
          .id("answers")
          .from(direct())
          .resume(payloadFrom, {
            elevate: ({ deferred }) => {
              handed = deferred;
              return agentActingFor([HELD, LENT]);
            },
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = await park(t);
    await t.client.sendDirect("answers", { token: deferred.token });

    expect(handed).toBeDefined();
    expect(isRestored(handed)).toBe(true);
    expect(isAuthentic(handed)).toBe(false);
  });

  /**
   * @case A hook that throws refuses without spending the link
   * @preconditions A door whose elevate throws because the roster moved under the park
   * @expectedResult RC5056 with the record untouched, which is refuse-never-reconcile
   */
  test("a hook that throws refuses non-destructively", async () => {
    const store = new MemoryDeferralStore();
    const ran = { body: 0 };

    t = await testContext()
      .with(shared(store))
      .routes([
        archiveRoute(ran),
        craft()
          .id("answers")
          .from(direct())
          .resume(payloadFrom, {
            elevate: () => {
              throw new Error("the person left the organisation");
            },
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = await park(t);
    const refusal = await t.client
      .sendDirect("answers", { token: deferred.token })
      .then(() => undefined)
      .catch((err: unknown) => err as { rc?: string; message?: string });

    expect(refusal?.rc).toBe("RC5056");
    // The hook's own cause never reaches the wire: a hook whose failures can
    // be told apart from outside is an oracle for what it knows.
    expect(refusal?.message).not.toContain("left the organisation");
    const untouched = await store.get(deferred.deferralId);
    expect(untouched?.state).toBe("waiting");
    expect(untouched?.outcome).toBeUndefined();
  });

  /**
   * @case elevate runs above the lifecycle disclosure, like authorize does
   * @preconditions An already-settled record presented again to a door whose elevate refuses
   * @expectedResult The refusal, not the "duplicate" acknowledgment a bearer holder would receive
   */
  test("a refused elevate learns nothing about the record's state", async () => {
    const store = new MemoryDeferralStore();
    const ran = { body: 0 };
    let refuse = false;

    t = await testContext()
      .with(shared(store))
      .routes([
        archiveRoute(ran),
        craft()
          .id("answers")
          .from(direct())
          .resume(payloadFrom, {
            elevate: () => {
              if (refuse) throw new Error("no");
              return agentActingFor([HELD, LENT]);
            },
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = await park(t);
    await t.client.sendDirect("answers", { token: deferred.token });

    // The record is settled now. A refused caller must not learn that.
    refuse = true;
    const refusal = await t.client
      .sendDirect("answers", { token: deferred.token })
      .then((ack) => ack as { status?: string })
      .catch((err: unknown) => err as { rc?: string });

    expect((refusal as { rc?: string }).rc).toBe("RC5056");
    expect((refusal as { status?: string }).status).toBeUndefined();
  });

  /**
   * @case An elevated resume still records the DOOR's principal as who resumed it
   * @preconditions A door that authenticates a live approver and elevates the parked identity
   * @expectedResult resumedBy names the approver, not the elevated principal the continuation ran as
   */
  test("resumedBy reflects the door's live principal, not the elevated one", async () => {
    const store = new MemoryDeferralStore();
    const ran = { body: 0 };

    t = await testContext()
      .with(shared(store))
      .routes([
        archiveRoute(ran),
        craft()
          .id("answers")
          .from(direct())
          .authenticate(() => authenticate({ subject: "approver-1" }))
          .resume(payloadFrom, {
            elevate: () => agentActingFor([HELD, LENT]),
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = await park(t);
    await t.client.sendDirect("answers", { token: deferred.token });

    const record = await store.get(deferred.deferralId);
    expect(record?.outcome?.kind).toBe("resumed");
    expect(record?.outcome?.by?.subject).toBe("approver-1");
  });

  /**
   * @case A lend that still does not satisfy the gate cannot ask a human again
   * @preconditions A door lending a scope the gate does not read, so the continuation is refused for the same scope
   * @expectedResult The second park is refused rather than raised, so a bad lend cannot drive an approver notification forever
   */
  test("a resumed exchange is not parked again for scopes already asked for", async () => {
    const store = new MemoryDeferralStore();
    const ran = { body: 0 };

    t = await testContext()
      .with(shared(store))
      .routes([
        // Reads the SUBJECT's ring only, so a lend on the actor can never
        // satisfy it: the refusal repeats with the same scope.
        craft()
          .id("archive")
          .authorize({ scopes: [LENT], actor: "any" })
          .error((error) =>
            insufficientAuthorityOf(error)
              ? recovery.defer({ ttl: "4h" })
              : recovery.rethrow(),
          )
          .from(direct())
          .transform((body) => {
            ran.body += 1;
            return body;
          })
          .to(noop()),
        craft()
          .id("answers")
          .from(direct())
          .resume(payloadFrom, {
            // Lent on the ACTOR's ring, which a subject-ring gate never
            // reads. The continuation is refused for the same scope.
            elevate: () => agentActingFor([HELD, LENT]),
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = await park(t);
    const ack = (await t.client.sendDirect("answers", {
      token: deferred.token,
    })) as { continuation: { status: string; error?: { rc?: string } } };

    // Refused rather than parked a second time.
    expect(ack.continuation.status).toBe("failed");
    expect(ack.continuation.error?.rc).toBe("RC5051");
    expect(ran.body).toBe(0);
    // Exactly one record: the loop closed instead of growing.
    const listed = await store.list({ limit: 10, state: "waiting" });
    expect(listed.length).toBe(0);
  });
});
