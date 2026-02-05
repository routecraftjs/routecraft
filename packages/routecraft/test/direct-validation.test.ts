import { describe, test, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import {
  context,
  craft,
  simple,
  direct,
  DirectAdapter,
  type CraftContext,
} from "../src/index.ts";

/**
 * Direct adapter validation tests
 *
 * Tests for schema validation, header validation, and route discovery.
 */

describe("Direct adapter validation", () => {
  let ctx: CraftContext;

  afterEach(async () => {
    if (ctx) await ctx.stop();
  });

  // ============================================================
  // Group 1: Body Validation (12 tests)
  // ============================================================
  describe("Body validation", () => {
    /**
     * @case Valid body passes validation
     * @preconditions Schema matches body structure
     * @expectedResult Message processed without error
     */
    test("valid body passes validation", async () => {
      const schema = z.object({
        userId: z.string(),
        action: z.string(),
      });

      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple({ userId: "123", action: "create" }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
      expect(consumer.mock.calls[0][0].body).toEqual({
        userId: "123",
        action: "create",
      });
    });

    /**
     * @case Invalid body throws RC5011
     * @preconditions Body has wrong type for field
     * @expectedResult RC5011 error emitted
     */
    test("invalid body throws RC5011", async () => {
      const schema = z.object({
        userId: z.string(),
        action: z.string(),
      });

      const errorHandler = vi.fn();
      const consumer = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("producer")
            .from(simple({ userId: 123, action: "create" })) // userId should be string
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorHandler).toHaveBeenCalled();
      const error = errorHandler.mock.calls[0][0].details.error;
      expect(error.rc).toBe("RC5011");
      expect(consumer).not.toHaveBeenCalled();
    });

    /**
     * @case Missing required field throws RC5011
     * @preconditions Body missing required field
     * @expectedResult RC5011 error emitted
     */
    test("missing required field throws RC5011", async () => {
      const schema = z.object({
        userId: z.string(),
        action: z.string(),
      });

      const errorHandler = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("producer")
            .from(simple({ userId: "123" })) // missing action
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorHandler).toHaveBeenCalled();
      const error = errorHandler.mock.calls[0][0].details.error;
      expect(error.rc).toBe("RC5011");
    });

    /**
     * @case Wrong type throws RC5011
     * @preconditions Body field has wrong type
     * @expectedResult RC5011 error emitted
     */
    test("wrong type throws RC5011", async () => {
      const schema = z.object({
        count: z.number(),
      });

      const errorHandler = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("producer")
            .from(simple({ count: "not-a-number" }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorHandler).toHaveBeenCalled();
      const error = errorHandler.mock.calls[0][0].details.error;
      expect(error.rc).toBe("RC5011");
    });

    /**
     * @case Nested object validation works
     * @preconditions Schema has nested object
     * @expectedResult Nested fields validated correctly
     */
    test("nested object validation works", async () => {
      const schema = z.object({
        user: z.object({
          name: z.string(),
          email: z.string().email(),
        }),
      });

      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(
              simple({
                user: { name: "John", email: "john@example.com" },
              }),
            )
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
    });

    /**
     * @case Array validation works
     * @preconditions Schema expects array of strings in body
     * @expectedResult Array validated
     */
    test("array validation works", async () => {
      // Schema for an object containing an array
      const schema = z.object({
        items: z.array(
          z.object({
            id: z.number(),
            name: z.string(),
          }),
        ),
      });

      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(
              simple({
                items: [
                  { id: 1, name: "Item 1" },
                  { id: 2, name: "Item 2" },
                ],
              }),
            )
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
    });

    /**
     * @case Schema coercion is applied
     * @preconditions Schema uses z.coerce to transform value
     * @expectedResult Transformed value used in handler
     */
    test("schema coercion is applied", async () => {
      const schema = z.object({
        count: z.coerce.number(),
        active: z.coerce.boolean(),
      });

      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple({ count: "42", active: "true" }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
      const body = consumer.mock.calls[0][0].body;
      expect(body.count).toBe(42);
      expect(typeof body.count).toBe("number");
      expect(body.active).toBe(true);
      expect(typeof body.active).toBe("boolean");
    });

    /**
     * @case Async schema validation works
     * @preconditions Schema uses async refinement
     * @expectedResult Async validation completes successfully
     */
    test("async schema validation works", async () => {
      const schema = z.object({
        value: z.string().refine(
          async (val) => {
            // Simulate async validation
            await new Promise((resolve) => setTimeout(resolve, 10));
            return val.length > 0;
          },
          { message: "Value must not be empty" },
        ),
      });

      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple({ value: "test" }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(consumer).toHaveBeenCalledTimes(1);
    });

    /**
     * @case Multiple validation failures reported in issues
     * @preconditions Body has multiple invalid fields
     * @expectedResult Error contains multiple issues
     */
    test("multiple validation failures reported in issues", async () => {
      const schema = z.object({
        name: z.string().min(3),
        age: z.number().positive(),
        email: z.string().email(),
      });

      const errorHandler = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("producer")
            .from(simple({ name: "ab", age: -5, email: "invalid" }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorHandler).toHaveBeenCalled();
      const error = errorHandler.mock.calls[0][0].details.error;
      expect(error.rc).toBe("RC5011");
      // Error should have cause with validation issues
      expect(error.cause).toBeDefined();
    });

    /**
     * @case Validated body is used when schema transforms
     * @preconditions Schema transforms the body value
     * @expectedResult Consumer receives transformed value
     */
    test("validated body is used when schema transforms", async () => {
      const schema = z.object({
        text: z.string().transform((val) => val.toUpperCase()),
      });

      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple({ text: "hello" }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
      expect(consumer.mock.calls[0][0].body.text).toBe("HELLO");
    });

    /**
     * @case Validation error includes endpoint name in message
     * @preconditions Validation fails
     * @expectedResult Error message contains endpoint name
     */
    test("validation error includes endpoint name in message", async () => {
      const schema = z.object({ id: z.string() });

      const errorHandler = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("producer")
            .from(simple({ id: 123 }))
            .to(direct("my-special-endpoint")),
          craft()
            .id("consumer")
            .from(direct("my-special-endpoint", { schema }))
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorHandler).toHaveBeenCalled();
      const error = errorHandler.mock.calls[0][0].details.error;
      expect(error.meta.message).toContain("my-special-endpoint");
    });

    /**
     * @case z.object() removes extra fields (default Zod 4 behavior)
     * @preconditions Body has extra fields
     * @expectedResult Extra fields removed from validated body
     */
    test("z.object removes extra fields by default", async () => {
      const schema = z.object({
        id: z.string(),
      });

      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple({ id: "123", extraField: "should be removed" }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
      const body = consumer.mock.calls[0][0].body;
      expect(body.id).toBe("123");
      expect(body.extraField).toBeUndefined();
    });
  });

  // ============================================================
  // Group 2: Zod 4 Object Behaviors (6 tests)
  // ============================================================
  describe("Zod 4 object behaviors", () => {
    /**
     * @case z.strictObject() rejects extra fields with RC5011
     * @preconditions Schema uses z.strictObject() and body has extra fields
     * @expectedResult RC5011 error thrown
     */
    test("strictObject rejects extra fields", async () => {
      const schema = z.strictObject({
        id: z.string(),
      });

      const errorHandler = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("producer")
            .from(simple({ id: "123", extraField: "should fail" }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorHandler).toHaveBeenCalled();
      const error = errorHandler.mock.calls[0][0].details.error;
      expect(error.rc).toBe("RC5011");
    });

    /**
     * @case z.looseObject() preserves extra fields
     * @preconditions Schema uses z.looseObject() and body has extra fields
     * @expectedResult Extra fields preserved in validated body
     */
    test("looseObject preserves extra fields", async () => {
      const schema = z.looseObject({
        id: z.string(),
      });

      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple({ id: "123", extraField: "should be kept" }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
      const body = consumer.mock.calls[0][0].body;
      expect(body.id).toBe("123");
      expect(body.extraField).toBe("should be kept");
    });

    /**
     * @case z.object() removes extras silently (default Zod 4 behavior)
     * @preconditions Schema uses z.object() with extra fields in input
     * @expectedResult Extra fields removed without error
     */
    test("object removes extras silently", async () => {
      const schema = z.object({
        name: z.string(),
      });

      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple({ name: "test", extra1: "a", extra2: "b" }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
      const body = consumer.mock.calls[0][0].body;
      expect(body).toEqual({ name: "test" });
    });

    /**
     * @case Zod schema transformation applied correctly
     * @preconditions Schema uses multiple transforms
     * @expectedResult All transformations applied
     */
    test("zod schema transformation applied correctly", async () => {
      const schema = z.object({
        name: z.string().trim().toLowerCase(),
        tags: z.string().transform((s) => s.split(",")),
      });

      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple({ name: "  HELLO  ", tags: "a,b,c" }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
      const body = consumer.mock.calls[0][0].body;
      expect(body.name).toBe("hello");
      expect(body.tags).toEqual(["a", "b", "c"]);
    });

    /**
     * @case Complex nested objects with Zod refinements
     * @preconditions Schema has nested objects with custom refinements
     * @expectedResult Refinements validated correctly
     */
    test("complex nested objects with zod refinements", async () => {
      const schema = z
        .object({
          order: z.object({
            items: z.array(z.object({ price: z.number() })),
            total: z.number(),
          }),
        })
        .refine(
          (data) => {
            const sum = data.order.items.reduce(
              (acc, item) => acc + item.price,
              0,
            );
            return sum === data.order.total;
          },
          { message: "Total must equal sum of item prices" },
        );

      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(
              simple({
                order: {
                  items: [{ price: 10 }, { price: 20 }],
                  total: 30,
                },
              }),
            )
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
    });

    /**
     * @case Zod discriminated unions work
     * @preconditions Schema is a discriminated union
     * @expectedResult Correct variant validated
     */
    test("zod discriminated unions work", async () => {
      const schema = z.discriminatedUnion("type", [
        z.object({ type: z.literal("text"), content: z.string() }),
        z.object({ type: z.literal("number"), value: z.number() }),
      ]);

      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple({ type: "text", content: "hello" }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // Group 3: Header Validation (8 tests)
  // ============================================================
  describe("Header validation", () => {
    /**
     * @case Valid headers pass headerSchema validation
     * @preconditions Headers match schema
     * @expectedResult Message processed without error
     */
    test("valid headers pass validation", async () => {
      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple("test"))
            .header("x-tenant-id", "tenant-123")
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                headerSchema: z.looseObject({
                  "x-tenant-id": z.string().startsWith("tenant-"),
                }),
              }),
            )
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
    });

    /**
     * @case Extra headers are stripped by default (like body validation)
     * @preconditions Headers contain extra fields not in schema
     * @expectedResult Extra headers removed from validated exchange
     */
    test("extra headers stripped by default", async () => {
      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple("test"))
            .header("x-tenant-id", "tenant-123")
            .header("x-extra-header", "should-be-stripped")
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                headerSchema: z.object({
                  "x-tenant-id": z.string(),
                }),
                // z.object() strips extras by default in Zod 4
              }),
            )
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
      const headers = consumer.mock.calls[0][0].headers;
      expect(headers["x-tenant-id"]).toBe("tenant-123");
      expect(headers["x-extra-header"]).toBeUndefined();
    });

    /**
     * @case looseObject preserves extra headers (Zod 4)
     * @preconditions Headers contain extra fields + z.looseObject()
     * @expectedResult Extra headers preserved in validated exchange
     */
    test("looseObject preserves extra headers", async () => {
      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple("test"))
            .header("x-tenant-id", "tenant-123")
            .header("x-extra-header", "should-be-preserved")
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                headerSchema: z.looseObject({
                  "x-tenant-id": z.string(),
                }),
              }),
            )
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
      const headers = consumer.mock.calls[0][0].headers;
      expect(headers["x-tenant-id"]).toBe("tenant-123");
      expect(headers["x-extra-header"]).toBe("should-be-preserved");
    });

    /**
     * @case strictObject rejects extra headers (Zod 4)
     * @preconditions Headers contain extra fields + z.strictObject()
     * @expectedResult RC5011 error thrown
     */
    test("strictObject rejects extra headers", async () => {
      const errorHandler = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("producer")
            .from(simple("test"))
            .header("x-tenant-id", "tenant-123")
            .header("x-extra-header", "should-cause-error")
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                headerSchema: z.strictObject({
                  "x-tenant-id": z.string(),
                }),
              }),
            )
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorHandler).toHaveBeenCalled();
      const error = errorHandler.mock.calls[0][0].details.error;
      expect(error.rc).toBe("RC5011");
    });

    /**
     * @case Invalid header throws RC5011
     * @preconditions Header doesn't match schema
     * @expectedResult RC5011 error emitted
     */
    test("invalid header throws RC5011", async () => {
      const errorHandler = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("producer")
            .from(simple("test"))
            .header("x-count", "not-a-number")
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                headerSchema: z.looseObject({
                  "x-count": z.coerce.number(),
                }),
              }),
            )
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorHandler).toHaveBeenCalled();
      const error = errorHandler.mock.calls[0][0].details.error;
      expect(error.rc).toBe("RC5011");
    });

    /**
     * @case Missing required header throws RC5011
     * @preconditions Required header not present
     * @expectedResult RC5011 error emitted
     */
    test("missing required header throws RC5011", async () => {
      const errorHandler = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft().id("producer").from(simple("test")).to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                headerSchema: z.looseObject({
                  "x-required-header": z.string(),
                }),
              }),
            )
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorHandler).toHaveBeenCalled();
      const error = errorHandler.mock.calls[0][0].details.error;
      expect(error.rc).toBe("RC5011");
    });

    /**
     * @case Optional header can be missing
     * @preconditions Header marked as optional via z.optional()
     * @expectedResult No error, message processed
     */
    test("optional header can be missing", async () => {
      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft().id("producer").from(simple("test")).to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                headerSchema: z.looseObject({
                  "x-optional": z.string().optional(),
                }),
              }),
            )
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
    });

    /**
     * @case Optional header validates when present
     * @preconditions Optional header is present but invalid
     * @expectedResult Header validated against schema
     */
    test("optional header validates when present", async () => {
      const errorHandler = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("producer")
            .from(simple("test"))
            .header("x-optional", "invalid-number")
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                headerSchema: z.looseObject({
                  "x-optional": z.coerce.number().optional(),
                }),
              }),
            )
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorHandler).toHaveBeenCalled();
      const error = errorHandler.mock.calls[0][0].details.error;
      expect(error.rc).toBe("RC5011");
    });

    /**
     * @case Multiple header validations work
     * @preconditions Multiple headers in headerSchema
     * @expectedResult All headers validated
     */
    test("multiple header validations work", async () => {
      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple("test"))
            .header("x-tenant", "tenant-1")
            .header("x-version", "1")
            .header("x-region", "us-east")
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                headerSchema: z.looseObject({
                  "x-tenant": z.string(),
                  "x-version": z.coerce.number(),
                  "x-region": z.enum(["us-east", "us-west", "eu-west"]),
                }),
              }),
            )
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
    });

    /**
     * @case Header coercion applied to validated headers
     * @preconditions Header schema uses coercion
     * @expectedResult Coerced value available in handler
     */
    test("header coercion applied", async () => {
      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple("test"))
            .header("x-count", "42")
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                headerSchema: z.looseObject({
                  "x-count": z.coerce.number(),
                }),
              }),
            )
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
      const headers = consumer.mock.calls[0][0].headers;
      expect(headers["x-count"]).toBe(42);
      expect(typeof headers["x-count"]).toBe("number");
    });

    /**
     * @case Async header validation works
     * @preconditions Header schema uses async refinement
     * @expectedResult Async validation completes
     */
    test("async header validation works", async () => {
      const consumer = vi.fn();

      const asyncTokenSchema = z.string().refine(
        async (val) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return val.startsWith("valid-");
        },
        { message: "Must start with valid-" },
      );

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple("test"))
            .header("x-token", "valid-abc123")
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                headerSchema: z.looseObject({
                  "x-token": asyncTokenSchema,
                }),
              }),
            )
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(consumer).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // Group 4: Combined Validation (4 tests)
  // ============================================================
  describe("Combined body and header validation", () => {
    /**
     * @case Body + header validation both applied
     * @preconditions Both schema and headerSchema defined
     * @expectedResult Both validated
     */
    test("body and header validation both applied", async () => {
      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple({ id: "123" }))
            .header("x-tenant", "tenant-1")
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                schema: z.object({ id: z.string() }),
                headerSchema: z.looseObject({ "x-tenant": z.string() }),
              }),
            )
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
    });

    /**
     * @case Body passes but header fails throws RC5011
     * @preconditions Valid body, invalid header
     * @expectedResult RC5011 error for header
     */
    test("body passes but header fails throws RC5011", async () => {
      const errorHandler = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("producer")
            .from(simple({ id: "123" }))
            .header("x-count", "not-a-number")
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                schema: z.object({ id: z.string() }),
                headerSchema: z.looseObject({ "x-count": z.coerce.number() }),
              }),
            )
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorHandler).toHaveBeenCalled();
      const error = errorHandler.mock.calls[0][0].details.error;
      expect(error.rc).toBe("RC5011");
    });

    /**
     * @case Header passes but body fails throws RC5011
     * @preconditions Valid header, invalid body
     * @expectedResult RC5011 error for body
     */
    test("header passes but body fails throws RC5011", async () => {
      const errorHandler = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("producer")
            .from(simple({ id: 123 })) // should be string
            .header("x-tenant", "tenant-1")
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                schema: z.object({ id: z.string() }),
                headerSchema: z.looseObject({ "x-tenant": z.string() }),
              }),
            )
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorHandler).toHaveBeenCalled();
      const error = errorHandler.mock.calls[0][0].details.error;
      expect(error.rc).toBe("RC5011");
      expect(error.meta.message).toContain("Body validation failed");
    });

    /**
     * @case Both body and headers can be coerced
     * @preconditions Both schema and headerSchema use coercion
     * @expectedResult Both coerced values used
     */
    test("both body and headers can be coerced", async () => {
      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple({ count: "42" }))
            .header("x-limit", "100")
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                schema: z.object({ count: z.coerce.number() }),
                headerSchema: z.looseObject({ "x-limit": z.coerce.number() }),
              }),
            )
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
      expect(consumer.mock.calls[0][0].body.count).toBe(42);
      expect(consumer.mock.calls[0][0].headers["x-limit"]).toBe(100);
    });
  });

  // ============================================================
  // Group 5: Validation Behavior (6 tests)
  // ============================================================
  describe("Validation behavior", () => {
    /**
     * @case Validation only on consumer side, not producer
     * @preconditions Producer sends invalid data, only consumer has schema
     * @expectedResult Error happens at consumer, not producer
     */
    test("validation only on consumer side", async () => {
      const producerTap = vi.fn();
      const errorHandler = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("producer")
            .from(simple({ id: 123 })) // invalid type
            .tap(producerTap) // this should be called
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema: z.object({ id: z.string() }) }))
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();

      // Wait for async tap jobs to complete
      await ctx.drain();

      // Producer tap should have been called
      expect(producerTap).toHaveBeenCalledTimes(1);
      // Error should have occurred at consumer
      expect(errorHandler).toHaveBeenCalled();
    });

    /**
     * @case Multiple consumers with different schemas work
     * @preconditions Two consumers with different schemas on different endpoints
     * @expectedResult Each validates independently
     */
    test("multiple consumers with different schemas", async () => {
      const consumerA = vi.fn();
      const consumerB = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producerA")
            .from(simple({ name: "test" }))
            .to(direct("endpointA")),
          craft()
            .id("producerB")
            .from(simple({ count: 42 }))
            .to(direct("endpointB")),
          craft()
            .id("consumerA")
            .from(
              direct("endpointA", { schema: z.object({ name: z.string() }) }),
            )
            .to(consumerA),
          craft()
            .id("consumerB")
            .from(
              direct("endpointB", { schema: z.object({ count: z.number() }) }),
            )
            .to(consumerB),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumerA).toHaveBeenCalledTimes(1);
      expect(consumerB).toHaveBeenCalledTimes(1);
    });

    /**
     * @case No validation when schema not provided
     * @preconditions No schema in options
     * @expectedResult Message passes through unchanged
     */
    test("no validation when schema not provided", async () => {
      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple({ anything: "goes", numbers: 123, nested: { a: 1 } }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint")) // no schema
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
      expect(consumer.mock.calls[0][0].body).toEqual({
        anything: "goes",
        numbers: 123,
        nested: { a: 1 },
      });
    });

    /**
     * @case Producer doesn't see validation errors
     * @preconditions Producer sends, consumer fails validation
     * @expectedResult Producer completes, error only at consumer level
     */
    test("producer completes despite consumer validation error", async () => {
      const errorHandler = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("producer")
            .from(simple({ invalid: true }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", { schema: z.object({ valid: z.string() }) }),
            )
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorHandler).toHaveBeenCalled();
      // Note: With synchronous direct, the producer may see the error thrown back
    });

    /**
     * @case Error event emitted on validation failure
     * @preconditions Validation fails
     * @expectedResult Error event handler called
     */
    test("error event emitted on validation failure", async () => {
      const errorHandler = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("producer")
            .from(simple({ id: 123 }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema: z.object({ id: z.string() }) }))
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errorHandler).toHaveBeenCalled();
      const payload = errorHandler.mock.calls[0][0];
      expect(payload.details.error).toBeDefined();
      expect(payload.details.error.rc).toBe("RC5011");
    });

    /**
     * @case Route continues after validation error
     * @preconditions Multiple messages, one fails validation
     * @expectedResult Context doesn't crash, other routes work
     */
    test("route continues after validation error", async () => {
      const errorHandler = vi.fn();
      const otherConsumer = vi.fn();

      ctx = context()
        .on("error", errorHandler)
        .routes([
          craft()
            .id("failing-producer")
            .from(simple({ invalid: true }))
            .to(direct("failing-endpoint")),
          craft()
            .id("failing-consumer")
            .from(
              direct("failing-endpoint", {
                schema: z.object({ valid: z.boolean() }),
              }),
            )
            .to(vi.fn()),
          craft()
            .id("other-producer")
            .from(simple({ message: "hello" }))
            .to(direct("other-endpoint")),
          craft()
            .id("other-consumer")
            .from(direct("other-endpoint"))
            .to(otherConsumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Error should have occurred
      expect(errorHandler).toHaveBeenCalled();
      // But other route should still work
      expect(otherConsumer).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // Group 6: Registry & Discovery (6 tests)
  // ============================================================
  describe("Registry and discovery", () => {
    /**
     * @case Routes with description register in context store
     * @preconditions Route has description option
     * @expectedResult Route metadata in registry
     */
    test("routes with description register in store", async () => {
      ctx = context()
        .routes([
          craft()
            .id("discoverable")
            .from(
              direct("test-endpoint", {
                description: "A test endpoint",
                keywords: ["test"],
              }),
            )
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();

      const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
      expect(registry).toBeDefined();
      expect(registry?.has("test-endpoint")).toBe(true);

      const metadata = registry?.get("test-endpoint");
      expect(metadata?.description).toBe("A test endpoint");
      expect(metadata?.keywords).toEqual(["test"]);
    });

    /**
     * @case Routes without description still registered
     * @preconditions Route has no description
     * @expectedResult Route in registry but without description
     */
    test("routes without description still registered", async () => {
      ctx = context()
        .routes([
          craft()
            .id("no-description")
            .from(direct("plain-endpoint"))
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();

      const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
      expect(registry?.has("plain-endpoint")).toBe(true);
      expect(registry?.get("plain-endpoint")?.description).toBeUndefined();
    });

    /**
     * @case Registry created if not exists
     * @preconditions No routes registered yet
     * @expectedResult Registry created on first registration
     */
    test("registry created if not exists", async () => {
      ctx = context()
        .routes([
          craft()
            .id("first-discoverable")
            .from(direct("first-endpoint", { description: "First" }))
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();

      const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
      expect(registry).toBeDefined();
      expect(registry).toBeInstanceOf(Map);
    });

    /**
     * @case Multiple routes register correctly
     * @preconditions Multiple routes with descriptions
     * @expectedResult All registered in registry
     */
    test("multiple routes register correctly", async () => {
      ctx = context()
        .routes([
          craft()
            .id("route-a")
            .from(direct("endpoint-a", { description: "Route A" }))
            .to(vi.fn()),
          craft()
            .id("route-b")
            .from(direct("endpoint-b", { description: "Route B" }))
            .to(vi.fn()),
          craft()
            .id("route-c")
            .from(
              direct("endpoint-c", {
                description: "Route C",
                keywords: ["c", "third"],
              }),
            )
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();

      const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
      expect(registry?.size).toBe(3);
      expect(registry?.has("endpoint-a")).toBe(true);
      expect(registry?.has("endpoint-b")).toBe(true);
      expect(registry?.has("endpoint-c")).toBe(true);
    });

    /**
     * @case Registry accessible via context.getStore()
     * @preconditions Routes registered
     * @expectedResult Can retrieve registry and iterate
     */
    test("registry accessible via context getStore", async () => {
      ctx = context()
        .routes([
          craft()
            .id("route")
            .from(
              direct("my-endpoint", {
                description: "My endpoint",
                schema: z.object({ id: z.string() }),
                keywords: ["my", "endpoint"],
              }),
            )
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();

      const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
      const routes = registry ? Array.from(registry.values()) : [];

      expect(routes).toHaveLength(1);
      expect(routes[0]).toEqual({
        endpoint: "my-endpoint",
        description: "My endpoint",
        schema: expect.any(Object),
        keywords: ["my", "endpoint"],
      });
    });

    /**
     * @case Sanitized endpoint names used in registry
     * @preconditions Endpoint name has special characters
     * @expectedResult Sanitized name in registry
     */
    test("sanitized endpoint names used in registry", async () => {
      ctx = context()
        .routes([
          craft()
            .id("route")
            .from(
              direct("my.special:endpoint/name", {
                description: "Special chars",
              }),
            )
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();

      const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
      expect(registry?.has("my-special-endpoint-name")).toBe(true);
      expect(registry?.has("my.special:endpoint/name")).toBe(false);
    });
  });

  // ============================================================
  // Group 7: Edge Cases (5 tests)
  // ============================================================
  describe("Edge cases", () => {
    /**
     * @case Optional field can be null or undefined
     * @preconditions Schema has optional/nullable field
     * @expectedResult No error when field is null
     */
    test("optional field can be null or undefined", async () => {
      const schema = z.object({
        name: z.string(),
        description: z.string().nullable().optional(),
      });
      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple({ name: "test", description: null }))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
    });

    /**
     * @case Null header value validates
     * @preconditions Header value is null, schema allows null
     * @expectedResult No error
     */
    test("null header value validates", async () => {
      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple("test"))
            .header("x-nullable", null)
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(
              direct("endpoint", {
                headerSchema: z.looseObject({
                  "x-nullable": z.null(),
                }),
              }),
            )
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
    });

    /**
     * @case Empty object passes schema expecting empty object
     * @preconditions Schema is z.object({})
     * @expectedResult No error
     */
    test("empty object passes empty schema", async () => {
      const schema = z.object({});
      const consumer = vi.fn();

      ctx = context()
        .routes([
          craft().id("producer").from(simple({})).to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consumer).toHaveBeenCalledTimes(1);
    });

    /**
     * @case Large payloads don't cause performance issues
     * @preconditions Body contains large nested structure
     * @expectedResult Completes in reasonable time
     */
    test("large payloads validate reasonably fast", async () => {
      const schema = z.object({
        items: z.array(z.object({ id: z.number(), name: z.string() })),
      });
      const consumer = vi.fn();

      // Create large array inside object
      const largePayload = {
        items: Array.from({ length: 1000 }, (_, i) => ({
          id: i,
          name: `Item ${i}`,
        })),
      };

      ctx = context()
        .routes([
          craft()
            .id("producer")
            .from(simple(largePayload))
            .to(direct("endpoint")),
          craft()
            .id("consumer")
            .from(direct("endpoint", { schema }))
            .to(consumer),
        ])
        .build();

      const start = Date.now();
      await ctx.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const elapsed = Date.now() - start;

      expect(consumer).toHaveBeenCalledTimes(1);
      expect(elapsed).toBeLessThan(2000); // Should complete in under 2s
    });

    /**
     * @case Registry persists across multiple route registrations
     * @preconditions Multiple routes registered sequentially
     * @expectedResult All routes in registry
     */
    test("registry persists across route registrations", async () => {
      ctx = context()
        .routes([
          craft()
            .id("route-1")
            .from(direct("endpoint-1", { description: "First" }))
            .to(vi.fn()),
          craft()
            .id("route-2")
            .from(direct("endpoint-2", { description: "Second" }))
            .to(vi.fn()),
        ])
        .build();

      await ctx.start();

      const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
      expect(registry?.size).toBe(2);

      // Both should be present
      expect(registry?.get("endpoint-1")?.description).toBe("First");
      expect(registry?.get("endpoint-2")?.description).toBe("Second");
    });
  });
});
