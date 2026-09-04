import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runInNewContext } from "node:vm";
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

const providers = (): ReturnType<typeof llmPlugin> =>
  llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } });

/** An agent prompted with `user` that parks on `ask`, plus its resume route. */
function parkingRoutes(
  id: string,
  sink: ReturnType<typeof spy>,
  user: () => LlmPromptPart[],
): RouteDefinition[] {
  return [
    ...craft()
      .id(`${id}-assistant`)
      .from(direct())
      .to(
        agent({
          model: MODEL,
          system: "be useful",
          tools: tools(["ask"]),
          user,
        }),
      )
      .to(sink)
      .build(),
    ...craft().id(`${id}-answers`).from(direct()).resume().build(),
  ];
}

/**
 * The suspension wiring both park tests share. The store, the secret and the
 * plugin list all have to agree for a park to be resumable, so they are
 * written once rather than per test.
 */
function parkingContext(
  store: MemorySuspensionStore,
  routes: RouteDefinition[],
): ReturnType<ReturnType<typeof testContext>["routes"]> {
  return testContext()
    .with({
      suspension: { store, secret: SECRET },
      plugins: [providers(), agentPlugin({ functions: { ask: askFn } })],
    })
    .routes(routes);
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
        plugins: [providers(), agentPlugin({})],
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
   * @case A static parts array is accepted by agent() as well as by llm()
   * @preconditions agent({ user: [file part, text part] }) with no callback, the form the reference table advertises
   * @expectedResult The route builds and the same user message is dispatched, so the option's construction guard agrees with its declared type
   */
  test("agent({ user }) accepts a static parts array", async () => {
    scripted.script.push({ text: "heard it" });
    const parts: LlmPromptPart[] = [
      { type: "file", data: "AQID", mediaType: "audio/ogg" },
      { type: "text", text: "Answer the question in the recording." },
    ];
    t = await testContext()
      .with({ plugins: [providers(), agentPlugin({})] })
      .routes(
        craft()
          .id("static-parts")
          .from(simple("ignored"))
          .to(agent({ model: MODEL, system: "answer", user: parts })),
      )
      .build();

    await t.test();

    expect(firstPrompt()).toEqual([{ role: "user", content: parts }]);
  });

  /**
   * @case A malformed static parts array is refused at the agent({...}) call site
   * @preconditions Arrays reaching the guard past the type system, as a JavaScript caller or a cast config would: an unknown part type, a file part with no media type, and a non-object element
   * @expectedResult RC5003 naming the offending index and what it needs, rather than an opaque provider error at dispatch. Which media types a provider accepts is still the provider's answer, not this guard's.
   */
  test("a malformed static parts array throws RC5003 at construction", () => {
    const build = (user: unknown): void => {
      agent({
        model: MODEL,
        system: "s",
        user: user as LlmPromptPart[],
      });
    };

    expect(() => build([{ type: "audio", data: "AQID" }])).toThrow(
      /"user"\[0\] has unknown type "audio"/,
    );
    expect(() => build([{ type: "file", data: "AQID" }])).toThrow(
      /"user"\[0\] is a file part and must carry a non-empty "mediaType"/,
    );
    expect(() => build([{ type: "text", text: "ok" }, "not a part"])).toThrow(
      /"user"\[1\] must be a content part object/,
    );
    expect(() => build([{ type: "image" }])).toThrow(
      /"user"\[0\] is an image part and its "image" must be/,
    );

    // A payload of the wrong type is refused too: the SDK's own union takes a
    // string, bytes or a URL, and anything else fails at the provider.
    expect(() =>
      build([{ type: "file", data: 42, mediaType: "audio/ogg" }]),
    ).toThrow(/is a file part and its "data" must be/);
    expect(() => build([{ type: "image", image: { nested: true } }])).toThrow(
      /is an image part and its "image" must be/,
    );

    // A payload built in another realm is still a payload: instanceof would
    // refuse it against this realm's constructor, and a guard that rejects
    // what the SDK accepts is worse than no guard.
    const otherRealm = runInNewContext(
      "({ bytes: new Uint8Array([1]), buffer: new ArrayBuffer(1) })",
    ) as { bytes: Uint8Array; buffer: ArrayBuffer };
    expect(otherRealm.bytes instanceof Uint8Array).toBe(false);
    expect(() =>
      build([
        { type: "file", data: otherRealm.bytes, mediaType: "audio/ogg" },
        { type: "file", data: otherRealm.buffer, mediaType: "audio/ogg" },
      ]),
    ).not.toThrow();

    // Precision is not traded away for realm safety: a Float32Array is a
    // typed-array view but is not one of the SDK's payload types.
    expect(() =>
      build([{ type: "file", data: new Float32Array(1), mediaType: "x/y" }]),
    ).toThrow(/is a file part and its "data" must be/);

    // The reporter must survive the values least likely to render. A BigInt
    // and a circular object both make JSON.stringify throw, which would
    // replace the RC5003 with a native TypeError.
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => build([{ type: 10n }])).toThrow(/has unknown type 10/);
    expect(() => build([{ type: circular }])).toThrow(/has unknown type/);

    // The valid forms still build.
    expect(() =>
      build([
        { type: "text", text: "ok" },
        { type: "file", data: "AQID", mediaType: "audio/ogg" },
        { type: "file", data: new Uint8Array([1]), mediaType: "audio/ogg" },
        { type: "image", image: new URL("https://example.com/cat.png") },
      ]),
    ).not.toThrow();
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

    t = await parkingContext(
      store,
      parkingRoutes("parts", sink, () => [
        { type: "file", data: "AQID", mediaType: "audio/ogg" },
        { type: "text", text: "Answer the question in the recording." },
      ]),
    ).build();
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
   * @case A URL instance in a parts prompt cannot cross the suspension boundary either
   * @preconditions The same parked agent, prompted with a file part whose data is a `URL` object
   * @expectedResult The park is refused naming that part, because the store persists JSON data and a `URL` is a class instance. This is why the reference page tells a parking route to pass the URL as a plain string, which the SDK still reads as a URL.
   */
  test("a URL instance part refuses to park, naming the offending part", async () => {
    const store = new MemorySuspensionStore();
    const sink = spy();
    scripted.script.push({
      toolCalls: [{ toolName: "ask", input: { question: "send it?" } }],
    });

    t = await parkingContext(
      store,
      parkingRoutes("urlpart", sink, () => [
        {
          type: "file",
          data: new URL("https://example.com/note.ogg"),
          mediaType: "audio/ogg",
        },
      ]),
    ).build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("urlpart-assistant", "go"),
    ).rejects.toThrow(
      /stepState\.messages\[0\]\.content\[0\]\.data holds an instance of URL/,
    );
  });

  /**
   * @case Raw bytes in a parts prompt cannot cross the suspension boundary, and say so loudly
   * @preconditions The same parked agent, prompted with a Uint8Array file part instead of base64
   * @expectedResult The park is refused, naming the exact part that cannot be persisted, rather than resuming with a corrupted one. The suspension store carries JSON data only (`suspension/serialize.ts`), which refuses a `URL` instance for the same reason, so a part reaching a suspending agent has to carry a base64 string or a URL-shaped string.
   */
  test("a Uint8Array part refuses to park, naming the offending part", async () => {
    const store = new MemorySuspensionStore();
    const sink = spy();
    scripted.script.push({
      toolCalls: [{ toolName: "ask", input: { question: "send it?" } }],
    });

    t = await parkingContext(
      store,
      parkingRoutes("bytes", sink, () => [
        {
          type: "file",
          data: new Uint8Array([1, 2, 3]),
          mediaType: "audio/ogg",
        },
      ]),
    ).build();
    await t.startAndWaitReady();

    await expect(t.client.sendDirect("bytes-assistant", "go")).rejects.toThrow(
      /stepState\.messages\[0\]\.content\[0\]\.data holds an instance of Uint8Array/,
    );
  });
});
