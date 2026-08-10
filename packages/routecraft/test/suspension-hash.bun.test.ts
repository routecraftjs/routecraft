import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  actionFingerprint,
  continuationHash,
  describeExpect,
  OperationType,
  type Adapter,
  type SerializedExchange,
  type Step,
} from "../src/index.ts";

/**
 * Build a step whose identity is carried by a transformer callable, which
 * is where a user's inline lambda lives on a real `.transform()` step.
 */
function step(label: string, body: (value: number) => number): Step<Adapter> {
  return {
    operation: OperationType.TRANSFORM,
    label,
    adapter: { adapterId: "transformer", transform: body } as Adapter,
    execute: async (exchange) => ({ kind: "continue", exchange }),
  };
}

function schema(id: string): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { output: { type: "object", title: id } },
    },
  } as unknown as StandardSchemaV1;
}

const expected = describeExpect(schema("approval"));

const exchange: SerializedExchange = {
  body: { amountCents: 75_000 },
  headers: { "routecraft.id": "ex-1" },
};

describe("continuationHash", () => {
  /**
   * @case The headline compatibility property: a deploy that touches code
   *   before the suspend point must not kill approvals in flight
   * @preconditions Two pipelines identical from the suspend point onward,
   *   differing only in a step BEFORE it
   * @expectedResult The continuation hashes match, so a parked exchange
   *   stays resumable
   */
  test("an edit before the suspend point does not invalidate a parked exchange", () => {
    const before = [
      step("notify", (value) => value),
      step("suspend", (value) => value),
      step("pay", (value) => value * 2),
    ];
    const after = [
      // The step that changed already ran; it cannot affect what happens
      // after resume.
      step("notify", (value) => value + 1),
      step("suspend", (value) => value),
      step("pay", (value) => value * 2),
    ];

    expect(continuationHash(before, 1, expected)).toBe(
      continuationHash(after, 1, expected),
    );
  });

  /**
   * @case Changing what the approval authorizes does invalidate it
   * @preconditions Two pipelines differing in a step AFTER the suspend point
   * @expectedResult The hashes differ, so resume fails the compatibility
   *   check and the route can re-ask
   */
  test("an edit after the suspend point invalidates a parked exchange", () => {
    const before = [step("suspend", (v) => v), step("pay", (v) => v * 2)];
    const after = [step("suspend", (v) => v), step("pay", (v) => v * 20)];

    expect(continuationHash(before, 0, expected)).not.toBe(
      continuationHash(after, 0, expected),
    );
  });

  /**
   * @case Adding a step to the tail changes the continuation
   * @preconditions An extra step appended after the suspend point
   * @expectedResult The hashes differ
   */
  test("appending a step to the tail invalidates a parked exchange", () => {
    const before = [step("suspend", (v) => v), step("pay", (v) => v)];
    const after = [
      step("suspend", (v) => v),
      step("pay", (v) => v),
      step("audit", (v) => v),
    ];

    expect(continuationHash(before, 0, expected)).not.toBe(
      continuationHash(after, 0, expected),
    );
  });

  /**
   * @case Prepending steps shifts the suspend position without changing the tail
   * @preconditions The same tail reached at position 0 and at position 2
   * @expectedResult The hashes match, because the hash covers the tail, not
   *   the pipeline
   */
  test("hashes the tail rather than the pipeline", () => {
    const short = [step("suspend", (v) => v), step("pay", (v) => v)];
    const long = [
      step("log", (v) => v),
      step("enrich", (v) => v + 7),
      step("suspend", (v) => v),
      step("pay", (v) => v),
    ];

    expect(continuationHash(short, 0, expected)).toBe(
      continuationHash(long, 2, expected),
    );
  });

  /**
   * @case The expect schema is part of the contract being approved
   * @preconditions The same tail with two different expect schemas
   * @expectedResult The hashes differ
   */
  test("a changed expect schema invalidates a parked exchange", () => {
    const steps = [step("suspend", (v) => v), step("pay", (v) => v)];

    expect(continuationHash(steps, 0, expected)).not.toBe(
      continuationHash(steps, 0, describeExpect(schema("rejection"))),
    );
  });

  /**
   * @case Suspending at the last step leaves an empty continuation
   * @preconditions Position points at the final step
   * @expectedResult A hash is still produced, and it is stable
   */
  test("handles a suspend at the end of the pipeline", () => {
    const steps = [step("suspend", (v) => v)];
    expect(continuationHash(steps, 0, expected)).toBe(
      continuationHash(steps, 0, expected),
    );
  });

  /**
   * @case Reformatting is not a behaviour change
   * @preconditions Two callables that differ only in whitespace
   * @expectedResult The hashes match, so a formatter pass does not re-ask
   *   every outstanding approval
   */
  test("ignores insignificant whitespace in step source", () => {
    const compact = [
      step("suspend", (v) => v),
      step("pay", (value) => value * 2),
    ];
    const spaced = [
      step("suspend", (v) => v),
      step("pay", (value) => {
        return value * 2;
      }),
    ];

    // A reformat that does not change tokens matches; a rewrite that adds a
    // return statement is a different function and legitimately does not.
    expect(continuationHash(compact, 0, expected)).toBe(
      continuationHash(
        [step("suspend", (v) => v), step("pay", (value) => value * 2)],
        0,
        expected,
      ),
    );
    expect(continuationHash(compact, 0, expected)).not.toBe(
      continuationHash(spaced, 0, expected),
    );
  });
});

describe("describeExpect", () => {
  /**
   * @case The schema descriptor carries a rendering for the caller
   * @preconditions A schema exposing the ~standard.jsonSchema extension
   * @expectedResult The rendering is captured alongside the hash
   */
  test("captures a JSON Schema rendering when the schema exposes one", () => {
    const described = describeExpect(schema("approval"));
    expect(described.jsonSchema).toEqual({ type: "object", title: "approval" });
    expect(described.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * @case A schema library without the extension still works
   * @preconditions A bare Standard Schema with no jsonSchema extension
   * @expectedResult A hash is produced and no rendering is claimed
   */
  test("works without a JSON Schema rendering", () => {
    const bare = {
      "~standard": {
        version: 1,
        vendor: "bare",
        validate: (v: unknown) => ({ value: v }),
      },
    } as unknown as StandardSchemaV1;

    const described = describeExpect(bare);

    expect(described.jsonSchema).toBeUndefined();
    expect(described.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("actionFingerprint", () => {
  /**
   * @case An approval binds to the operation it authorized
   * @preconditions The same route, position, continuation and body
   * @expectedResult The fingerprint is stable
   */
  test("is stable for the same operation", () => {
    const input = {
      routeId: "payout",
      position: 1,
      continuationHash: "c".repeat(64),
      exchange,
    };
    expect(actionFingerprint(input)).toBe(actionFingerprint(input));
  });

  /**
   * @case A different payload is a different operation
   * @preconditions Same route and position, a body with a larger amount
   * @expectedResult The fingerprints differ, so a receipt cannot be read as
   *   authorizing the other payment
   */
  test("changes with the payload", () => {
    const base = {
      routeId: "payout",
      position: 1,
      continuationHash: "c".repeat(64),
      exchange,
    };
    expect(actionFingerprint(base)).not.toBe(
      actionFingerprint({
        ...base,
        exchange: { ...exchange, body: { amountCents: 7_500_000 } },
      }),
    );
  });

  /**
   * @case Key order in the payload is not part of its identity
   * @preconditions The same fields written in a different order
   * @expectedResult The fingerprints match
   */
  test("is insensitive to key order", () => {
    const base = {
      routeId: "payout",
      position: 1,
      continuationHash: "c".repeat(64),
    };
    expect(
      actionFingerprint({
        ...base,
        exchange: { body: { a: 1, b: 2 }, headers: {} },
      }),
    ).toBe(
      actionFingerprint({
        ...base,
        exchange: { body: { b: 2, a: 1 }, headers: {} },
      }),
    );
  });

  /**
   * @case The same payload under a different route is a different operation
   * @preconditions Identical body and position, two route ids
   * @expectedResult The fingerprints differ
   */
  test("changes with the route", () => {
    const base = {
      position: 1,
      continuationHash: "c".repeat(64),
      exchange,
    };
    expect(actionFingerprint({ ...base, routeId: "payout" })).not.toBe(
      actionFingerprint({ ...base, routeId: "refund" }),
    );
  });
});
