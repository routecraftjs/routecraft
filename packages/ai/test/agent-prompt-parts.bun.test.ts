import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  MemorySuspensionStore,
  craft,
  direct,
  simple,
  type RouteDefinition,
} from "@routecraft/routecraft";
import {
  asSuspended,
  spy,
  testContext,
  type TestContext,
} from "@routecraft/testing";
import { agent, agentPlugin, llm, llmPlugin, tools } from "../src/index.ts";
import type { LlmPromptPart } from "../src/index.ts";
import { scriptedLlm } from "./helpers/scripted-llm.ts";
import { MODEL, askFn } from "./helpers/suspend-fixtures.ts";

const scripted = scriptedLlm([]);
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: scripted.callLlm,
  streamLlm: scripted.streamLlm,
}));

const SECRET = "agent-parts-test-secret-key-0123456789";

/** The user side of the first model call, as the SDK's prompt argument. */
function firstPrompt(): unknown {
  return scripted.calls[0]!.user;
}

describe("content parts on the user prompt", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    scripted.reset();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case An agent prompted with content parts dispatches them as one user message
   * @preconditions agent({ user: (ex) => [file part built from the body, text part] })
   * @expectedResult callLlm receives a single user message whose content is the parts array, not a stringified body
   */
  test("agent({ user }) returning parts dispatches a multimodal user message", async () => {
    scripted.script.push({ text: "heard it" });
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({}),
        ],
      })
      .routes(
        craft()
          .id("voice-note")
          .from(simple({ audio: "AQID" }))
          .to(
            agent({
              model: MODEL,
              system: "transcribe and answer",
              user: (ex) => [
                {
                  type: "file",
                  data: (ex.body as { audio: string }).audio,
                  mediaType: "audio/ogg",
                },
                { type: "text", text: "Answer the question in the recording." },
              ],
            }),
          ),
      )
      .build();

    await t.test();

    expect(firstPrompt()).toEqual([
      {
        role: "user",
        content: [
          { type: "file", data: "AQID", mediaType: "audio/ogg" },
          { type: "text", text: "Answer the question in the recording." },
        ],
      },
    ]);
  });

  /**
   * @case The llm() step accepts the same parts shape as agent()
   * @preconditions llm({ user: [image part, text part] }) as a static array
   * @expectedResult callLlm receives the same single user message, so the two destinations stay interchangeable
   */
  test("llm({ user }) accepts a static parts array", async () => {
    scripted.script.push({ text: "a cat" });
    const parts: LlmPromptPart[] = [
      { type: "image", image: "AQID", mediaType: "image/png" },
      { type: "text", text: "what is this" },
    ];
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("image-question")
          .from(simple("ignored"))
          .enrich(llm(MODEL, { user: parts })),
      )
      .build();

    await t.test();

    expect(firstPrompt()).toEqual([{ role: "user", content: parts }]);
  });

  /**
   * @case An empty parts array means "the author said nothing", like an empty string
   * @preconditions llm({ user: () => [] }) over a body the default derivation can render
   * @expectedResult The body-derived default prompt is used, matching what user: () => "" already does
   */
  test("an empty parts array falls back to the body-derived prompt", async () => {
    scripted.script.push({ text: "ok" });
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("empty-parts")
          .from(simple("the body itself"))
          .enrich(llm(MODEL, { user: () => [] })),
      )
      .build();

    await t.test();

    expect(firstPrompt()).toBe("the body itself");
  });

  /**
   * @case A parts prompt survives a park and a resume with its parts intact
   * @preconditions An agent prompted with a base64 file part parks on a suspending tool, then is resumed
   * @expectedResult The resumed dispatch replays the persisted thread whose first message still carries the file part
   */
  test("a parked parts prompt resumes with the parts intact", async () => {
    const store = new MemorySuspensionStore();
    const sink = spy();
    scripted.script.push({
      toolCalls: [{ toolName: "ask", input: { question: "send it?" } }],
    });

    const routes: RouteDefinition[] = [
      ...craft()
        .id("parts-assistant")
        .from(direct())
        .to(
          agent({
            model: MODEL,
            system: "be useful",
            tools: tools(["ask"]),
            user: () => [
              { type: "file", data: "AQID", mediaType: "audio/ogg" },
              { type: "text", text: "Answer the question in the recording." },
            ],
          }),
        )
        .to(sink)
        .build(),
      ...craft().id("parts-answers").from(direct()).resume().build(),
    ];

    t = await testContext()
      .with({
        suspension: { store, secret: SECRET },
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ functions: { ask: askFn } }),
        ],
      })
      .routes(routes)
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("parts-assistant", "go"),
    );
    scripted.script.push({ text: "done" });
    const ack = (await t.client.sendDirect("parts-answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string };
    expect(ack.status).toBe("resumed");

    const resumed = scripted.calls[1]!.user as Array<{
      role: string;
      content: unknown;
    }>;
    expect(resumed[0]).toEqual({
      role: "user",
      content: [
        { type: "file", data: "AQID", mediaType: "audio/ogg" },
        { type: "text", text: "Answer the question in the recording." },
      ],
    });
  });

  /**
   * @case Raw bytes in a parts prompt cannot cross the suspension boundary, and say so loudly
   * @preconditions The same parked agent, prompted with a Uint8Array file part instead of base64
   * @expectedResult The park is refused, naming the exact part that cannot be persisted, rather than resuming with a corrupted one. The suspension store carries JSON data only (`suspension/serialize.ts`), so bytes have to reach a suspending agent as base64 or a URL.
   */
  test("a Uint8Array part refuses to park, naming the offending part", async () => {
    const store = new MemorySuspensionStore();
    const sink = spy();
    scripted.script.push({
      toolCalls: [{ toolName: "ask", input: { question: "send it?" } }],
    });

    const routes: RouteDefinition[] = [
      ...craft()
        .id("bytes-assistant")
        .from(direct())
        .to(
          agent({
            model: MODEL,
            system: "be useful",
            tools: tools(["ask"]),
            user: () => [
              {
                type: "file",
                data: new Uint8Array([1, 2, 3]),
                mediaType: "audio/ogg",
              },
            ],
          }),
        )
        .to(sink)
        .build(),
      ...craft().id("bytes-answers").from(direct()).resume().build(),
    ];

    t = await testContext()
      .with({
        suspension: { store, secret: SECRET },
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ functions: { ask: askFn } }),
        ],
      })
      .routes(routes)
      .build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("bytes-assistant", "go")).rejects.toThrow(
      /stepState\.messages\[0\]\.content\[0\]\.data holds an instance of Uint8Array/,
    );
  });
});
