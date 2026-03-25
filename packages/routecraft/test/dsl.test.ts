import { describe, test, expect, afterEach } from "vitest";
import { z } from "zod";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  noop,
  registerDsl,
  mapper,
  schema,
} from "../src/index.ts";
import { TransformStep } from "../src/operations/transform.ts";

describe("registerDsl", () => {
  /**
   * @case Registering a method that already exists on RouteBuilder throws
   * @preconditions RouteBuilder.prototype already has "transform"
   * @expectedResult Throws with collision message
   */
  test("throws on collision with existing builder method", () => {
    expect(() =>
      registerDsl("transform", {
        kind: "transform",
        label: "transform",
        factory: () => new TransformStep((x: unknown) => x),
      }),
    ).toThrow('Cannot register DSL method "transform"');
  });

  /**
   * @case Registering with an invalid kind throws
   * @preconditions kind is "to" which is not in the allowed set
   * @expectedResult Throws with invalid kind message
   */
  test("throws on invalid kind", () => {
    expect(() =>
      registerDsl("myBadStep", {
        kind: "to" as "tap",
        label: "myBadStep",
        factory: () => new TransformStep((x: unknown) => x),
      }),
    ).toThrow('Invalid DSL kind "to"');
  });
});

describe(".log() sugar", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case .log() adds a tap step that logs at info level
   * @preconditions Route with .log() and a spy destination
   * @expectedResult Exchange reaches the destination (type-preserving)
   */
  test("passes exchange through unchanged", async () => {
    const s = spy<string>();

    t = await testContext()
      .routes(craft().from(simple("hello")).log().to(s))
      .build();

    await t.test();
    expect(s.receivedBodies()).toEqual(["hello"]);
  });

  /**
   * @case .log() with formatter calls the formatter function
   * @preconditions Route with .log(formatter) and a spy destination
   * @expectedResult Exchange reaches the destination
   */
  test("accepts a formatter function", async () => {
    const s = spy<{ name: string }>();

    t = await testContext()
      .routes(
        craft()
          .from(simple({ name: "Alice" }))
          .log((ex) => ex.body.name)
          .to(s),
      )
      .build();

    await t.test();
    expect(s.receivedBodies()).toEqual([{ name: "Alice" }]);
  });
});

describe(".debug() sugar", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case .debug() adds a tap step that logs at debug level
   * @preconditions Route with .debug() and a spy destination
   * @expectedResult Exchange reaches the destination (type-preserving)
   */
  test("passes exchange through unchanged", async () => {
    const s = spy<number>();

    t = await testContext()
      .routes(craft().from(simple(42)).debug().to(s))
      .build();

    await t.test();
    expect(s.receivedBodies()).toEqual([42]);
  });
});

describe(".map() sugar", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case .map() transforms body via field mappings
   * @preconditions Route with .map() that extracts fields
   * @expectedResult Body is transformed to the mapped shape
   */
  test("transforms body via field mappings", async () => {
    const s = spy<{ id: number; fullName: string }>();

    t = await testContext()
      .routes(
        craft()
          .from(simple({ userId: 1, first: "Alice", last: "Smith" }))
          .map<{ id: number; fullName: string }>({
            id: (src) => src.userId,
            fullName: (src) => `${src.first} ${src.last}`,
          })
          .to(s),
      )
      .build();

    await t.test();
    expect(s.receivedBodies()).toEqual([{ id: 1, fullName: "Alice Smith" }]);
  });
});

describe("mapper() factory", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case mapper() creates a transformer usable with .transform()
   * @preconditions Route using .transform(mapper({...}))
   * @expectedResult Same result as .map()
   */
  test("works with .transform()", async () => {
    const s = spy<{ name: string }>();

    t = await testContext()
      .routes(
        craft()
          .from(simple({ n: "Bob" }))
          .transform(
            mapper<{ n: string }, { name: string }>({ name: (src) => src.n }),
          )
          .to(s),
      )
      .build();

    await t.test();
    expect(s.receivedBodies()).toEqual([{ name: "Bob" }]);
  });
});

describe(".schema() sugar", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case .schema() passes valid data through
   * @preconditions Route with .schema(z.object({...})) and valid input
   * @expectedResult Valid exchange reaches destination
   */
  test("passes valid data through", async () => {
    const s = spy<{ name: string }>();
    const userSchema = z.object({ name: z.string() });

    t = await testContext()
      .routes(
        craft()
          .from(simple({ name: "Alice" }))
          .schema(userSchema)
          .to(s),
      )
      .build();

    await t.test();
    expect(s.receivedBodies()).toEqual([{ name: "Alice" }]);
  });

  /**
   * @case .schema() throws RC5002 on invalid data
   * @preconditions Route with .schema() and invalid input, no error handler
   * @expectedResult Exchange does not reach destination, error is emitted
   */
  test("throws RC5002 on invalid data", async () => {
    const s = spy<{ name: string }>();
    const userSchema = z.object({ name: z.string() });

    t = await testContext()
      .routes(
        craft()
          .from(simple({ name: 123 }))
          .schema(userSchema)
          .to(s),
      )
      .build();

    await t.test();
    expect(s.received).toHaveLength(0);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0]).toBeDefined();
    expect(t.errors[0]!.rc).toBe("RC5002");
  });

  /**
   * @case .schema() throws can be caught by .error() handler
   * @preconditions Route with .schema() and error handler
   * @expectedResult Error handler receives RC5002, can recover
   */
  test("error handler catches validation failure", async () => {
    const s = spy<unknown>();
    const userSchema = z.object({ name: z.string() });
    const recovered: unknown[] = [];

    t = await testContext()
      .routes(
        craft()
          .error((err) => {
            recovered.push((err as { rc: string }).rc);
            return { error: "recovered" };
          })
          .from(simple({ name: 123 }))
          .schema(userSchema)
          .to(s),
      )
      .build();

    await t.test();
    expect(recovered).toEqual(["RC5002"]);
  });
});

describe("schema() factory", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case schema() factory works with .validate()
   * @preconditions Route using .validate(schema(z.object({...})))
   * @expectedResult Same result as .schema()
   */
  test("works with .validate()", async () => {
    const s = spy<{ age: number }>();
    const ageSchema = z.object({ age: z.number() });

    t = await testContext()
      .routes(
        craft()
          .from(simple({ age: 25 }))
          .validate(schema(ageSchema))
          .to(s),
      )
      .build();

    await t.test();
    expect(s.receivedBodies()).toEqual([{ age: 25 }]);
  });
});

describe("step label in events", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Sugar step labels appear in step:completed events
   * @preconditions Route with .log() sugar, listening for step events
   * @expectedResult step:completed event has operation "log", not "tap"
   */
  test("log sugar shows 'log' label in step events", async () => {
    const stepOps: string[] = [];

    t = await testContext()
      .routes(craft().id("label-test").from(simple("x")).log().to(noop()))
      .build();

    t.ctx.on("route:label-test:step:completed", ({ details }) => {
      stepOps.push(details.operation);
    });

    await t.test();

    expect(stepOps).toContain("log");
    expect(stepOps).not.toContain("tap");
  });

  /**
   * @case .map() sugar shows 'map' label in step events
   * @preconditions Route with .map() sugar, listening for step events
   * @expectedResult step:completed event has operation "map", not "transform"
   */
  test("map sugar shows 'map' label in step events", async () => {
    const stepOps: string[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("map-label-test")
          .from(simple({ a: 1 }))
          .map<{ b: number }>({ b: (src) => src.a })
          .to(noop()),
      )
      .build();

    t.ctx.on("route:map-label-test:step:completed", ({ details }) => {
      stepOps.push(details.operation);
    });

    await t.test();

    expect(stepOps).toContain("map");
    expect(stepOps).not.toContain("transform");
  });

  /**
   * @case .schema() sugar shows 'schema' label in step events
   * @preconditions Route with .schema() sugar, listening for step events
   * @expectedResult step:completed event has operation "schema", not "validate"
   */
  test("schema sugar shows 'schema' label in step events", async () => {
    const stepOps: string[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("schema-label-test")
          .from(simple({ name: "test" }))
          .schema(z.object({ name: z.string() }))
          .to(noop()),
      )
      .build();

    t.ctx.on("route:schema-label-test:step:completed", ({ details }) => {
      stepOps.push(details.operation);
    });

    await t.test();

    expect(stepOps).toContain("schema");
    expect(stepOps).not.toContain("validate");
  });
});

describe(".validate() with custom validator", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case .validate() accepts a callable validator function
   * @preconditions Route with .validate() using a custom function
   * @expectedResult Valid exchange passes, body may be coerced
   */
  test("accepts a callable validator", async () => {
    const s = spy<number>();

    t = await testContext()
      .routes(
        craft()
          .from(simple("42"))
          .validate<number>((exchange) => {
            const n = Number(exchange.body);
            if (Number.isNaN(n)) throw new Error("not a number");
            return n;
          })
          .to(s),
      )
      .build();

    await t.test();
    expect(s.receivedBodies()).toEqual([42]);
  });

  /**
   * @case .validate() with adapter object
   * @preconditions Route with .validate() using Validator adapter interface
   * @expectedResult Valid exchange passes through
   */
  test("accepts a Validator adapter object", async () => {
    const s = spy<string>();

    t = await testContext()
      .routes(
        craft()
          .from(simple("hello"))
          .validate<string>({
            validate: (exchange) => {
              if (typeof exchange.body !== "string")
                throw new Error("not a string");
              return exchange.body.toUpperCase();
            },
          })
          .to(s),
      )
      .build();

    await t.test();
    expect(s.receivedBodies()).toEqual(["HELLO"]);
  });

  /**
   * @case .validate() shows 'validate' in step events (core method, no label override)
   * @preconditions Route with .validate(), listening for step events
   * @expectedResult step:completed event has operation "validate"
   */
  test("shows 'validate' in step events", async () => {
    const stepOps: string[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("validate-label-test")
          .from(simple("test"))
          .validate((ex) => ex.body)
          .to(noop()),
      )
      .build();

    t.ctx.on("route:validate-label-test:step:completed", ({ details }) => {
      stepOps.push(details.operation);
    });

    await t.test();

    expect(stepOps).toContain("validate");
  });
});
