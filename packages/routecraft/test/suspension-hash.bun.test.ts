import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { file } from "../src/adapters/file/index.ts";
import {
  OperationType,
  type Adapter,
  type SerializedExchange,
  type Step,
} from "../src/index.ts";
// Engine machinery, reached through the intra-package barrel.
import {
  actionFingerprint,
  continuationTailHash,
  describeSchema,
} from "../src/suspension/index.ts";

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

/**
 * Stand-in for a class-based adapter, which is where the real risk lives:
 * config sits in a data property and the callable's source text is
 * identical for every instance, so an options change is invisible to a
 * digest built from callables alone.
 */
class PayoutAdapter {
  readonly adapterId = "routecraft.adapter.payout";
  constructor(readonly options: Record<string, unknown>) {}
  send = async (): Promise<void> => {
    await Promise.resolve(String(this.options["url"]));
  };
}

/** Wrap a real factory-built adapter as a tail step. */
function destination(adapter: unknown): Step<Adapter> {
  return {
    operation: OperationType.TO,
    label: "write",
    adapter: adapter as Adapter,
    execute: async (exchange) => ({ kind: "continue", exchange }),
  };
}

function configuredStep(options: Record<string, unknown>): Step<Adapter> {
  return {
    operation: OperationType.TO,
    label: "pay",
    adapter: new PayoutAdapter(options) as unknown as Adapter,
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

const expected = describeSchema(schema("approval"));

const exchange: SerializedExchange = {
  body: { amountCents: 75_000 },
  headers: { "routecraft.id": "ex-1" },
};

describe("continuationTailHash", () => {
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

    expect(continuationTailHash(before.slice(2), expected)).toBe(
      continuationTailHash(after.slice(2), expected),
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

    expect(continuationTailHash(before.slice(1), expected)).not.toBe(
      continuationTailHash(after.slice(1), expected),
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

    expect(continuationTailHash(before.slice(1), expected)).not.toBe(
      continuationTailHash(after.slice(1), expected),
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

    expect(continuationTailHash(short.slice(1), expected)).toBe(
      continuationTailHash(long.slice(3), expected),
    );
  });

  /**
   * @case The expect schema is part of the contract being approved
   * @preconditions The same tail with two different expect schemas
   * @expectedResult The hashes differ
   */
  test("a changed expect schema invalidates a parked exchange", () => {
    const steps = [step("suspend", (v) => v), step("pay", (v) => v)];

    expect(continuationTailHash(steps.slice(1), expected)).not.toBe(
      continuationTailHash(steps.slice(1), describeSchema(schema("rejection"))),
    );
  });

  /**
   * @case Suspending at the last step leaves an empty continuation
   * @preconditions Position points at the final step
   * @expectedResult A hash is still produced, and it is stable
   */
  test("handles a suspend at the end of the pipeline", () => {
    const steps = [step("suspend", (v) => v)];
    expect(continuationTailHash(steps.slice(1), expected)).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(continuationTailHash(steps.slice(1), expected)).toBe(
      continuationTailHash(steps.slice(1), expected),
    );
  });

  /**
   * @case Source text is taken verbatim, so insignificant edits move the hash
   * @preconditions The same body with CRLF and with LF, differing only in
   *   whitespace no JavaScript engine treats as meaningful
   * @expectedResult The hashes DIFFER. This is the accepted cost of refusing
   *   to normalize: every fold that would make these match is also a chance
   *   to miss a real change, and the failure this asserts costs an
   *   error-channel re-ask while the one it prevents resumes a parked
   *   approval into different behaviour.
   */
  test("does not normalize insignificant whitespace in step source", () => {
    // Built with `new Function` so a formatter cannot erase the very
    // difference under test: the two bodies are token-identical.
    const crlf = new Function("value", "return value *\r\n\t\t2;") as (
      value: number,
    ) => number;
    const lf = new Function("value", "return value *\n  2;") as (
      value: number,
    ) => number;

    expect(
      continuationTailHash(
        [step("s", (v) => v), step("pay", crlf)].slice(1),
        expected,
      ),
    ).not.toBe(
      continuationTailHash(
        [step("s", (v) => v), step("pay", lf)].slice(1),
        expected,
      ),
    );
  });

  /**
   * @case Whitespace inside a string literal is part of the behaviour
   * @preconditions Two callables whose only difference is the spacing inside
   *   a string they pass on
   * @expectedResult The hashes differ. Collapsing whitespace everywhere
   *   would make a changed account number read as a reformat.
   */
  test("does not collapse whitespace inside string literals", () => {
    const one = () => "acct 123";
    const two = () => "acct  123";

    expect(
      continuationTailHash(
        [step("s", (v) => v), step("pay", one as never)].slice(1),
        expected,
      ),
    ).not.toBe(
      continuationTailHash(
        [step("s", (v) => v), step("pay", two as never)].slice(1),
        expected,
      ),
    );
  });

  /**
   * @case A rewritten body is a real change, not a reformat
   * @preconditions An expression arrow against a block-bodied equivalent
   * @expectedResult The hashes differ, because the token stream changed
   */
  test("a rewritten function body invalidates a parked exchange", () => {
    const compact = [step("s", (v) => v), step("pay", (value) => value * 2)];
    const block = [
      step("s", (v) => v),
      step("pay", (value) => {
        return value * 2;
      }),
    ];

    expect(continuationTailHash(compact.slice(1), expected)).not.toBe(
      continuationTailHash(block.slice(1), expected),
    );
  });
});

describe("continuationTailHash over adapter configuration", () => {
  /**
   * @case An adapter target carried as a URL moves the digest when it changes
   * @preconditions Two tails identical but for the href of a URL-valued adapter option
   * @expectedResult Different digests, so a payee spelled `new URL(...)` cannot be edited under a parked approval; a class instance the walk cannot project still collapses, which the hash JSDoc states as residue
   */
  test("a URL-valued option is part of the digest", () => {
    expect(
      continuationTailHash(
        [configuredStep({ url: new URL("https://bank-a.example/pay") })],
        expected,
      ),
    ).not.toBe(
      continuationTailHash(
        [configuredStep({ url: new URL("https://bank-b.example/pay") })],
        expected,
      ),
    );
  });

  /**
   * @case A cycle through a collection-valued option terminates instead of exhausting the stack
   * @preconditions An adapter option holding a Map that contains itself, hashed at park time
   * @expectedResult The digest is produced rather than thrown, because the depth bound sits above every recursing branch; a Map is projected within the bound, so two different in-bounds Maps still differ
   */
  test("a self-referential collection option is bounded, not fatal", () => {
    const cyclic = new Map<string, unknown>([["name", "payee"]]);
    cyclic.set("self", cyclic);

    expect(() =>
      continuationTailHash(
        [configuredStep({ url: "https://x", cyclic })],
        expected,
      ),
    ).not.toThrow();

    expect(
      continuationTailHash(
        [configuredStep({ url: "https://x", m: new Map([["to", "bank-a"]]) })],
        expected,
      ),
    ).not.toBe(
      continuationTailHash(
        [configuredStep({ url: "https://x", m: new Map([["to", "bank-b"]]) })],
        expected,
      ),
    );
  });

  /**
   * @case Repointing a destination in the tail invalidates a parked approval
   * @preconditions Two pipelines whose only difference is an adapter option
   *   after the suspend point, on a class-based adapter whose callable
   *   source is identical either way
   * @expectedResult The hashes differ, so an approval cannot be resumed
   *   into a payment to a different payee
   */
  test("a changed adapter option after the suspend point invalidates it", () => {
    const toBankA = [
      step("suspend", (v) => v),
      configuredStep({ url: "https://bank-a.example/pay" }),
    ];
    const toBankB = [
      step("suspend", (v) => v),
      configuredStep({ url: "https://bank-b.example/pay" }),
    ];

    expect(continuationTailHash(toBankA.slice(1), expected)).not.toBe(
      continuationTailHash(toBankB.slice(1), expected),
    );
  });

  /**
   * @case The same configuration still hashes stably
   * @preconditions Two separately constructed adapters with equal options
   * @expectedResult The hashes match, so restarting the process does not
   *   invalidate everything parked before it
   */
  test("identical adapter options hash identically across instances", () => {
    const options = { url: "https://bank-a.example/pay", retries: 3 };

    expect(
      continuationTailHash(
        [step("s", (v) => v), configuredStep({ ...options })].slice(1),
        expected,
      ),
    ).toBe(
      continuationTailHash(
        [step("s", (v) => v), configuredStep({ ...options })].slice(1),
        expected,
      ),
    );
  });

  /**
   * @case An adapter holding a live handle is still hashable
   * @preconditions An adapter whose options carry a client object and a
   *   function, which real adapters routinely do
   * @expectedResult Hashing produces a digest rather than throwing, because
   *   a step that cannot be fully described must still be comparable
   */
  test("tolerates unhashable adapter state", () => {
    const withHandle: Step<Adapter> = {
      operation: OperationType.TO,
      label: "pay",
      adapter: {
        adapterId: "routecraft.adapter.payout",
        // Each of these forces a different placeholder branch: a live client
        // instance is [opaque], a symbol is [unhashable], and nesting past
        // the walk's bound is [deep]. Without one of each the test proves
        // only that hashing does not throw, which every plain object does.
        client: new (class Socket {
          readonly fd = 7;
        })(),
        marker: Symbol("live"),
        nested: { a: { b: { c: { d: { e: "past the bound" } } } } },
        send: async () => undefined,
      } as unknown as Adapter,
      execute: async (exchange) => ({ kind: "continue", exchange }),
    };

    expect(
      continuationTailHash(
        [step("s", (v) => v), withHandle].slice(1),
        expected,
      ),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * @case An option change BEFORE the suspend point still does not invalidate
   * @preconditions Two pipelines differing only in an adapter option on a
   *   step that already ran
   * @expectedResult The hashes match, so widening the hash to cover options
   *   did not cost the compatibility property it was built for
   */
  test("an option change before the suspend point leaves it resumable", () => {
    const before = [
      configuredStep({ url: "https://notify-a.example" }),
      step("suspend", (v) => v),
      step("pay", (v) => v),
    ];
    const after = [
      configuredStep({ url: "https://notify-b.example" }),
      step("suspend", (v) => v),
      step("pay", (v) => v),
    ];

    expect(continuationTailHash(before.slice(2), expected)).toBe(
      continuationTailHash(after.slice(2), expected),
    );
  });
});

describe("continuationTailHash over factory-built adapters", () => {
  /**
   * @case Repointing a real factory-built destination invalidates a parked
   *   approval
   * @preconditions Two tails differing only in what `file()` was called
   *   with. A factory returns a role facade whose own properties are bound
   *   methods with identical source, so the options are reachable only
   *   through the recorded factory arguments.
   * @expectedResult The hashes differ, so an approval cannot resume into a
   *   write to a different path
   */
  test("a changed factory argument after the suspend point invalidates it", () => {
    const toA = [
      step("s", (v) => v),
      destination(file({ path: "/tmp/a.txt" })),
    ];
    const toB = [
      step("s", (v) => v),
      destination(file({ path: "/tmp/b.txt" })),
    ];

    expect(continuationTailHash(toA.slice(1), expected)).not.toBe(
      continuationTailHash(toB.slice(1), expected),
    );
  });

  /**
   * @case A dynamic option callback is part of what was approved
   * @preconditions Two tails whose factory argument is a path callback
   *   resolving to different files
   * @expectedResult The hashes differ. A callback nested in options would
   *   otherwise collapse to a placeholder and the target could change
   *   freely under a parked exchange.
   */
  test("a changed callback inside factory options invalidates it", () => {
    const toA = [
      step("s", (v) => v),
      destination(file({ path: () => "/tmp/a.txt" })),
    ];
    const toB = [
      step("s", (v) => v),
      destination(file({ path: () => "/tmp/b.txt" })),
    ];

    expect(continuationTailHash(toA.slice(1), expected)).not.toBe(
      continuationTailHash(toB.slice(1), expected),
    );
  });

  /**
   * @case A tail option under a `__proto__` key is still part of what was
   *   approved
   * @preconditions Two tails whose factory argument came from `JSON.parse`
   *   and differs only beneath a `__proto__` own key, which is what a config
   *   file or an upstream payload produces
   * @expectedResult The hashes differ. Projecting options onto an ordinary
   *   object literal drops that key through the Object.prototype setter, and
   *   the option could then change freely under a parked approval.
   */
  test("a changed option under a __proto__ key invalidates it", () => {
    const options = (role: string) =>
      JSON.parse(
        `{"path":"/tmp/a.txt","meta":{"__proto__":{"role":"${role}"}}}`,
      );

    expect(
      continuationTailHash(
        [step("s", (v) => v), destination(file(options("user")))].slice(1),
        expected,
      ),
    ).not.toBe(
      continuationTailHash(
        [step("s", (v) => v), destination(file(options("admin")))].slice(1),
        expected,
      ),
    );
  });

  /**
   * @case The same configuration still hashes stably
   * @preconditions Two separately constructed adapters with equal arguments
   * @expectedResult The hashes match, so a restart does not invalidate
   *   everything parked before it
   */
  test("identical factory arguments hash identically", () => {
    expect(
      continuationTailHash(
        [step("s", (v) => v), destination(file({ path: "/tmp/a.txt" }))].slice(
          1,
        ),
        expected,
      ),
    ).toBe(
      continuationTailHash(
        [step("s", (v) => v), destination(file({ path: "/tmp/a.txt" }))].slice(
          1,
        ),
        expected,
      ),
    );
  });
});

describe("describeSchema", () => {
  /**
   * @case The schema descriptor carries a rendering for the caller
   * @preconditions A schema exposing the ~standard.jsonSchema extension
   * @expectedResult The rendering is captured alongside the hash
   */
  test("captures a JSON Schema rendering when the schema exposes one", () => {
    const described = describeSchema(schema("approval"));
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

    const described = describeSchema(bare);

    expect(described.jsonSchema).toBeUndefined();
    expect(described.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * @case A schema library whose jsonSchema extension is a lazy producer
   * @preconditions Zod 4 exposes `~standard.jsonSchema.output` as a FUNCTION that renders on demand
   * @expectedResult The rendering is resolved, so two structurally different schemas hash differently and the descriptor is plain data the store can persist
   */
  test("resolves a lazy JSON Schema producer", () => {
    const lazy = (title: string): StandardSchemaV1 =>
      ({
        "~standard": {
          version: 1,
          vendor: "lazy",
          validate: (value: unknown) => ({ value }),
          jsonSchema: {
            output: () => ({ type: "object", title }),
          },
        },
      }) as unknown as StandardSchemaV1;

    const described = describeSchema(lazy("approval"));

    expect(described.jsonSchema).toEqual({ type: "object", title: "approval" });
    // The load-bearing property: an unresolved producer hashes to the same
    // digest for every schema (a function is not JSON), which would silently
    // disable the changed-expect half of the compatibility check.
    expect(described.hash).not.toBe(describeSchema(lazy("rejection")).hash);
    // And the descriptor is written to the store as-is, so it has to be
    // data. `structuredClone` is what the in-memory backend does.
    expect(() => structuredClone(described)).not.toThrow();
  });

  /**
   * @case A lazy producer that throws
   * @preconditions The extension's producer is vendor code that fails under every calling convention
   * @expectedResult The suspend is not failed by it: no rendering is claimed and a hash is still produced, but the descriptor is marked degraded so the park can say the changed-expect check is inert for this schema rather than leaving it silently so
   */
  test("marks a JSON Schema producer that throws as degraded", () => {
    const hostile = {
      "~standard": {
        version: 1,
        vendor: "hostile",
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          output: () => {
            throw new Error("no rendering for you");
          },
        },
      },
    } as unknown as StandardSchemaV1;

    const described = describeSchema(hostile);

    expect(described.jsonSchema).toBeUndefined();
    expect(described.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(described.degraded).toBe(true);
  });

  /**
   * @case A producer that requires the options argument the spec defines
   * @preconditions The extension's producer reads `options.target` and throws without it, which Standard JSON Schema permits
   * @expectedResult The rendering is obtained and two structurally different schemas hash differently. Calling with no argument would have thrown, collapsing both to the vendor fallback and disabling the changed-expect check for every schema from that library
   */
  test("calls producers with the target the spec requires", () => {
    const requiresOptions = (title: string): StandardSchemaV1 =>
      ({
        "~standard": {
          version: 1,
          vendor: "strict",
          validate: (value: unknown) => ({ value }),
          jsonSchema: {
            output: (options?: { target?: string }) => {
              if (!options?.target) throw new Error("target is required");
              return { type: "object", title, $schema: options.target };
            },
          },
        },
      }) as unknown as StandardSchemaV1;

    const first = describeSchema(requiresOptions("approval"));
    const second = describeSchema(requiresOptions("rejection"));

    expect(first.jsonSchema).toBeDefined();
    expect(first.degraded).toBeUndefined();
    expect(first.hash).not.toBe(second.hash);
  });

  /**
   * @case A producer predating the options argument
   * @preconditions The extension's producer throws when handed the spec's options and yields a schema when called with none
   * @expectedResult The rendering is still obtained, from the second attempt. Calling with options only would lose the rendering for such a library and collapse every one of its schemas to the vendor fallback, which is the same failure as calling with none only, in the other direction
   */
  test("falls back to calling a producer with no arguments", () => {
    const optionsUnaware = {
      "~standard": {
        version: 1,
        vendor: "legacy",
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          output: (options?: unknown) => {
            if (options !== undefined) throw new Error("no options expected");
            return { type: "object", title: "legacy" };
          },
        },
      },
    } as unknown as StandardSchemaV1;

    const described = describeSchema(optionsUnaware);

    expect(described.jsonSchema).toEqual({ type: "object", title: "legacy" });
    expect(described.degraded).toBeUndefined();
  });

  /**
   * @case An extension object that carries no arm at all
   * @preconditions `~standard.jsonSchema` is present but empty, so neither `output` nor `input` exists to call
   * @expectedResult Degraded. The library advertised the extension and delivered no rendering, which is the distinction the flag draws: keying on the arms instead would read this as a library that never offered one, and the hash is just as inert either way
   */
  test("an arm-less extension object is degraded", () => {
    const advertisedButEmpty = {
      "~standard": {
        version: 1,
        vendor: "empty",
        validate: (value: unknown) => ({ value }),
        jsonSchema: {},
      },
    } as unknown as StandardSchemaV1;

    const described = describeSchema(advertisedButEmpty);

    expect(described.jsonSchema).toBeUndefined();
    expect(described.degraded).toBe(true);
  });

  /**
   * @case A schema library with no JSON Schema extension at all
   * @preconditions `~standard` carries no `jsonSchema` arm
   * @expectedResult Not marked degraded. There was never a rendering to lose, so this is the benign fallback rather than a library failing to deliver what it advertised
   */
  test("a library without the extension is not degraded", () => {
    const plain = {
      "~standard": {
        version: 1,
        vendor: "plain",
        validate: (value: unknown) => ({ value }),
      },
    } as unknown as StandardSchemaV1;

    const described = describeSchema(plain);

    expect(described.jsonSchema).toBeUndefined();
    expect(described.degraded).toBeUndefined();
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
