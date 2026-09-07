/**
 * What the editor answers is checked before a route sees it.
 *
 * The editor is outside the trust boundary, so every answer to a
 * `surface()` call is parsed against the protocol's own schema. The one
 * message whose job is to say no fails closed; everything else is an
 * error the route can catch; and the updates a route pushes are held to
 * the same schema in the other direction.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { craft, direct, noop, recovery } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { surface } from "../src/index.ts";
import { registerSurface } from "../src/surface/index.ts";
import { responseCheck, updateCheck } from "../src/surface/protocol.ts";
import {
  SURFACE_CONNECTION,
  SURFACED,
  scriptedSurface,
} from "./helpers/surface-stub.ts";

/** The options a permission request offers, and the one that allows. */
const OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" as const },
  { optionId: "reject", name: "Reject", kind: "reject_once" as const },
];

/** A route that asks permission and records whether it may proceed. */
function permissionRoute(decisions: boolean[]) {
  return craft()
    .id("ask-permission")
    .from(direct())
    .enrich(
      surface("session/request_permission", () => ({
        toolCall: { toolCallId: "tc-1", title: "delete everything" },
        options: OPTIONS,
      })),
    )
    .transform((answer) => {
      const outcome = answer.outcome;
      decisions.push(
        outcome.outcome === "selected" && outcome.optionId === "allow",
      );
      return answer;
    })
    .to(noop());
}

/** A surface answering every request with `answer`. */
function answering(answer: unknown) {
  return scriptedSurface({ request: () => Promise.resolve(answer) });
}

describe("the surface checks what the editor answers", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A malformed permission answer is a refusal, and the turn does not proceed as approved
   * @preconditions A route asking permission, with the editor answering something that is not a permission response at all
   * @expectedResult The route sees the protocol's cancelled outcome and decides not to proceed, and the instance logged a warning naming the issues
   */
  test("a malformed permission answer does not approve", async () => {
    const decisions: boolean[] = [];
    t = await testContext()
      .routes([permissionRoute(decisions)])
      .build();
    await t.startAndWaitReady();
    registerSurface(t.ctx, SURFACE_CONNECTION, answering({ approved: true }));

    const seen = await t.client.sendDirect("ask-permission", {}, SURFACED);

    expect(seen).toEqual({ outcome: { outcome: "cancelled" } });
    expect(decisions).toEqual([false]);
    const warned = t.contextLogger.warn.mock.calls.some((call) =>
      String(call[1]).includes("permission answer could not be trusted"),
    );
    expect(warned).toBe(true);
  });

  /**
   * @case A well-formed permission answer naming an option that was never offered is a refusal
   * @preconditions The editor answers `selected` with an optionId the request did not carry
   * @expectedResult The route sees cancelled rather than a selection, so an id the person could not have chosen cannot approve
   */
  test("a selection of an option that was never offered does not approve", async () => {
    const decisions: boolean[] = [];
    t = await testContext()
      .routes([permissionRoute(decisions)])
      .build();
    await t.startAndWaitReady();
    registerSurface(
      t.ctx,
      SURFACE_CONNECTION,
      answering({ outcome: { outcome: "selected", optionId: "invented" } }),
    );

    const seen = await t.client.sendDirect("ask-permission", {}, SURFACED);

    expect(seen).toEqual({ outcome: { outcome: "cancelled" } });
    expect(decisions).toEqual([false]);
  });

  /**
   * @case A well-formed permission answer selecting an offered option reaches the route as given
   * @preconditions The editor answers `selected` with the allowing option the request offered
   * @expectedResult The route sees the selection and proceeds, so the check refuses only what it should
   */
  test("a genuine selection is passed through", async () => {
    const decisions: boolean[] = [];
    t = await testContext()
      .routes([permissionRoute(decisions)])
      .build();
    await t.startAndWaitReady();
    registerSurface(
      t.ctx,
      SURFACE_CONNECTION,
      answering({
        outcome: { outcome: "selected", optionId: "allow" },
        _meta: "whatever the client put here",
      }),
    );

    await t.client.sendDirect("ask-permission", {}, SURFACED);

    expect(decisions).toEqual([true]);
  });

  /**
   * @case A malformed answer to any other method is an error the route's .error() catches
   * @preconditions A file-read route with an .error() handler, and the editor answering with a number where the content belongs
   * @expectedResult The handler receives AI1018 with the field named on the cause, and recovers the exchange
   */
  test("a malformed file read is AI1018, caught by .error()", async () => {
    const caught: Array<{ rc?: string; cause?: unknown }> = [];
    t = await testContext()
      .routes([
        craft()
          .id("read-file")
          .from(direct())
          .error((err) => {
            caught.push(err as { rc?: string; cause?: unknown });
            return recovery.drop("malformed");
          })
          .enrich(surface("fs/read_text_file", () => ({ path: "/a.ts" })))
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();
    registerSurface(t.ctx, SURFACE_CONNECTION, answering({ content: 42 }));

    await expect(
      t.client.sendDirect("read-file", {}, SURFACED),
    ).rejects.toMatchObject({ rc: "RC5031" });

    expect(caught).toHaveLength(1);
    expect(caught[0]).toMatchObject({ rc: "AI1018" });
    expect(String((caught[0]?.cause as Error).message)).toContain("content");
  });

  /**
   * @case An update a route builds that the protocol does not define is refused before it is sent
   * @preconditions A notify route whose callback returns an unknown sessionUpdate kind, on a surface that records what it is handed
   * @expectedResult AI1019 naming the issue, and the surface was never asked to send it
   */
  test("a malformed update is AI1019 and never sent", async () => {
    const sent: unknown[] = [];
    t = await testContext()
      .routes([
        craft()
          .id("notify")
          .from(direct())
          .to(
            surface.notify(
              () => ({ sessionUpdate: "nope" }) as unknown as never,
            ),
          ),
      ])
      .build();
    await t.startAndWaitReady();
    registerSurface(
      t.ctx,
      SURFACE_CONNECTION,
      scriptedSurface({
        request: () => Promise.resolve({}),
        notify: (update) => {
          sent.push(update);
          return Promise.resolve();
        },
      }),
    );

    await expect(
      t.client.sendDirect("notify", {}, SURFACED),
    ).rejects.toMatchObject({ rc: "AI1019" });
    expect(sent).toEqual([]);
  });

  /**
   * @case An update the protocol defines is sent as the route built it
   * @preconditions A notify route whose callback returns a plan, on a surface that records what it is handed
   * @expectedResult The surface received that plan, equal to what the callback returned, so the check adds nothing and removes nothing from a conforming update
   */
  test("a conforming update is sent unchanged", async () => {
    const plan = {
      sessionUpdate: "plan" as const,
      entries: [
        {
          content: "read the file",
          priority: "high" as const,
          status: "pending" as const,
        },
      ],
    };
    const sent: unknown[] = [];
    t = await testContext()
      .routes([
        craft()
          .id("notify")
          .from(direct())
          .to(surface.notify(() => plan)),
      ])
      .build();
    await t.startAndWaitReady();
    registerSurface(
      t.ctx,
      SURFACE_CONNECTION,
      scriptedSurface({
        request: () => Promise.resolve({}),
        notify: (update) => {
          sent.push(update);
          return Promise.resolve();
        },
      }),
    );

    await t.client.sendDirect("notify", {}, SURFACED);

    expect(sent).toEqual([plan]);
  });

  /**
   * @case Every method the mount serves has a response check, built from the installed protocol
   * @preconditions The client methods the ACP connection advertises support for, plus the update shape
   * @expectedResult Each check builds, accepts a conforming value and refuses an empty object where the protocol requires fields, so a schema or converter change that breaks one fails here rather than at the first call
   */
  test("every served method has a check from the protocol's schema", async () => {
    const cases: Array<[string, unknown, unknown]> = [
      ["fs/read_text_file", { content: "x" }, { content: 1 }],
      ["fs/write_text_file", {}, "no"],
      ["terminal/create", { terminalId: "t1" }, {}],
      [
        "terminal/output",
        { output: "hi", truncated: false, exitStatus: "garbage is defaulted" },
        { output: "hi" },
      ],
      ["terminal/release", {}, null],
      ["terminal/wait_for_exit", { exitCode: 0 }, "exited"],
      ["terminal/kill", {}, 3],
      [
        "session/request_permission",
        { outcome: { outcome: "cancelled" } },
        { outcome: { outcome: "selected" } },
      ],
      ["elicitation/create", { action: "decline" }, { action: 7 }],
    ];
    for (const [method, good, bad] of cases) {
      const check = await responseCheck(method);
      expect([method, await check(good)]).toEqual([method, undefined]);
      expect([method, (await check(bad)) === undefined]).toEqual([
        method,
        false,
      ]);
    }
    const update = await updateCheck();
    expect(
      await update({ sessionUpdate: "plan", entries: [] }),
    ).toBeUndefined();
    expect(
      await update({ sessionUpdate: "agent_message_chunk" }),
    ).toBeDefined();
  });

  /**
   * @case A method the installed protocol declares no response for cannot be checked, and says so before the editor is asked
   * @preconditions A method name that is not in the schema
   * @expectedResult Building the check fails with RC5003 naming the method and the SDK package, a fault between the two packages rather than an answer, so an unchecked path cannot open by accident
   */
  test("a method with no response schema is a configuration fault", async () => {
    await expect(responseCheck("made/up")).rejects.toMatchObject({
      rc: "RC5003",
      message: expect.stringContaining('surface("made/up")'),
    });
  });
});
