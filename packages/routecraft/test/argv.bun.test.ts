import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  argv,
  argvRouteIds,
  describeArgvRoute,
  authorityOf,
  craft,
  definePlugin,
  direct,
  HeadersKeys,
  noop,
  RUNNER_INVOCATION,
  type CraftConfig,
  type RunnerInvocation,
  type RunnerOutcome,
} from "../src/index.ts";
import {
  bodyFromArgs,
  commandLineInput,
} from "../src/adapters/argv/command-line.ts";
import { deferring } from "./helpers/deferral.ts";

/** A plugin whose beforeAuth mutate hook supplies a local principal holding `scopes`. */
function operatorPlugin(scopes: string[]) {
  return definePlugin({
    id: "test.operator",
    hooks: {
      beforeAuth: {
        id: "operator",
        phase: "mutate",
        run: (exchange) => ({
          headers: {
            [HeadersKeys.AUTH_PRINCIPAL]: authorityOf(exchange).mint({
              kind: "custom",
              scheme: "local",
              subject: "jaco",
              scopes,
            }),
          },
        }),
      },
    },
  });
}

/** A runner hand-off that records the outcome and whether stdin was read. */
function invocation(
  args: string[],
  options: { stdin?: string; routeId?: string } = {},
): {
  invocation: RunnerInvocation;
  outcomes: RunnerOutcome[];
  readStdin: ReturnType<typeof mock>;
} {
  const outcomes: RunnerOutcome[] = [];
  const readStdin = mock(() => Promise.resolve(options.stdin));
  return {
    outcomes,
    readStdin,
    invocation: {
      routeId: options.routeId ?? "work-item",
      argv: args,
      readStdin,
      settle: (outcome) => void outcomes.push(outcome),
    },
  };
}

const WorkItemQuery = z.object({
  id: z.string().describe("The work item id"),
  expand: z.string().optional().describe("Relations to include"),
});

describe("command-line input grammar", () => {
  /**
   * @case Trailing flags become a flat request body
   * @preconditions A mix of --key=value, --key value, a bare flag and a repeated key
   * @expectedResult Strings stay strings, a bare flag is true, and a repeat becomes an array. Nothing is coerced to a number, because a CLI guessing types produces bugs that only appear for values that happen to look numeric
   */
  test("builds a body from trailing flags", () => {
    const { body, error } = bodyFromArgs([
      "--name=world",
      "--count",
      "3",
      "--loud",
      "--tag=a",
      "--tag=b",
    ]);
    expect(error).toBeUndefined();
    expect(body).toEqual({
      name: "world",
      count: "3",
      loud: true,
      tag: ["a", "b"],
    });
  });

  /**
   * @case Field names that exist on Object.prototype are plain fields
   * @preconditions --__proto__ and --constructor given as flags
   * @expectedResult Both are own fields of a body whose prototype is untouched
   */
  test("treats prototype names as fields", () => {
    const { body, error } = bodyFromArgs(["--__proto__=x", "--constructor=y"]);
    expect(error).toBeUndefined();
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
    expect(Object.hasOwn(body, "__proto__")).toBe(true);
    expect(body["__proto__"]).toBe("x");
    expect(body["constructor"]).toBe("y");
  });

  /**
   * @case A positional argument where a field was expected is refused
   * @preconditions A trailing argument that is not a --flag
   * @expectedResult An error naming both ways to pass input, rather than a body that silently dropped it
   */
  test("refuses a stray positional argument", () => {
    const { error } = bodyFromArgs(["world"]);
    expect(error).toMatch(/--field=value/);
  });

  /**
   * @case JSON on stdin is the body when no flags are given
   * @preconditions No arguments, a JSON object on stdin
   * @expectedResult The parsed JSON, with its numbers intact
   */
  test("reads JSON from stdin", () => {
    expect(commandLineInput([], '{"id":12345}')).toEqual({
      body: { id: 12345 },
    });
  });

  /**
   * @case Flags and stdin together are refused
   * @preconditions A flag and a non-blank stdin
   * @expectedResult A usage error rather than a merge, so which one wins is never a question
   */
  test("refuses flags and stdin together", () => {
    const input = commandLineInput(["--id=1"], '{"id":2}');
    expect("error" in input && input.error).toMatch(/both on stdin/);
  });

  /**
   * @case Blank stdin counts as no stdin
   * @preconditions Flags, and a stdin holding only whitespace
   * @expectedResult The flags make the body
   */
  test("treats blank stdin as none", () => {
    expect(commandLineInput(["--id=1"], "  \n")).toEqual({
      body: { id: "1" },
    });
  });

  /**
   * @case Stdin that is not JSON is a usage error
   * @preconditions No flags, stdin holding plain text
   * @expectedResult An error saying stdin must be JSON
   */
  test("refuses stdin that is not JSON", () => {
    const input = commandLineInput([], "not json");
    expect("error" in input && input.error).toMatch(/must be JSON/);
  });
});

describe("argv() source", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Flags reach the route as the body and the result is reported
   * @preconditions An argv() route with an .input() schema and a transform; --id given as a flag
   * @expectedResult One completed outcome carrying the transformed body, and stdin never read
   */
  test("runs one exchange from the flags", async () => {
    const run = invocation(["--id=12345"]);
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .routes(
        craft()
          .id("work-item")
          .input({ body: WorkItemQuery })
          .from(argv())
          .transform((body) => ({ found: body.id })),
      )
      .build();
    await t.test();
    expect(run.outcomes).toEqual([
      { outcome: "completed", body: { found: "12345" } },
    ]);
    expect(run.readStdin).not.toHaveBeenCalled();
  });

  /**
   * @case JSON on stdin is the body when there are no flags
   * @preconditions No arguments; the runner's stdin holds a JSON object
   * @expectedResult The route sees the parsed object
   */
  test("reads the body from stdin when no flags are given", async () => {
    const run = invocation([], { stdin: '{"id":"7"}', routeId: "echo" });
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .routes(craft().id("echo").from(argv()).to(noop()))
      .build();
    await t.test();
    expect(run.readStdin).toHaveBeenCalledTimes(1);
    expect(run.outcomes).toEqual([{ outcome: "completed", body: { id: "7" } }]);
  });

  /**
   * @case A malformed command line never reaches the route
   * @preconditions A positional argument where a --field was expected
   * @expectedResult A usage outcome from the shared parser, and the route never ran
   */
  test("reports a malformed command line as a usage error", async () => {
    const run = invocation(["12345"], { routeId: "echo" });
    const step = mock();
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .routes(craft().id("echo").from(argv()).to(step))
      .build();
    await t.test();
    expect(run.outcomes[0]?.outcome).toBe("usage");
    expect(step).not.toHaveBeenCalled();
  });

  /**
   * @case An .input() failure is a refusal of what was sent
   * @preconditions The required id field is missing
   * @expectedResult A refused outcome of kind input, naming the failing path
   */
  test("reports an .input() failure as an input refusal", async () => {
    const run = invocation(["--expand=links"]);
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .routes(
        craft()
          .id("work-item")
          .input({ body: WorkItemQuery })
          .from(argv())
          .to(noop()),
      )
      .build();
    await t.test();
    const outcome = run.outcomes[0];
    expect(outcome?.outcome).toBe("refused");
    if (outcome?.outcome !== "refused") return;
    expect(outcome.refusal.kind).toBe("input");
    if (outcome.refusal.kind !== "input") return;
    expect(outcome.refusal.issues.map((issue) => issue.path)).toContain("id");
  });

  /**
   * @case The exchange carries no principal
   * @preconditions An argv() route that records the principal header
   * @expectedResult A completed outcome and no principal: a command line proves no identity
   */
  test("carries no principal", async () => {
    const run = invocation(["--id=1"]);
    let principal: unknown = "unset";
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .routes(
        craft()
          .id("work-item")
          .from(argv())
          .process((exchange) => {
            principal = exchange.headers["routecraft.auth.principal"];
            return exchange;
          }),
      )
      .build();
    await t.test();
    expect(run.outcomes[0]?.outcome).toBe("completed");
    expect(principal).toBeUndefined();
  });

  /**
   * @case A route that authorizes fails when nothing supplies a principal
   * @preconditions argv() in front of .authorize(), no plugin supplying an identity
   * @expectedResult A failed outcome and the step never ran
   */
  test("fails an authorizing route", async () => {
    const run = invocation(["--id=1"]);
    const step = mock();
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .routes(
        craft()
          .id("work-item")
          .authorize({ scopes: ["boards:read"] })
          .from(argv())
          .to(step),
      )
      .build();
    await t.test();
    expect(run.outcomes[0]?.outcome).toBe("failed");
    expect(step).not.toHaveBeenCalled();
  });

  /**
   * @case A plugin's beforeAuth hook can supply the principal
   * @preconditions A plugin whose beforeAuth mutate hook mints a principal holding boards:read; an argv() route requiring that scope
   * @expectedResult A completed outcome, and the route sees the plugin's principal
   */
  test("runs an authorizing route as a plugin-supplied principal", async () => {
    const run = invocation(["--id=1"]);
    let principal: unknown;
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .with({
        plugins: [operatorPlugin(["boards:read"])],
      })
      .routes(
        craft()
          .id("work-item")
          .authorize({ scopes: ["boards:read"] })
          .from(argv())
          .process((exchange) => {
            principal = exchange.headers["routecraft.auth.principal"];
            return exchange;
          }),
      )
      .build();
    await t.test();
    expect(run.outcomes[0]?.outcome).toBe("completed");
    expect(principal).toMatchObject({ subject: "jaco" });
  });

  /**
   * @case A plugin-supplied principal that .authorize() refuses is a route failure
   * @preconditions A beforeAuth mutate hook mints a principal without boards:read; an argv() route requiring it
   * @expectedResult A failed outcome naming the missing scope, not a caller refusal, since the door admitted no principal
   */
  test("fails when the plugin-supplied principal lacks a scope", async () => {
    const run = invocation(["--id=1"]);
    const step = mock();
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .with({
        plugins: [operatorPlugin([])],
      })
      .routes(
        craft()
          .id("work-item")
          .authorize({ scopes: ["boards:read"] })
          .from(argv())
          .to(step),
      )
      .build();
    await t.test();
    const outcome = run.outcomes[0];
    expect(outcome?.outcome).toBe("failed");
    if (outcome?.outcome !== "failed") throw new Error("expected a failure");
    expect(outcome.message).toContain("missing required scope(s): boards:read");
    expect(step).not.toHaveBeenCalled();
  });

  /**
   * @case A filter that declines the exchange is a drop, not a result
   * @preconditions A route whose filter rejects every exchange
   * @expectedResult A dropped outcome, never the request echoed back as the answer
   */
  test("reports a filtered exchange as dropped", async () => {
    const run = invocation(["--id=1"], { routeId: "picky" });
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .routes(
        craft()
          .id("picky")
          .from(argv())
          .filter(() => false)
          .to(noop()),
      )
      .build();
    await t.test();
    expect(run.outcomes[0]?.outcome).toBe("dropped");
  });

  /**
   * @case A failing step is a failure carrying its message
   * @preconditions A route whose process step throws
   * @expectedResult A failed outcome with the thrown message
   */
  test("reports a failing route as failed", async () => {
    const run = invocation(["--id=1"], { routeId: "broken" });
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .routes(
        craft()
          .id("broken")
          .from(argv())
          .process(() => {
            throw new Error("upstream said no");
          }),
      )
      .build();
    await t.test();
    expect(run.outcomes).toEqual([
      { outcome: "failed", message: "upstream said no" },
    ]);
  });

  /**
   * @case A deferral is an outcome carrying the acknowledgement
   * @preconditions Deferral configured; the route defers for an approval
   * @expectedResult A deferred outcome whose deferral has an id and a token
   */
  test("reports a deferral with its acknowledgement", async () => {
    const run = invocation(["--amount=10"], { routeId: "payout" });
    t = await testContext()
      .with({ ...deferring() } as CraftConfig)
      .store(RUNNER_INVOCATION, run.invocation)
      .routes([
        craft()
          .id("payout")
          .from(argv())
          .defer({ input: z.object({ approved: z.boolean() }), ttl: "1h" })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.test();
    const outcome = run.outcomes[0];
    expect(outcome?.outcome).toBe("deferred");
    if (outcome?.outcome !== "deferred") return;
    expect(typeof outcome.deferral.deferralId).toBe("string");
    expect(typeof outcome.deferral.token).toBe("string");
  });

  /**
   * @case A route is described for --help without starting the context
   * @preconditions A titled route with an .input() schema, built but never started
   * @expectedResult The id, title and the rendered input schema with its field descriptions, and the route never ran
   */
  test("describes a route without starting it", async () => {
    const step = mock();
    t = await testContext()
      .routes(
        craft()
          .id("work-item")
          .title("Fetch a work item")
          .input({ body: WorkItemQuery })
          .from(argv())
          .to(step),
      )
      .build();
    expect(describeArgvRoute(t.ctx, "work-item")).toMatchObject({
      id: "work-item",
      title: "Fetch a work item",
      input: {
        properties: { id: { description: "The work item id" } },
        required: ["id"],
      },
    });
    expect(describeArgvRoute(t.ctx, "missing")).toBeUndefined();
    expect(step).not.toHaveBeenCalled();
  });

  /**
   * @case Every route that reads argv() is found before start
   * @preconditions Two argv() routes and one direct() route, built but never started
   * @expectedResult Both argv() route ids in registration order, and not the direct() one
   */
  test("lists the argv() routes", async () => {
    t = await testContext()
      .routes([
        craft().id("first").from(argv()).to(noop()),
        craft().id("plain").from(direct()).to(noop()),
        craft().id("second").from(argv()).to(noop()),
      ])
      .build();
    expect(argvRouteIds(t.ctx)).toEqual(["first", "second"]);
  });

  /**
   * @case Only the route the invocation names reads the command line
   * @preconditions Two argv() routes, and an invocation for the second
   * @expectedResult One completed outcome, the second route's step ran and the first's did not
   */
  test("runs only the route the invocation names", async () => {
    const run = invocation(["--id=1"], { routeId: "second" });
    const first = mock();
    const second = mock();
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .routes([
        craft().id("first").from(argv()).to(first),
        craft().id("second").from(argv()).to(second),
      ])
      .build();
    await t.test();
    expect(run.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "completed",
    ]);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  /**
   * @case A source that throws before it emits still reports a failure
   * @preconditions No arguments, and a stdin reader that rejects
   * @expectedResult One failed outcome carrying the reader's message, so the runner never exits 0 in silence
   */
  test("settles a failure when reading stdin throws", async () => {
    const run = invocation([], { routeId: "echo" });
    run.readStdin.mockImplementation(() =>
      Promise.reject(new Error("stdin went away")),
    );
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .routes(craft().id("echo").from(argv()).to(noop()))
      .build();
    await t.test();
    expect(run.outcomes).toEqual([
      { outcome: "failed", message: "stdin went away" },
    ]);
  });

  /**
   * @case Without a runner hand-off the source is inert
   * @preconditions No RUNNER_INVOCATION in the store, as under craft start; the route also has direct()
   * @expectedResult argv() emits nothing, and the route still answers through direct()
   */
  test("is inert when no runner handed over a command line", async () => {
    const step = mock((body: unknown) => body);
    t = await testContext()
      .routes(
        craft()
          .id("work-item")
          .input({ body: WorkItemQuery })
          .from(argv(), direct())
          .transform(step),
      )
      .build();
    await t.startAndWaitReady();
    expect(step).not.toHaveBeenCalled();
    const answer = await t.client.sendDirect("work-item", { id: "9" });
    expect(answer).toEqual({ id: "9" });
    expect(step).toHaveBeenCalledTimes(1);
  });
});
