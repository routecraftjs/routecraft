/**
 * A delta listener has the run's whole reply before the run returns.
 *
 * A provider that produced text without streaming it leaves the reply only
 * in the result, and the run hands that text over as one final delta. The
 * rule is per attempt: what an attempt the validator rejected streamed
 * says nothing about the attempt that was accepted.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import { agent, llmPlugin, type AgentDelta } from "../src/index.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { MODEL } from "./helpers/suspend-fixtures.ts";

const llm = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: llm.callLlm,
  streamLlm: llm.streamLlm,
}));

/** The text of every text delta the listener saw. */
function textsOf(deltas: AgentDelta[]): string[] {
  return deltas.flatMap((delta) =>
    delta.type === "text-delta" ? [delta.text] : [],
  );
}

describe("the final delta", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    llm.reset();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A provider that streamed nothing still reaches the listener with its reply
   * @preconditions One scripted turn with text and no deltas, a route with an onDelta listener
   * @expectedResult The listener saw the reply as one text delta, and the result carries the same text
   */
  test("text a provider did not stream arrives as one delta", async () => {
    llm.script.push({ text: "unstreamed" });
    const deltas: AgentDelta[] = [];
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("final-delta")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: MODEL,
              onDelta: (delta) => {
                deltas.push(delta);
              },
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();

    expect(textsOf(deltas)).toEqual(["unstreamed"]);
  });

  /**
   * @case An accepted retry that streamed nothing still reaches the listener, whatever the rejected attempt streamed
   * @preconditions Two scripted turns: the first streams its text and the validator rejects it, the second carries text with no deltas and is accepted
   * @expectedResult The listener saw the first attempt's stream and then the accepted reply as one delta, so the person is never shown a rejected answer with nothing after it
   */
  test("the accepted attempt's text arrives even after a streamed rejected attempt", async () => {
    llm.script.push(
      { deltas: [{ text: "first" }], text: "first" },
      { text: "second" },
    );
    const deltas: AgentDelta[] = [];
    let attempts = 0;
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("final-delta-retry")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: MODEL,
              validate: () => (++attempts === 1 ? "try again" : undefined),
              onDelta: (delta) => {
                deltas.push(delta);
              },
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();

    expect(attempts).toBe(2);
    expect(textsOf(deltas)).toEqual(["first", "second"]);
  });
});
