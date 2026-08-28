import { describe, expect, test } from "bun:test";
import { safeStringify } from "../src/shared/safe-json.ts";

/**
 * The shared serialiser two surfaces put bus payloads through: the telemetry
 * sink and the ops event tail. Both feed it values that were never written to
 * be JSON, so what matters is that it reduces them honestly and never loses
 * more than the field it could not render.
 */
describe("safeStringify", () => {
  /**
   * @case A payload shaped like a route but carrying a nullish definition does not collapse
   * @preconditions An object with `definition: null` and `context`, the shape the old structural check matched
   * @expectedResult The value serialises normally; it is not replaced wholesale by a serialisation error
   */
  test("a route-shaped payload with a nullish definition survives", () => {
    const parsed = JSON.parse(
      safeStringify({ definition: null, context: {}, keep: "me" }),
    ) as Record<string, unknown>;
    expect(parsed["_serializationError"]).toBeUndefined();
    expect(parsed["keep"]).toBe("me");
  });

  /**
   * @case A user payload that merely looks like a framework object keeps its fields
   * @preconditions An object carrying id, headers, body and logger keys but no framework brand
   * @expectedResult Every field survives, because identification is by brand rather than by shape
   */
  test("an exchange-shaped user payload is not reduced", () => {
    const parsed = JSON.parse(
      safeStringify({ id: "x", headers: {}, body: 1, logger: "noop" }),
    ) as Record<string, unknown>;
    expect(parsed["exchangeId"]).toBeUndefined();
    expect(parsed["body"]).toBe(1);
  });

  /**
   * @case Errors keep what a reader needs and cycles do not throw
   * @preconditions An Error, and an object holding a reference to itself
   * @expectedResult The error renders name and message; the cycle renders as a marker
   */
  test("errors render and cycles are marked", () => {
    const parsed = JSON.parse(safeStringify({ err: new Error("boom") })) as {
      err: { name: string; message: string };
    };
    expect(parsed.err.message).toBe("boom");

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(safeStringify(cyclic)).toContain("[Circular]");
  });

  /**
   * @case Snapshot payloads are dropped when the caller has not asked for them
   * @preconditions A payload carrying a _snapshot sub-object, with dropSnapshot set
   * @expectedResult The _snapshot key is absent and the rest is intact
   */
  test("dropSnapshot omits payload sub-objects", () => {
    const parsed = JSON.parse(
      safeStringify(
        { routeId: "r", _snapshot: { body: "secret" } },
        { dropSnapshot: true },
      ),
    ) as Record<string, unknown>;
    expect(parsed["_snapshot"]).toBeUndefined();
    expect(parsed["routeId"]).toBe("r");
  });

  /**
   * @case A value with no JSON representation still yields a string
   * @preconditions Top-level undefined, a function and a symbol, which JSON.stringify answers undefined for
   * @expectedResult Each renders as "null", so a caller writing to a wire never handles a non-string
   */
  test("an unrepresentable top-level value renders as null", () => {
    for (const value of [undefined, () => {}, Symbol("x")]) {
      const out = safeStringify(value);
      expect(typeof out).toBe("string");
      expect(out).toBe("null");
    }
  });
});
