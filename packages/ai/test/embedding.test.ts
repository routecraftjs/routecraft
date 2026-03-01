import { describe, test, expect, afterEach } from "vitest";
import {
  embedding,
  embeddingPlugin,
  EmbeddingDestinationAdapter,
} from "../src/index.ts";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, noop } from "@routecraft/routecraft";

describe("embedding() DSL and adapter", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case embedding(modelId, options) returns an EmbeddingDestinationAdapter instance
   * @preconditions None
   * @expectedResult Destination has adapterId routecraft.adapter.embedding
   */
  test("embedding(providerId:modelName) returns an EmbeddingDestinationAdapter", () => {
    const dest = embedding("huggingface:all-MiniLM-L6-v2", {
      using: () => "hello",
    });
    expect(dest).toBeInstanceOf(EmbeddingDestinationAdapter);
    expect(dest.adapterId).toBe("routecraft.adapter.embedding");
  });

  /**
   * @case send() throws when no embeddingPlugin registered
   * @preconditions Route uses enrich(embedding(...)), plugins list empty
   * @expectedResult One error, message matches not found or no providers registered
   */
  test("send() throws when no plugin (no providers registered)", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("with-embedding")
          .from(simple({ body: "Hello" }))
          .enrich(
            embedding("huggingface:any", {
              using: (e) => (e.body as { body: string }).body,
            }),
          )
          .to(noop()),
      ])
      .with({ plugins: [] })
      .build();

    await t.test();
    expect(t.errors).toHaveLength(1);
    const msg =
      (t.errors[0] as Error).message +
      String((t.errors[0] as Error).cause ?? "");
    expect(msg).toMatch(/no providers registered|not found/i);
  });

  /**
   * @case send() throws when provider id not in embeddingPlugin providers
   * @preconditions embeddingPlugin registers only huggingface, route uses embedding("unknown:model")
   * @expectedResult One error, message matches "unknown" not found
   */
  test("send() throws when provider is not in plugin providers", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("with-embedding")
          .from(simple({ body: "Hello" }))
          .enrich(
            embedding("unknown:model", {
              using: (e) => (e.body as { body: string }).body,
            }),
          )
          .to(noop()),
      ])
      .with({
        plugins: [embeddingPlugin({ providers: { huggingface: {} } })],
      })
      .build();

    await t.test();
    expect(t.errors).toHaveLength(1);
    expect(
      (t.errors[0] as Error).message +
        String((t.errors[0] as Error).cause ?? ""),
    ).toMatch(/unknown.*not found/i);
  });

  /**
   * @case send() returns embedding when mock provider is registered
   * @preconditions embeddingPlugin({ providers: { mock: {} } }), route enrich(embedding("mock:any", { using }))
   * @expectedResult Destination receives body with embedding array of length 8
   */
  test("send() returns embedding when mock provider is registered", async () => {
    const received: { body: unknown }[] = [];
    t = await testContext()
      .routes([
        craft()
          .id("with-embedding")
          .from(simple({ body: "test" }))
          .enrich(
            embedding("mock:any", {
              using: (e) => (e.body as { body: string }).body,
            }),
          )
          .to({
            send: async (exchange) => {
              received.push({ body: exchange.body });
            },
          }),
      ])
      .with({
        plugins: [embeddingPlugin({ providers: { mock: {} } })],
      })
      .build();

    await t.test();
    expect(t.errors).toHaveLength(0);
    expect(received).toHaveLength(1);
    const body = received[0].body as { body: string; embedding?: number[] };
    expect(body).toHaveProperty("embedding");
    expect(Array.isArray(body.embedding)).toBe(true);
    expect((body.embedding as number[]).length).toBe(8);
  });
});
