import { afterEach, describe, expect, mock, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, direct, type Source } from "@routecraft/routecraft";
import type { CallableDestination } from "../src/operations/to.ts";

describe("Direct adapter", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Verifies basic direct endpoint communication
   * @preconditions Simple producer and consumer setup
   * @expectedResult Should process message synchronously without errors
   */
  test("basic direct communication", async () => {
    const consumer = mock();

    t = await testContext()
      .routes([
        craft()
          .id("producer")
          .from(simple("test-message"))
          .to(direct("endpoint")),
        craft().id("endpoint").from(direct()).to(consumer),
      ])
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0][0].body).toBe("test-message");
  });

  /**
   * @case Verifies that different direct endpoints are isolated
   * @preconditions Multiple producers and consumers on different endpoints
   * @expectedResult Each consumer should only receive messages from its endpoint
   */
  test("endpoint isolation", async () => {
    const consumerA = mock();
    const consumerB = mock();

    t = await testContext()
      .routes([
        craft()
          .id("producerA")
          .from(simple("messageA"))
          .to(direct("endpointA")),
        craft()
          .id("producerB")
          .from(simple("messageB"))
          .to(direct("endpointB")),
        craft().id("endpointA").from(direct()).to(consumerA),
        craft().id("endpointB").from(direct()).to(consumerB),
      ])
      .build();

    await t.test();
    expect(consumerA).toHaveBeenCalledTimes(1);
    expect(consumerB).toHaveBeenCalledTimes(1);
    expect(consumerA.mock.calls[0][0].body).toBe("messageA");
    expect(consumerB.mock.calls[0][0].body).toBe("messageB");
  });

  /**
   * @case Two routes cannot subscribe to the same direct endpoint
   * @preconditions Two routes declare the same id (endpoint)
   * @expectedResult Build throws the duplicate-route-id error (RC1002)
   */
  test("duplicate direct subscribers rejected via route id uniqueness", async () => {
    const builder = testContext()
      .routes([
        craft().id("producer").from(simple("message")).to(direct("shared")),
        craft()
          .id("shared")
          .from(direct())
          .to(mock() as never),
        craft()
          .id("shared")
          .from(direct())
          .to(mock() as never),
      ])
      .build();
    await expect(builder).rejects.toMatchObject({ rc: "RC1002" });
  });

  /**
   * @case Verifies dynamic endpoint routing based on body
   * @preconditions Producer with dynamic endpoint function based on body
   * @expectedResult Messages should route to correct endpoints based on body
   */
  test("dynamic endpoint based on body", async () => {
    const handlerA = mock();
    const handlerB = mock();

    t = await testContext()
      .routes([
        craft()
          .id("dynamic-producer")
          .from(
            simple([
              { type: "a", data: "message-a" },
              { type: "b", data: "message-b" },
            ]),
          )
          .split()
          .to(direct((ex) => `handler-${ex.body.type}`)),
        craft().id("handler-a").from(direct()).to(handlerA),
        craft().id("handler-b").from(direct()).to(handlerB),
      ])
      .build();

    await t.test();
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerA.mock.calls[0][0].body).toEqual({
      type: "a",
      data: "message-a",
    });
    expect(handlerB.mock.calls[0][0].body).toEqual({
      type: "b",
      data: "message-b",
    });
  });

  /**
   * @case Verifies dynamic endpoint routing based on headers
   * @preconditions Producer with dynamic endpoint function based on headers
   * @expectedResult Messages should route to correct endpoints based on headers
   */
  test("dynamic endpoint based on headers", async () => {
    const highPriorityHandler = mock();
    const normalPriorityHandler = mock();

    t = await testContext()
      .routes([
        craft()
          .id("priority-producer-high")
          .from(simple("msg1"))
          .header("priority", "high")
          .to(
            direct((ex) => {
              const priority = ex.headers["priority"] || "normal";
              return `processing-${priority}`;
            }),
          ),
        craft()
          .id("priority-producer-normal")
          .from(simple("msg2"))
          .header("priority", "normal")
          .to(
            direct((ex) => {
              const priority = ex.headers["priority"] || "normal";
              return `processing-${priority}`;
            }),
          ),
        craft().id("processing-high").from(direct()).to(highPriorityHandler),
        craft()
          .id("processing-normal")
          .from(direct())
          .to(normalPriorityHandler),
      ])
      .build();

    await t.test();
    expect(highPriorityHandler).toHaveBeenCalledTimes(1);
    expect(normalPriorityHandler).toHaveBeenCalledTimes(1);
    expect(highPriorityHandler.mock.calls[0][0].body).toBe("msg1");
    expect(normalPriorityHandler.mock.calls[0][0].body).toBe("msg2");
  });

  /**
   * @case Verifies endpoint sanitization works with dynamic endpoints
   * @preconditions Dynamic endpoint that returns special characters
   * @expectedResult Special characters should be URL-encoded for collision-free routing
   */
  test("dynamic endpoint sanitization", async () => {
    const consumer = mock();

    // The route id itself must avoid `:` because event names are
    // colon-delimited; the endpoint registry still URL-encodes other special
    // characters (here `/`) as the contract guarantees.
    t = await testContext()
      .routes([
        craft()
          .id("producer")
          .from(simple({ namespace: "com.example", action: "process" }))
          .to(direct((ex) => `${ex.body.namespace}/${ex.body.action}`)),
        craft().id("com.example/process").from(direct()).to(consumer),
      ])
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0][0].body).toEqual({
      namespace: "com.example",
      action: "process",
    });
  });

  /**
   * @case Verifies error is thrown when dynamic endpoint used with from()
   * @preconditions Attempt to use dynamic endpoint as source
   * @expectedResult Should throw RC1001 error (invalid-consumer) during build
   */
  test("throws error for dynamic endpoint as source", async () => {
    // With the refactored adapter, build() now throws RC1001 (invalid-consumer)
    // because DirectDestinationAdapter doesn't have a subscribe method.
    // This is actually better - fail fast at build time rather than runtime.
    const builder = testContext()
      .routes([
        craft()
          .id("invalid-consumer")
          .from(direct(() => "dynamic-endpoint") as unknown as Source<unknown>)
          .to(mock() as CallableDestination<unknown, void>),
      ])
      .build();
    await expect(builder).rejects.toThrow("invalid-consumer");
  });

  /**
   * @case Verifies multiple messages route correctly to different dynamic endpoints
   * @preconditions Producer sends multiple messages with different routing keys
   * @expectedResult Each handler receives only its designated messages
   */
  test("multiple dynamic routes with complex routing", async () => {
    const orderHandler = mock();
    const userHandler = mock();
    const productHandler = mock();

    t = await testContext()
      .routes([
        craft()
          .id("multi-producer")
          .from(
            simple([
              { type: "order", id: 1 },
              { type: "user", id: 2 },
              { type: "product", id: 3 },
              { type: "order", id: 4 },
            ]),
          )
          .split()
          .to(direct((ex) => `${ex.body.type}-handler`)),
        craft().id("order-handler").from(direct()).to(orderHandler),
        craft().id("user-handler").from(direct()).to(userHandler),
        craft().id("product-handler").from(direct()).to(productHandler),
      ])
      .build();

    await t.test();
    expect(orderHandler).toHaveBeenCalledTimes(2);
    expect(userHandler).toHaveBeenCalledTimes(1);
    expect(productHandler).toHaveBeenCalledTimes(1);

    expect(orderHandler.mock.calls[0][0].body).toEqual({
      type: "order",
      id: 1,
    });
    expect(orderHandler.mock.calls[1][0].body).toEqual({
      type: "order",
      id: 4,
    });
    expect(userHandler.mock.calls[0][0].body).toEqual({
      type: "user",
      id: 2,
    });
    expect(productHandler.mock.calls[0][0].body).toEqual({
      type: "product",
      id: 3,
    });
  });

  /**
   * @case Correlation id is preserved across a direct() route-to-route call
   * @preconditions Producer route forwards to a callee via direct()
   * @expectedResult The callee's exchange carries the producer's correlation
   *                 id (not a fresh UUID) so logs/spans tie together
   */
  test("propagates correlation id across direct() boundaries", async () => {
    const callerCorrelationIds: string[] = [];
    const calleeCorrelationIds: string[] = [];

    t = await testContext()
      .routes([
        craft()
          .id("caller")
          .from(simple("ping"))
          .tap((ex) => {
            callerCorrelationIds.push(
              ex.headers["routecraft.correlation_id"] as string,
            );
          })
          .to(direct("callee")),
        craft()
          .id("callee")
          .from(direct())
          .tap((ex) => {
            calleeCorrelationIds.push(
              ex.headers["routecraft.correlation_id"] as string,
            );
          })
          .to(() => "pong"),
      ])
      .build();

    await t.test();

    expect(callerCorrelationIds).toHaveLength(1);
    expect(calleeCorrelationIds).toHaveLength(1);
    expect(calleeCorrelationIds[0]).toBe(callerCorrelationIds[0]);
  });

  /**
   * @case A direct destination can be typed with distinct input and output bodies
   * @preconditions Caller route uses `.enrich(direct<TIn, TOut>("callee"))`
   *                where the callee returns a body shape different from the caller's
   * @expectedResult The merged body downstream has both the caller's input fields
   *                 and the callee's output fields, with runtime values intact
   */
  test("enriches with a typed direct destination where input != output", async () => {
    type AgentInput = { name: string; query: string };
    type AgentResult = { answer: string; tokens: number };

    let downstreamBody: unknown;

    t = await testContext()
      .routes([
        craft()
          .id("agent-caller")
          .from(simple<AgentInput>({ name: "kb", query: "hello" }))
          .enrich(direct<AgentInput, AgentResult>("agent"))
          .tap((ex) => {
            downstreamBody = ex.body;
          }),
        craft()
          .id("agent")
          .from(direct())
          .transform(
            (body): AgentResult => ({
              answer: `echo:${(body as AgentInput).query}`,
              tokens: 42,
            }),
          ),
      ])
      .build();

    await t.test();

    expect(downstreamBody).toEqual({
      name: "kb",
      query: "hello",
      answer: "echo:hello",
      tokens: 42,
    });
  });

  /**
   * @case Principal flows from caller to callee across direct()
   * @preconditions Producer route attaches a custom principal under headers["routecraft.auth.principal"] and forwards via direct()
   * @expectedResult The callee's exchange carries the same principal so .authorize() / route handlers see the caller's identity
   */
  test("propagates principal across direct() boundaries", async () => {
    const principal = {
      kind: "custom" as const,
      scheme: "bearer" as const,
      subject: "user-1",
      roles: ["admin"],
    };
    let capturedPrincipal: unknown;

    t = await testContext()
      .routes([
        craft()
          .id("caller-with-principal")
          .from(simple("ping"))
          .process((ex) => ({
            ...ex,
            headers: { ...ex.headers, "routecraft.auth.principal": principal },
          }))
          .to(direct("callee-reads-principal")),
        craft()
          .id("callee-reads-principal")
          .from(direct())
          .tap((ex) => {
            capturedPrincipal = ex.principal;
          })
          .to(() => "pong"),
      ])
      .build();

    await t.test();

    expect(capturedPrincipal).toEqual(principal);
  });
});
