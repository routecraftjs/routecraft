import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  argv,
  craft,
  direct,
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

/** A runner hand-off that records the outcome and whether stdin was read. */
function invocation(
  args: string[],
  options: { scopes?: string[]; stdin?: string } = {},
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
      argv: args,
      scopes: options.scopes ?? [],
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
    const run = invocation([], { stdin: '{"id":"7"}' });
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
    const run = invocation(["12345"]);
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
   * @case The local principal holds only the configured scopes
   * @preconditions A route requiring boards:read; the runner configured no scopes
   * @expectedResult A refused outcome of kind insufficient_scope naming boards:read, so .authorize() keeps its meaning under the runner
   */
  test("refuses a route whose scope the operator does not hold", async () => {
    const run = invocation(["--id=1"], { scopes: [] });
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
    expect(run.outcomes).toEqual([
      {
        outcome: "refused",
        refusal: {
          kind: "insufficient_scope",
          scopes: ["boards:read"],
          anyOf: false,
        },
      },
    ]);
    expect(step).not.toHaveBeenCalled();
  });

  /**
   * @case A configured scope admits the local principal
   * @preconditions A route requiring boards:read; the runner configured boards:read
   * @expectedResult A completed outcome, and the route sees a local principal for the operator
   */
  test("admits the operator with the configured scope", async () => {
    const run = invocation(["--id=1"], { scopes: ["boards:read"] });
    let principal: unknown;
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
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
    expect(principal).toMatchObject({
      kind: "local",
      scheme: "local",
      subjectProfile: "user",
      scopes: ["boards:read"],
    });
  });

  /**
   * @case A filter that declines the exchange is a drop, not a result
   * @preconditions A route whose filter rejects every exchange
   * @expectedResult A dropped outcome, never the request echoed back as the answer
   */
  test("reports a filtered exchange as dropped", async () => {
    const run = invocation(["--id=1"]);
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
    const run = invocation(["--id=1"]);
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
    const run = invocation(["--amount=10"]);
    t = await testContext()
      .with({ ...deferring() } as CraftConfig)
      .store(RUNNER_INVOCATION, run.invocation)
      .routes([
        craft()
          .id("payout")
          .from(argv())
          .defer({ schema: z.object({ approved: z.boolean() }), ttl: "1h" })
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
   * @case --help describes the route instead of running it
   * @preconditions A titled route with an .input() schema; --help given
   * @expectedResult A help outcome carrying the id, title and the rendered input schema with its field descriptions, and the route never ran
   */
  test("answers --help with the input schema", async () => {
    const run = invocation(["--help"]);
    const step = mock();
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .routes(
        craft()
          .id("work-item")
          .title("Fetch a work item")
          .input({ body: WorkItemQuery })
          .from(argv())
          .to(step),
      )
      .build();
    await t.test();
    const outcome = run.outcomes[0];
    expect(outcome?.outcome).toBe("help");
    if (outcome?.outcome !== "help") return;
    expect(outcome.route).toMatchObject({
      id: "work-item",
      title: "Fetch a work item",
      input: {
        properties: { id: { description: "The work item id" } },
        required: ["id"],
      },
    });
    expect(step).not.toHaveBeenCalled();
  });

  /**
   * @case A route field named like a runner flag is refused
   * @preconditions The .input() body declares a "format" field
   * @expectedResult A usage outcome naming the field, because --format after the file belongs to the runner
   */
  test("refuses an input field that collides with a runner flag", async () => {
    const run = invocation(["--format=csv"]);
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .routes(
        craft()
          .id("export")
          .input({ body: z.object({ format: z.string() }) })
          .from(argv())
          .to(noop()),
      )
      .build();
    await t.test();
    const outcome = run.outcomes[0];
    expect(outcome?.outcome).toBe("usage");
    if (outcome?.outcome !== "usage") return;
    expect(outcome.message).toMatch(/"format"/);
  });

  /**
   * @case Two routes reading one command line is a usage error
   * @preconditions Two argv() routes in one context
   * @expectedResult One of the outcomes is a usage error naming both routes
   */
  test("refuses a second argv() route on the same invocation", async () => {
    const run = invocation(["--id=1"]);
    t = await testContext()
      .store(RUNNER_INVOCATION, run.invocation)
      .routes([
        craft().id("first").from(argv()).to(noop()),
        craft().id("second").from(argv()).to(noop()),
      ])
      .build();
    await t.test();
    const usage = run.outcomes.find((outcome) => outcome.outcome === "usage");
    expect(usage).toBeDefined();
    if (usage?.outcome !== "usage") return;
    expect(usage.message).toMatch(/"first" and "second"/);
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
