import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  MemorySuspensionStore,
  craft,
  direct,
  noop,
  type Exchange,
} from "../src/index.ts";
import { asSuspended } from "./helpers/suspension.ts";

/**
 * The five patterns from the "Securing resume" docs section, each as running
 * code with its accept and refuse path proven.
 *
 * The docs excerpt the `authorize` bodies below verbatim rather than
 * re-authoring them, per the code-lives-once rule: the framework ships no
 * policy of its own, so the patterns ARE the deliverable and prose that
 * drifts from them is worse than no prose. Changing a hook here means
 * changing the snippet on
 * `apps/routecraft.dev/app/content/docs/reference/operations/resume/index.mdx`.
 */

const SECRET = "securing-resume-patterns-secret-0123456789";

const Approval = z.object({ approved: z.boolean() });

/** Mints a principal from the ingress body, standing in for a real verifier. */
function asWho(ex: Exchange) {
  const body = ex.body as { who?: string; scopes?: string[] } | null;
  return body?.who
    ? {
        subject: body.who,
        ...(body.scopes ? { scopes: body.scopes } : {}),
      }
    : undefined;
}

function answerFrom(ex: Exchange) {
  return {
    token: (ex.body as { token: string }).token,
    result: { approved: true },
  };
}

describe("securing resume: the documented patterns", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Four eyes: the principal that parked may not answer their own question
   * @preconditions A payout parked by alice, answered once by alice and once by bob
   * @expectedResult Alice is refused and bob succeeds, with both subjects required present so two anonymous parties are never "different people"
   */
  test("four eyes", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with({ suspension: { store, secret: SECRET } })
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .authenticate(asWho)
          .suspend({ schema: Approval })
          .to(noop()),
        craft()
          .id("approvals")
          .from(direct())
          .authenticate(asWho)
          .resume(answerFrom, {
            authorize: ({ answerer, parked }) => {
              // Both subjects must be present: two principals that merely
              // lack one are not two different people.
              const answering = answerer?.subject;
              const requester = parked?.subject;
              if (!answering || !requester) return false;
              return answering !== requester;
            },
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { who: "alice" }),
    );
    await expect(
      t.client.sendDirect("approvals", { who: "alice", token: parked.token }),
    ).rejects.toThrow(/refused this answerer/);
    expect((await store.get(parked.suspensionId))?.status).toBe("suspended");

    await t.client.sendDirect("approvals", {
      who: "bob",
      token: parked.token,
    });
    expect((await store.get(parked.suspensionId))?.status).toBe("resumed");
  });

  /**
   * @case Scope gate: the parker records what the answerer must hold
   * @preconditions meta.requires listing a scope, answered once without it and once with it
   * @expectedResult The scope requirement is read off the record, so it is the one in force when the question was asked
   */
  test("scope gate", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with({ suspension: { store, secret: SECRET } })
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({
            schema: Approval,
            meta: { requires: ["payouts:approve"] },
          })
          .to(noop()),
        craft()
          .id("approvals")
          .from(direct())
          .authenticate(asWho)
          .resume(answerFrom, {
            authorize: ({ answerer, record }) => {
              const required = (
                record.meta as { requires?: string[] } | undefined
              )?.requires;
              // No recorded requirement is a parker bug, not a grant.
              // Without this, `[].every(...)` returns true and a site that
              // forgot its `meta` opens the door to every token holder.
              if (!required?.length) return false;
              const held = new Set(answerer?.scopes ?? []);
              return required.every((scope) => held.has(scope));
            },
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    await expect(
      t.client.sendDirect("approvals", {
        who: "carol",
        scopes: ["payouts:read"],
        token: parked.token,
      }),
    ).rejects.toThrow(/refused this answerer/);

    await t.client.sendDirect("approvals", {
      who: "carol",
      scopes: ["payouts:approve"],
      token: parked.token,
    });
    expect((await store.get(parked.suspensionId))?.status).toBe("resumed");
  });

  /**
   * @case The scope gate refuses a record that recorded no requirement
   * @preconditions A site that forgot its meta, answered by a caller holding every scope
   * @expectedResult Refused, because an absent requirement is a parker bug rather than a grant
   */
  test("scope gate refuses a missing requirement", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with({ suspension: { store, secret: SECRET } })
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
        craft()
          .id("approvals")
          .from(direct())
          .authenticate(asWho)
          .resume(answerFrom, {
            authorize: ({ answerer, record }) => {
              const required = (
                record.meta as { requires?: string[] } | undefined
              )?.requires;
              if (!required?.length) return false;
              const held = new Set(answerer?.scopes ?? []);
              return required.every((scope) => held.has(scope));
            },
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    await expect(
      t.client.sendDirect("approvals", {
        who: "carol",
        scopes: ["payouts:approve"],
        token: parked.token,
      }),
    ).rejects.toThrow(/refused this answerer/);
    expect((await store.get(parked.suspensionId))?.status).toBe("suspended");
  });

  /**
   * @case Channel segmentation: two doors serving different classes of question
   * @preconditions One record parked on the finance channel, presented to an ops door and a finance door
   * @expectedResult The ops door refuses without touching the record and the finance door answers it
   */
  test("channel segmentation", async () => {
    const store = new MemorySuspensionStore();
    const servesChannel = (channel: string) => ({
      authorize: ({ record }: { record: { meta?: unknown } }) =>
        (record.meta as { channel?: string } | undefined)?.channel === channel,
    });
    t = await testContext()
      .with({ suspension: { store, secret: SECRET } })
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval, meta: { channel: "finance" } })
          .to(noop()),
        craft()
          .id("ops-door")
          .from(direct())
          .resume(answerFrom, servesChannel("ops")),
        craft()
          .id("finance-door")
          .from(direct())
          .resume(answerFrom, servesChannel("finance")),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("payout", {}));
    await expect(
      t.client.sendDirect("ops-door", { token: parked.token }),
    ).rejects.toThrow(/refused this answerer/);
    expect((await store.get(parked.suspensionId))?.status).toBe("suspended");

    await t.client.sendDirect("finance-door", { token: parked.token });
    expect((await store.get(parked.suspensionId))?.status).toBe("resumed");
  });

  /**
   * @case Policy travels with the question: a site edit cannot reach parked records
   * @preconditions A record parked under a four-eyes snapshot, then a redeploy whose site snapshots bearer instead
   * @expectedResult The parked record keeps the policy its approver was promised, because the door reads the record rather than the site
   */
  test("policy travels with the question", async () => {
    const store = new MemorySuspensionStore();
    const door = craft()
      .id("approvals")
      .from(direct())
      .authenticate(asWho)
      .resume(answerFrom, {
        authorize: ({ answerer, parked, record }) => {
          // The policy in force is the one the record carries, not the one
          // the suspend site declares today.
          const policy = record.meta as { fourEyes?: boolean } | undefined;
          if (!policy?.fourEyes) return true;
          const answering = answerer?.subject;
          const requester = parked?.subject;
          return Boolean(answering && requester && answering !== requester);
        },
      });

    t = await testContext()
      .with({ suspension: { store, secret: SECRET } })
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .authenticate(asWho)
          .suspend({ schema: Approval, meta: { fourEyes: true } })
          .to(noop()),
        door,
      ])
      .build();
    await t.startAndWaitReady();
    const parked = asSuspended(
      await t.client.sendDirect("payout", { who: "alice" }),
    );
    await t.stop();

    // The redeploy relaxes the SITE. The parked record is unmoved.
    t = await testContext()
      .with({ suspension: { store, secret: SECRET } })
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .authenticate(asWho)
          .suspend({ schema: Approval, meta: { fourEyes: false } })
          .to(noop()),
        craft()
          .id("approvals")
          .from(direct())
          .authenticate(asWho)
          .resume(answerFrom, {
            authorize: ({ answerer, parked: requester, record }) => {
              const policy = record.meta as { fourEyes?: boolean } | undefined;
              if (!policy?.fourEyes) return true;
              const answering = answerer?.subject;
              const asked = requester?.subject;
              return Boolean(answering && asked && answering !== asked);
            },
          }),
      ])
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("approvals", { who: "alice", token: parked.token }),
    ).rejects.toThrow(/refused this answerer/);
    expect((await store.get(parked.suspensionId))?.status).toBe("suspended");
  });

  /**
   * @case Same-user continuation: only the principal that parked may answer
   * @preconditions A pause parked by alice, answered by bob and then by alice
   * @expectedResult Bob is refused; an anonymous parker cannot satisfy the pattern at all, which the hook states rather than passing by accident
   */
  test("same-user continuation", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with({ suspension: { store, secret: SECRET } })
      .routes([
        craft()
          .id("wizard")
          .from(direct())
          .authenticate(asWho)
          .suspend({ schema: Approval })
          .to(noop()),
        craft()
          .id("continue")
          .from(direct())
          .authenticate(asWho)
          .resume(answerFrom, {
            authorize: ({ answerer, parked }) => {
              // An anonymous parker can never satisfy this: there is no
              // identity to continue, so the hook refuses rather than
              // matching one absent subject against another.
              const answering = answerer?.subject;
              const requester = parked?.subject;
              if (!answering || !requester) return false;
              return answering === requester;
            },
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("wizard", { who: "alice" }),
    );
    await expect(
      t.client.sendDirect("continue", { who: "bob", token: parked.token }),
    ).rejects.toThrow(/refused this answerer/);

    await t.client.sendDirect("continue", {
      who: "alice",
      token: parked.token,
    });
    expect((await store.get(parked.suspensionId))?.status).toBe("resumed");
  });

  /**
   * @case An anonymous parker cannot satisfy a same-subject hook
   * @preconditions A pause parked with no principal, answered by an authenticated caller
   * @expectedResult Refused, because two absent subjects are not the same person
   */
  test("an anonymous parker refuses a same-user hook", async () => {
    const store = new MemorySuspensionStore();
    t = await testContext()
      .with({ suspension: { store, secret: SECRET } })
      .routes([
        craft()
          .id("wizard")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
        craft()
          .id("continue")
          .from(direct())
          .authenticate(asWho)
          .resume(answerFrom, {
            authorize: ({ answerer, parked }) => {
              const answering = answerer?.subject;
              const requester = parked?.subject;
              if (!answering || !requester) return false;
              return answering === requester;
            },
          }),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(await t.client.sendDirect("wizard", {}));
    await expect(
      t.client.sendDirect("continue", { who: "alice", token: parked.token }),
    ).rejects.toThrow(/refused this answerer/);
    expect((await store.get(parked.suspensionId))?.status).toBe("suspended");
  });
});
