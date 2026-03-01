import { describe, test, expect, afterEach, vi } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, json, JsonAdapter } from "@routecraft/routecraft";

describe("JSON Adapter", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  describe("parse", () => {
    /**
     * @case Parses JSON string and returns full object when no path option
     * @preconditions Body is JSON string, no path option
     * @expectedResult Full parsed object is returned
     */
    test("parses JSON string and returns full object when no path", async () => {
      const destSpy = vi.fn();
      const payload = { data: { name: "test" } };

      t = await testContext()
        .routes(
          craft()
            .id("json-parse-full")
            .from(simple(JSON.stringify(payload)))
            .transform(json())
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy).toHaveBeenCalledTimes(1);
      expect(destSpy.mock.calls[0][0].body).toEqual(payload);
    });

    /**
     * @case Default uses body.body when body is object (e.g. after http)
     * @preconditions Body is object with string body property, no from option
     * @expectedResult Parsed JSON from body.body is returned
     */
    test("default uses body.body when body is object (e.g. after http)", async () => {
      const destSpy = vi.fn();
      const payload = { id: 1, title: "From body.body" };
      const httpLike = {
        status: 200,
        headers: {} as Record<string, string>,
        body: JSON.stringify(payload),
        url: "https://api.example.com",
      };

      t = await testContext()
        .routes(
          craft()
            .id("json-default-body-body")
            .from(simple(httpLike))
            .transform(json())
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy.mock.calls[0][0].body).toEqual(payload);
    });

    /**
     * @case Invalid JSON string throws from transform
     * @preconditions Body is invalid JSON string
     * @expectedResult transform() throws with message containing "failed to parse"
     */
    test("invalid JSON throws from transform", () => {
      const adapter = new JsonAdapter({});
      expect(() => adapter.transform("not json {")).toThrow(
        /json adapter: failed to parse/,
      );
    });
  });

  describe("path extraction", () => {
    /**
     * @case path option extracts nested value by dot notation
     * @preconditions path like "data.user.name" on parsed object
     * @expectedResult Value at path is returned
     */
    test("path extracts nested value", async () => {
      const destSpy = vi.fn();
      const payload = { data: { user: { name: "Alice" } } };

      t = await testContext()
        .routes(
          craft()
            .id("json-path-nested")
            .from(simple(JSON.stringify(payload)))
            .transform(json({ path: "data.user.name" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy.mock.calls[0][0].body).toBe("Alice");
    });

    /**
     * @case path with array index e.g. items[0].id
     * @preconditions path includes [index] segment
     * @expectedResult Value at path including array element is returned
     */
    test("path with array index", async () => {
      const destSpy = vi.fn();
      const payload = { items: [{ id: 1 }, { id: 2 }] };

      t = await testContext()
        .routes(
          craft()
            .id("json-path-array")
            .from(simple(JSON.stringify(payload)))
            .transform(json({ path: "items[0].id" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy.mock.calls[0][0].body).toBe(1);
    });

    /**
     * @case path to missing key returns undefined
     * @preconditions path references non-existent key
     * @expectedResult undefined is returned
     */
    test("path to missing key returns undefined", async () => {
      const destSpy = vi.fn();

      t = await testContext()
        .routes(
          craft()
            .id("json-path-missing")
            .from(simple(JSON.stringify({ a: 1 })))
            .transform(json({ path: "b.c" }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy.mock.calls[0][0].body).toBeUndefined();
    });
  });

  describe("from option", () => {
    /**
     * @case from option plucks JSON string from custom property
     * @preconditions Body is object, from() returns string from custom key
     * @expectedResult Parsed JSON from that string is returned
     */
    test("from option plucks JSON string from custom property", async () => {
      const destSpy = vi.fn();
      const payload = { value: 42 };
      const wrapped = { raw: JSON.stringify(payload) };

      t = await testContext()
        .routes(
          craft()
            .id("json-from")
            .from(simple(wrapped))
            .transform(json({ from: (b) => b.raw }))
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy.mock.calls[0][0].body).toEqual(payload);
    });
  });

  describe("getValue option", () => {
    /**
     * @case getValue extracts/transforms parsed value; result is typed and becomes body when no to
     * @preconditions path + getValue return object
     * @expectedResult Body is the return value of getValue
     */
    test("getValue transforms path result and replaces body", async () => {
      const destSpy = vi.fn();
      const payload = { data: { name: "Alice", count: 2 } };

      t = await testContext()
        .routes(
          craft()
            .id("json-getValue")
            .from(simple(JSON.stringify(payload)))
            .transform(
              json({
                path: "data",
                getValue: (p) =>
                  typeof p === "object" && p !== null && "name" in p
                    ? { extracted: (p as { name: string }).name }
                    : { extracted: "" },
              }),
            )
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      expect(destSpy.mock.calls[0][0].body).toEqual({
        extracted: "Alice",
      });
    });
  });

  describe("to option", () => {
    /**
     * @case to option writes parsed result to a sub-field of body
     * @preconditions from plucks JSON string, to writes result to body.parsed
     * @expectedResult Body is { ...body, parsed: result }
     */
    test("to option writes result to sub-field", async () => {
      const destSpy = vi.fn();
      const payload = { data: { x: 1 } };
      const wrapped = {
        status: 200,
        body: JSON.stringify(payload),
      };

      t = await testContext()
        .routes(
          craft()
            .id("json-to-subfield")
            .from(simple(wrapped))
            .transform(
              json({
                to: (body, result) => ({ ...body, parsed: result }),
              }),
            )
            .to(destSpy),
        )
        .build();

      await t.ctx.start();

      const out = destSpy.mock.calls[0][0].body as {
        status: number;
        body: string;
        parsed: unknown;
      };
      expect(out.status).toBe(200);
      expect(out.body).toBe(JSON.stringify(payload));
      expect(out.parsed).toEqual(payload);
    });
  });
});
