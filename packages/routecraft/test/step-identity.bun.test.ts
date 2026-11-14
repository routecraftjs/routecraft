import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import { asDeferred, deferring, storeWith } from "./helpers/deferral.ts";
import {
  MemoryDeferralStore,
  craft,
  definePlugin,
  defineProject,
  direct,
  http,
  IDENTITY,
  keep,
  mask,
  noop,
  only,
  OperationType,
  otherwise,
  secret,
  step as typedStep,
  versioned,
  weighted,
  when,
  type Adapter,
  type Identity,
  type IdentifiedStep,
  type Step,
} from "../src/index.ts";
import {
  continuationDifference,
  continuationTailHash,
  describeSchema,
  isCurrentContinuationHash,
} from "../src/kernel/continuation/hash.ts";
import {
  describeSteps,
  encodeIdentityValue,
  encodeStepsCanonical,
  stepsDigest,
} from "../src/kernel/continuation/identity.ts";

type Chain = ReturnType<ReturnType<typeof craft>["from"]>;

/** The steps of a route built from one chain of builder calls. */
function stepsOf(build: (route: Chain) => unknown): Step<Adapter>[] {
  const route = craft().id("identity").from(direct()) as Chain;
  return (build(route) as { build(): { steps: Step<Adapter>[] }[] }).build()[0]!
    .steps;
}

function digestOf(build: (route: Chain) => unknown): string {
  return stepsDigest(stepsOf(build));
}

const encoded = (value: unknown): string => encodeIdentityValue(value).encoded;

describe("step identity: the edits the digest used to miss", () => {
  /**
   * @case A step inside a `.choice()` branch is edited
   * @preconditions Two routes whose `when` branch transforms differently
   * @expectedResult The digests differ: a parked approval is refused instead of resuming into the edited branch
   */
  test("a choice branch", () => {
    const a = digestOf((r) =>
      r.choice(
        when(
          () => true,
          (b) => b.transform(() => "a"),
        ),
        otherwise((b) => b.to(noop())),
      ),
    );
    const b = digestOf((r) =>
      r.choice(
        when(
          () => true,
          (b) => b.transform(() => "b"),
        ),
        otherwise((b) => b.to(noop())),
      ),
    );
    expect(a).not.toBe(b);
  });

  /**
   * @case The predicate selecting a `.choice()` branch is edited
   * @preconditions Two routes with identical branches and different predicates
   * @expectedResult The digests differ
   */
  test("a choice predicate", () => {
    const a = digestOf((r) =>
      r.choice(
        when(
          (ex) => ex.body === 1,
          (b) => b.to(noop()),
        ),
      ),
    );
    const b = digestOf((r) =>
      r.choice(
        when(
          (ex) => ex.body === 2,
          (b) => b.to(noop()),
        ),
      ),
    );
    expect(a).not.toBe(b);
  });

  /**
   * @case A `.multicast()` path is edited
   * @preconditions Two routes whose second path transforms differently
   * @expectedResult The digests differ
   */
  test("a multicast path", () => {
    const a = digestOf((r) =>
      r.multicast(
        (b) => b.to(noop()),
        (b) => b.transform(() => "a").to(noop()),
      ),
    );
    const b = digestOf((r) =>
      r.multicast(
        (b) => b.to(noop()),
        (b) => b.transform(() => "b").to(noop()),
      ),
    );
    expect(a).not.toBe(b);
  });

  /**
   * @case The strategy or a weight of a `.dispatch()` changes
   * @preconditions The same two targets under round-robin, failover, and two weightings
   * @expectedResult All four digests differ
   */
  test("a dispatch strategy and its weights", () => {
    const digests = [
      digestOf((r) => r.dispatch("round-robin", noop(), noop())),
      digestOf((r) => r.dispatch("failover", noop(), noop())),
      digestOf((r) =>
        r.dispatch("weighted", weighted(noop(), 1), weighted(noop(), 9)),
      ),
      digestOf((r) =>
        r.dispatch("weighted", weighted(noop(), 5), weighted(noop(), 5)),
      ),
    ];
    expect(new Set(digests).size).toBe(4);
  });

  /**
   * @case A wrapper is added, or its options change
   * @preconditions One step bare, under `.retry()` with two attempt counts, and under `.timeout()`
   * @expectedResult All four digests differ
   */
  test("a wrapper and its options", () => {
    const digests = [
      digestOf((r) => r.to(noop())),
      digestOf((r) => r.retry({ maxAttempts: 2 }).to(noop())),
      digestOf((r) => r.retry({ maxAttempts: 3 }).to(noop())),
      digestOf((r) => r.timeout("1s").to(noop())),
    ];
    expect(new Set(digests).size).toBe(4);
  });

  /**
   * @case A header's literal value changes
   * @preconditions `.header("tier", "gold")` against `.header("tier", "silver")`
   * @expectedResult The digests differ; the literal used to hide inside a closure
   */
  test("a header literal", () => {
    expect(digestOf((r) => r.header("tier", "gold"))).not.toBe(
      digestOf((r) => r.header("tier", "silver")),
    );
  });

  /**
   * @case A schema in the tail changes
   * @preconditions `.schema()` with one field type against another
   * @expectedResult The digests differ
   */
  test("a tail schema", () => {
    expect(
      digestOf((r) => r.schema(z.object({ amount: z.number() }))),
    ).not.toBe(digestOf((r) => r.schema(z.object({ amount: z.string() }))));
  });

  /**
   * @case The schema of a second `.defer()` in the tail changes
   * @preconditions Two tails holding a `.defer({ schema })` with different schemas
   * @expectedResult The digests differ
   */
  test("the schema of a later defer", () => {
    const route = (schema: z.ZodType) =>
      digestOf((r) => r.defer({ schema }).to(noop()));
    expect(route(z.object({ ok: z.boolean() }))).not.toBe(
      route(z.object({ ok: z.string() })),
    );
  });

  /**
   * @case The key of a `.dedupe()` changes
   * @preconditions Two routes deduplicating on different keys
   * @expectedResult The digests differ
   */
  test("a dedupe key", () => {
    expect(
      digestOf((r) => r.dedupe({ key: (ex) => String(ex.body) })),
    ).not.toBe(digestOf((r) => r.dedupe({ key: (ex) => ex.id })));
  });
});

describe("step identity: the canonical encoding", () => {
  /**
   * @case Scalars that look alike
   * @preconditions A number, the string spelling it, a bigint of the same value, `null`, `undefined`, `true`
   * @expectedResult Six different encodings, each under its own tag
   */
  test("gives every scalar its own tag", () => {
    const values = [1, "1", 1n, null, undefined, true];
    expect(new Set(values.map(encoded)).size).toBe(values.length);
    expect(encoded("x")).toBe('["s","x"]');
    expect(encoded(null)).toBe('["null"]');
    expect(encoded(undefined)).toBe('["undef"]');
    expect(encoded(7n)).toBe('["big","7"]');
  });

  /**
   * @case Numbers JSON cannot spell
   * @preconditions `-0`, `NaN`, `Infinity`, `-Infinity`
   * @expectedResult `-0` encodes as `0`; the other three as named strings, all different
   */
  test("normalises -0 and names the non-finite numbers", () => {
    expect(encoded(-0)).toBe(encoded(0));
    expect(encoded(NaN)).toBe('["n","NaN"]');
    expect(encoded(Infinity)).toBe('["n","Infinity"]');
    expect(encoded(-Infinity)).toBe('["n","-Infinity"]');
  });

  /**
   * @case The carriers an option names a target with
   * @preconditions A `Date`, a `URL`, a `RegExp` with flags
   * @expectedResult ISO date, href, and source with flags, so two different targets never encode alike
   */
  test("encodes Date, URL and RegExp by value", () => {
    expect(encoded(new Date(0))).toBe('["date","1970-01-01T00:00:00.000Z"]');
    expect(encoded(new URL("https://a.example/x"))).toBe(
      '["url","https://a.example/x"]',
    );
    expect(encoded(/ab+/gi)).toBe('["re","ab+","gi"]');
  });

  /**
   * @case A user function
   * @preconditions Two arrows with different bodies, and a third with the body of the first
   * @expectedResult The encoding is the text the runtime reports for the function, unnormalised: different bodies differ and equal bodies match
   */
  test("takes a function's source as the runtime reports it", () => {
    const a = (x: number) => x + 1;
    const b = (x: number) => x + 2;
    const c = (x: number) => x + 1;
    expect(encoded(a)).not.toBe(encoded(b));
    expect(encoded(a)).toBe(encoded(c));
    expect(encoded(a)).toBe(JSON.stringify(["fn", a.toString()]));
  });

  /**
   * @case A native or bound function
   * @preconditions `Math.max` and a bound arrow
   * @expectedResult Both encode as `[native]` and the value is reported as inferred
   */
  test("marks a native or bound function as inferred", () => {
    for (const fn of [Math.max, ((x: number) => x).bind(null)]) {
      const result = encodeIdentityValue(fn);
      expect(result.encoded).toBe('["fn","[native]"]');
      expect(result.inferred).toHaveLength(1);
    }
  });

  /**
   * @case A function that states its identity
   * @preconditions `only()` called with two different getters and with the same getter twice
   * @expectedResult The helper's own source never reaches the encoding; the getter's does, so different getters differ and equal ones match
   */
  test("reads a helper's identity and never its source", () => {
    const a = encoded(only((r: { a: number }) => r.a, "x"));
    const b = encoded(only((r: { b: number }) => r.b, "x"));
    expect(a).not.toBe(b);
    expect(a).toBe(encoded(only((r: { a: number }) => r.a, "x")));
    expect(a).toContain("routecraft.only");
    expect(a).not.toContain("enrichmentData");
  });

  /**
   * @case A Standard Schema
   * @preconditions Two zod schemas, and a schema whose library offers no JSON Schema rendering
   * @expectedResult A rendered schema encodes by its JSON Schema; one without a rendering encodes as degraded and is inferred
   */
  test("encodes a schema by its rendering, or as degraded", () => {
    expect(encoded(z.object({ a: z.string() }))).not.toBe(
      encoded(z.object({ a: z.number() })),
    );
    const bare = {
      "~standard": {
        version: 1,
        vendor: "acme",
        validate: (value: unknown) => ({ value }),
      },
    };
    const result = encodeIdentityValue(bare);
    expect(result.encoded).toBe('["schema","acme","degraded"]');
    expect(result.inferred).toHaveLength(1);
  });

  /**
   * @case The two markers
   * @preconditions `secret()` of two values, `versioned()` of one value under two ids
   * @expectedResult Every secret encodes alike, so rotation moves nothing; a versioned value encodes as its id alone
   */
  test("secret is constant and versioned is its id", () => {
    expect(encoded(secret("old-token"))).toBe(encoded(secret("new-token")));
    expect(encoded(secret("x"))).toBe('["secret"]');
    const client = new Map();
    expect(encoded(versioned(client, "v1"))).toBe('["versioned","v1"]');
    expect(encoded(versioned(client, "v1"))).not.toBe(
      encoded(versioned(client, "v2")),
    );
  });

  /**
   * @case A class instance that states nothing
   * @preconditions An instance of a local class
   * @expectedResult Encodes as opaque with its constructor name and is inferred
   */
  test("marks another class instance as opaque", () => {
    class Client {}
    const result = encodeIdentityValue({ client: new Client() });
    expect(result.encoded).toContain('["opaque","Client"]');
    expect(result.inferred).toEqual([
      { path: "value.client", reason: "a class instance" },
    ]);
  });

  /**
   * @case A plain object
   * @preconditions Two objects with the same entries in a different order; one with a symbol key; one with an accessor
   * @expectedResult Key order does not matter; a symbol key and an accessor are inferred, and the accessor is not invoked
   */
  test("sorts keys and never invokes an accessor", () => {
    expect(encoded({ a: 1, b: 2 })).toBe(encoded({ b: 2, a: 1 }));
    expect(
      encodeIdentityValue({ [Symbol("hidden")]: 1 }).inferred,
    ).toHaveLength(1);
    let read = false;
    const withAccessor = {
      get live() {
        read = true;
        return 1;
      },
    };
    expect(encodeIdentityValue(withAccessor).inferred).toHaveLength(1);
    expect(read).toBe(false);
  });

  /**
   * @case Collections
   * @preconditions Two arrays, two Maps and two Sets holding the same members in a different order; an array against a Set of the same members
   * @expectedResult Order is kept, so each reordered pair differs, and an array never equals a Set
   */
  test("keeps the order of arrays, Maps and Sets", () => {
    expect(encoded([1, 2])).not.toBe(encoded([2, 1]));
    expect(
      encoded(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
      ),
    ).not.toBe(
      encoded(
        new Map([
          ["b", 2],
          ["a", 1],
        ]),
      ),
    );
    expect(encoded(new Set([1, 2]))).not.toBe(encoded(new Set([2, 1])));
    expect(encoded([1, 2])).not.toBe(encoded(new Set([1, 2])));
  });

  /**
   * @case A value that contains itself, and one nested too deep
   * @preconditions A self-referential object; an object nested eight deep
   * @expectedResult Neither throws nor loops: the cycle and the depth are placeholders, each inferred
   */
  test("bounds a cycle and a deep value", () => {
    const loop: Record<string, unknown> = {};
    loop["self"] = loop;
    const cyclic = encodeIdentityValue(loop);
    expect(cyclic.encoded).toContain('["cycle"]');
    expect(cyclic.inferred).toHaveLength(1);

    let deep: unknown = "leaf";
    for (let i = 0; i < 8; i++) deep = { next: deep };
    const nested = encodeIdentityValue(deep);
    expect(nested.encoded).toContain('["deep"]');
    expect(nested.inferred).toHaveLength(1);
  });
});

describe("step identity: steps and adapters", () => {
  /**
   * @case A plugin step with no identity of its own
   * @preconditions A catalogue step called with two different arguments, and twice with the same one
   * @expectedResult The recorded arguments are the identity: different arguments differ, equal ones match, and the kind is the plugin id and the step name
   */
  test("a catalogue step is identified by its recorded arguments", () => {
    const pricing = definePlugin({
      id: "acme.pricing",
      steps: {
        withTax: (rate: number) =>
          typedStep<{ total: number }, number>((ex) => ex.body.total * rate),
      },
    });
    const route = (rate: number) =>
      defineProject({ plugins: [pricing] })
        .craft()
        .id("pricing")
        .from(direct<{ total: number }>())
        .withTax(rate)
        .build()[0]!.steps;

    expect(stepsDigest(route(0.1))).not.toBe(stepsDigest(route(0.2)));
    expect(stepsDigest(route(0.1))).toBe(stepsDigest(route(0.1)));
    expect(describeSteps(route(0.1)).kinds).toEqual(["acme.pricing.withTax"]);
  });

  /**
   * @case The `identity` option of `step()`
   * @preconditions The same callback and arguments under `version: 1` and `version: 2`
   * @expectedResult The digests differ: an author states a behaviour change nothing else shows
   */
  test("a version bump moves the digest", () => {
    const route = (version: number) => {
      const plugin = definePlugin({
        id: "acme.approval",
        steps: {
          approve: () =>
            typedStep<unknown, unknown>((ex) => ex.body, {
              identity: { version },
            }),
        },
      });
      return defineProject({ plugins: [plugin] })
        .craft()
        .id("approval")
        .from(direct())
        .approve()
        .build()[0]!.steps;
    };
    expect(stepsDigest(route(1))).not.toBe(stepsDigest(route(2)));
  });

  /**
   * @case A catalogue step whose argument is a class instance
   * @preconditions A step factory called with an instance of a local class
   * @expectedResult The walk reports the argument as inferred, naming where it sits
   */
  test("an opaque argument is reported", () => {
    class Ledger {}
    const plugin = definePlugin({
      id: "acme.books",
      steps: {
        post: (ledger: Ledger) =>
          typedStep<unknown, unknown>((ex) => [ex.body, ledger]),
      },
    });
    const steps = defineProject({ plugins: [plugin] })
      .craft()
      .id("books")
      .from(direct())
      .post(new Ledger())
      .build()[0]!.steps;
    expect(describeSteps(steps).inferred).toEqual([
      { path: "steps[0].options.args[0]", reason: "a class instance" },
    ]);
  });

  /**
   * @case A step that states its own identity
   * @preconditions A raw step implementing `[IDENTITY]` with a secret option, built twice with different tokens and once with a different quorum
   * @expectedResult Rotating the secret keeps the digest; changing the quorum moves it
   */
  test("a stated identity replaces the default", () => {
    const approval = (token: string, quorum: number): IdentifiedStep => ({
      operation: OperationType.PROCESS,
      adapter: {},
      execute: async (exchange) => ({ kind: "continue", exchange }),
      [IDENTITY]: (): Identity => ({
        kind: "acme.approval",
        options: { token: secret(token), quorum },
      }),
    });
    expect(stepsDigest([approval("old", 2)])).toBe(
      stepsDigest([approval("new", 2)]),
    );
    expect(stepsDigest([approval("old", 2)])).not.toBe(
      stepsDigest([approval("old", 3)]),
    );
  });

  /**
   * @case A third-party class adapter that states nothing
   * @preconditions A class instance with an `adapterId`, an options property and a bound-free `send` arrow, with two different urls
   * @expectedResult Its own properties are its identity: a changed option moves the digest and nothing is inferred
   */
  test("a class adapter is identified by its own properties", () => {
    class Payout {
      readonly adapterId = "acme.payout";
      constructor(readonly options: { url: string }) {}
      send = async (): Promise<void> => {};
    }
    const route = (url: string) => stepsOf((r) => r.to(new Payout({ url })));
    expect(stepsDigest(route("https://a.example"))).not.toBe(
      stepsDigest(route("https://b.example")),
    );
    expect(describeSteps(route("https://a.example")).inferred).toEqual([]);
  });

  /**
   * @case A log line is added to a tail
   * @preconditions The same route with and without `.log()` and `.debug()`
   * @expectedResult The digests match: a log line re-asks no parked approval
   */
  test("log steps are left out", () => {
    expect(digestOf((r) => r.log().debug().to(noop()))).toBe(
      digestOf((r) => r.to(noop())),
    );
  });

  /**
   * @case Every builder method, wrapper and helper core ships
   * @preconditions One corpus of routes calling each, where every function the test passes reads `mine.USER`
   * @expectedResult Nothing is inferred, no step falls back to the unidentified kind, and every function source in the encoding is one of the test's own: no core source text reaches the digest
   */
  test("core states every identity itself", () => {
    const mine = { USER: 1 };
    const corpus = [
      stepsOf((r) =>
        r
          .transform((body) => [body, mine.USER])
          .process((ex) => (mine.USER ? ex : ex))
          .filter(() => mine.USER > 0)
          .header("literal", "value")
          .header("computed", () => String(mine.USER))
          .correlate(() => ({ correlationId: String(mine.USER) }))
          .map({ a: () => mine.USER })
          .schema(z.object({ a: z.number() }))
          .validate(z.object({ a: z.number() }))
          .tap(() => void mine.USER)
          .log()
          .debug()
          .sample({ every: 2 })
          .dedupe({ key: () => String(mine.USER) })
          .enrich(
            http({ url: "https://a.example" }),
            only(() => mine.USER, "x"),
          )
          .enrich(() => mine.USER)
          .retry({ maxAttempts: 2 })
          .timeout("1s")
          .throttle({ rate: 1, per: "1s" })
          .circuitBreaker({ failureThreshold: 2, cooldown: "1s" })
          .concurrency({ max: 2 })
          .delay("1s")
          .cache({})
          .error(() => mine.USER)
          .to(http({ url: "https://b.example", method: "POST" }))
          .transform(keep({ a: true }))
          .transform(mask({ a: () => mine.USER }))
          .choice(
            when(
              () => mine.USER > 0,
              (b) => b.to(noop()),
            ),
            otherwise((b) => b.to(noop()).halt()),
          )
          .multicast(
            (b) => b.to(noop()),
            (b) => b.to(noop()),
          )
          .dispatch("round-robin", noop(), (b) => b.to(noop()))
          .to(noop()),
      ),
      stepsOf((r) =>
        r
          .split()
          .aggregate()
          .debounce({ wait: "1s" })
          .authenticate(() => ({ subject: String(mine.USER) }))
          .defer({ schema: z.object({ ok: z.boolean() }), ttl: "1h" })
          .to(noop()),
      ),
    ];
    for (const steps of corpus) {
      const described = describeSteps(steps);
      expect(described.inferred).toEqual([]);
      expect(
        described.kinds.filter((kind) => kind.startsWith("step.")),
      ).toEqual([]);
      const sources = [
        ...encodeStepsCanonical(steps).matchAll(/\["fn","((?:[^"\\]|\\.)*)"/g),
      ].map((match) => match[1]!);
      expect(sources.length).toBeGreaterThan(0);
      expect(sources.filter((source) => !source.includes("USER"))).toEqual([]);
    }
  });
});

describe("step identity: the stored continuation hash", () => {
  const schema = describeSchema();

  /**
   * @case The format of a stored hash
   * @preconditions A hash computed now, and a bare hex digest as releases before 0.8 stored it
   * @expectedResult The current one carries the `d2:` prefix and one short digest per tail step; the old one is not current
   */
  test("carries its format and a digest per step", () => {
    const tail = stepsOf((r) => r.transform((x) => x).to(noop()));
    const hash = continuationTailHash(tail, schema);
    expect(hash).toMatch(/^d2:[0-9a-f]{64}\/[0-9a-f]{8}\.[0-9a-f]{8}$/);
    expect(isCurrentContinuationHash(hash)).toBe(true);
    expect(isCurrentContinuationHash("a".repeat(64))).toBe(false);
  });

  /**
   * @case A refused resume says what moved
   * @preconditions A hash stored for one tail, compared with a tail whose second step changed, with one whose schema changed, and with one that lost a step
   * @expectedResult The difference names the step and its kind, the schema, or the removed step
   */
  test("names the first step that differs", () => {
    const before = stepsOf((r) => r.transform((x) => x).header("a", "1"));
    const stored = continuationTailHash(before, schema);

    const edited = stepsOf((r) => r.transform((x) => x).header("a", "2"));
    expect(continuationDifference(stored, edited, schema)).toBe(
      "step 2 of what would run (routecraft.header) differs",
    );
    expect(
      continuationDifference(
        stored,
        before,
        describeSchema(z.object({ ok: z.boolean() })),
      ),
    ).toBe("the schema the resume payload is validated against differs");
    expect(
      continuationDifference(
        stored,
        stepsOf((r) => r.transform((x) => x)),
        schema,
      ),
    ).toBe("1 step(s) were removed from the end");
  });

  /**
   * @case The cache and the continuation read one walk
   * @preconditions Two pipelines that differ in one wrapper option
   * @expectedResult Both the pipeline digest and the continuation hash differ: neither can see a change the other misses
   */
  test("the cache digest and the continuation hash agree", () => {
    const a = stepsOf((r) => r.retry({ maxAttempts: 2 }).to(noop()));
    const b = stepsOf((r) => r.retry({ maxAttempts: 3 }).to(noop()));
    expect(stepsDigest(a)).not.toBe(stepsDigest(b));
    expect(continuationTailHash(a, schema)).not.toBe(
      continuationTailHash(b, schema),
    );
  });

  /**
   * @case An edit before, at and after the defer point
   * @preconditions Three variants of one route, each changing one step; the tail is everything after the defer
   * @expectedResult Editing a step before the defer keeps the hash; editing one after it moves the hash; rebuilding the same route keeps it
   */
  test("moves for the tail only", () => {
    const route = (head: string, tail: string) => {
      const steps = stepsOf((r) =>
        r.header("head", head).defer().header("tail", tail),
      );
      const at = steps.findIndex(
        (step) => step.operation === OperationType.DEFER,
      );
      return continuationTailHash(steps.slice(at + 1), schema);
    };
    expect(route("a", "x")).toBe(route("a", "x"));
    expect(route("a", "x")).toBe(route("b", "x"));
    expect(route("a", "x")).not.toBe(route("a", "y"));
  });
});

describe("step identity: a running route", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  /** The `RC5071` warnings the routes of `t` logged at start. */
  const warnings = (context: TestContext) =>
    context.logger.warn.mock.calls
      .map((call) => call[0] as { rc?: string; inferred?: unknown })
      .filter((bindings) => bindings?.rc === "RC5071");

  /**
   * @case A deferring route whose tail holds a value the digest cannot see
   * @preconditions A raw step after `.defer()` whose stated identity carries a class instance; a second route that defers with a fully identified tail
   * @expectedResult One RC5071 warning at start, naming the first route and where the value sits; none for the second
   */
  test("warns once at start, naming the value", async () => {
    class Ledger {}
    const opaque: IdentifiedStep = {
      operation: OperationType.PROCESS,
      adapter: {},
      execute: async (exchange) => ({ kind: "continue", exchange }),
      [IDENTITY]: (): Identity => ({
        kind: "acme.post",
        options: { ledger: new Ledger() },
      }),
    };
    const blind = craft().id("blind").from(direct()).defer();
    blind.build()[0]!.steps.push(opaque);

    t = await testContext()
      .with(deferring())
      .routes([
        blind,
        craft().id("clear").from(direct()).defer().header("a", "1").to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    expect(warnings(t)).toHaveLength(1);
    expect(warnings(t)[0]).toMatchObject({
      route: "blind",
      inferred: [
        {
          path: "after position 0: steps[0].options.ledger",
          reason: "a class instance",
        },
      ],
    });
  });

  /**
   * @case A deferral parked by a release that digested steps differently
   * @preconditions A parked deferral whose stored `continuationHash` is a bare hex digest, as releases before the `d2:` format wrote it
   * @expectedResult The resume is refused with RC5048 saying the digest format changed, and nothing after the defer runs
   */
  test("refuses a record in the old digest format", async () => {
    const backing = new MemoryDeferralStore();
    const store = storeWith(backing, {
      get: async (id) => {
        const record = await backing.get(id);
        return record
          ? { ...record, continuationHash: "a".repeat(64) }
          : record;
      },
    });
    const ran: unknown[] = [];
    t = await testContext()
      .with({ deferral: { store } })
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer()
          .tap((ex) => void ran.push(ex.body))
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();
    const deferred = asDeferred(await t.client.sendDirect("payout", {}));

    await expect(
      t.client.sendDirect("answers", { token: deferred.token, result: {} }),
    ).rejects.toMatchObject({
      rc: "RC5048",
      message: expect.stringContaining("digested steps differently"),
    });
    expect(ran).toHaveLength(0);
  });

  /**
   * @case A redeploy edits a step after the defer point
   * @preconditions A deferral parked by one context; a second context on the same store whose header step after the defer carries a different literal
   * @expectedResult RC5048, and the message names the step that moved and its kind
   */
  test("the refusal names the step that moved", async () => {
    const shared = {
      deferral: {
        store: new MemoryDeferralStore(),
        secret: "step-identity-test-secret-key-0123456789",
      },
    };
    const payout = (tier: string) =>
      craft()
        .id("payout")
        .from(direct())
        .defer()
        .transform((body) => body)
        .header("tier", tier)
        .to(noop());

    const before = await testContext()
      .with(shared)
      .routes([payout("gold")])
      .build();
    await before.startAndWaitReady();
    const deferred = asDeferred(await before.client.sendDirect("payout", {}));
    await before.stop();

    t = await testContext()
      .with(shared)
      .routes([payout("silver"), craft().id("answers").from(direct()).resume()])
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("answers", { token: deferred.token, result: {} }),
    ).rejects.toMatchObject({
      rc: "RC5048",
      message: expect.stringContaining(
        "step 2 of what would run (routecraft.header) differs",
      ),
    });
  });
});
