import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  AUTHENTICATES,
  ContextBuilder,
  craft,
  deferralPlugin,
  definePlugin,
  defineProject,
  direct,
  isDeferred,
  NESTED_STEPS,
  noop,
  OperationType,
  rcCodeOf,
  step,
  type Adapter,
  type NestingStep,
  type Step,
} from "../src/index.ts";

const SECRET = "structural-steps-test-secret-key-0123456789";

/**
 * A third-party structural step: it runs a branch of its own and reports it
 * through the public protocol, so the route's walks see inside it.
 */
function branching(
  steps: Step<Adapter>[],
  options: { readonly declare: boolean },
) {
  const raw: Step<Adapter> & Partial<NestingStep> = {
    operation: OperationType.PROCESS,
    adapter: { adapterId: "test.branch", steps } as Adapter,
    async execute(exchange) {
      return { kind: "branch", exchange, steps };
    },
    ...(options.declare
      ? { [NESTED_STEPS]: () => [{ steps, rejoins: true }] }
      : {}),
  };
  return definePlugin({
    id: "test.branching",
    steps: { customBranch: () => step(raw) },
  });
}

describe("a structural plugin step", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop().catch(() => undefined);
    t = undefined;
  });

  /**
   * @case A plugin step returns a branch holding a .defer() and a tail, declared through NESTED_STEPS, followed by a main tail
   * @preconditions A deferral runtime and a resume door
   * @expectedResult The exchange parks inside the branch and a resume runs the branch tail then the main tail, once
   */
  test("declared through NESTED_STEPS, parks and resumes through its branch", async () => {
    const deferral = deferralPlugin({
      store: "memory",
      secret: SECRET,
      sweepInterval: "1h",
    });
    const trace: string[] = [];
    const plugin = branching(
      [
        deferral.steps.defer({}),
        step((ex) => {
          trace.push("branch");
          return `${String(ex.body)}:branch`;
        }),
      ],
      { declare: true },
    );
    const project = defineProject({ plugins: [deferral, plugin] });
    t = await testContext()
      .with({ plugins: [deferral, plugin] })
      .routes([
        project
          .craft()
          .id("work")
          .from(direct())
          .customBranch()
          .transform((body) => {
            trace.push("main");
            return `${String(body)}:main`;
          }),
        project.craft().id("door").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = await t.client.sendDirect("work", "input");
    expect(isDeferred(parked)).toBe(true);
    expect(trace).toEqual([]);
    const answer = (await t.client.sendDirect("door", {
      token: (parked as { token: string }).token,
      result: true,
    })) as { status: string };
    expect(answer.status).toBe("resumed");
    expect(trace).toEqual(["branch", "main"]);
  });

  /**
   * @case The same branch is not declared through NESTED_STEPS
   * @preconditions A .defer() inside it
   * @expectedResult The park is refused (RC5051): the walk that assigns defer sites never saw the step, which is why the protocol is public
   */
  test("undeclared, hides its defer from the route", async () => {
    const deferral = deferralPlugin({
      store: "memory",
      secret: SECRET,
      sweepInterval: "1h",
    });
    const plugin = branching([deferral.steps.defer({})], { declare: false });
    const project = defineProject({ plugins: [deferral, plugin] });
    t = await testContext()
      .with({ plugins: [deferral, plugin] })
      .routes([project.craft().id("work").from(direct()).customBranch()])
      .build();
    await t.startAndWaitReady();

    let thrown: unknown;
    try {
      await t.client.sendDirect("work", "input");
    } catch (error) {
      thrown = error;
    }

    expect(rcCodeOf(thrown)).toBe("RC5051");
  });

  /**
   * @case A declared branch carries a step of a plugin the application does not install
   * @preconditions The hidden step was built with another project's craft()
   * @expectedResult RC1111 at start naming the missing plugin: the ownership walk follows the protocol into the branch
   */
  test("declared, exposes an uninstalled plugin's step to the start check", async () => {
    const hidden = definePlugin({
      id: "test.hidden",
      steps: { hidden: () => step((ex) => `${String(ex.body)}:hidden`) },
    });
    const [extracted] = defineProject({ plugins: [hidden] })
      .craft()
      .id("extract")
      .from(direct())
      .hidden()
      .build();
    const plugin = branching([extracted!.steps[0]!], { declare: true });
    const project = defineProject({ plugins: [plugin] });
    t = await testContext()
      .with({ plugins: [plugin] })
      .routes([project.craft().id("work").from(direct()).customBranch()])
      .build();

    let thrown: unknown;
    try {
      await t.startAndWaitReady();
    } catch (error) {
      thrown = error;
    }

    expect(rcCodeOf(thrown)).toBe("RC1111");
    expect(String(thrown)).toContain("test.hidden");
  });

  /**
   * @case A step that is not the shipped AuthenticateStep carries the AUTHENTICATES mark, inside a declared branch, on a route with a route-scope .cache()
   * @preconditions The mark is the registered symbol; the step's class is foreign
   * @expectedResult RC5003 at build: the guard reads the mark through the branch, so a step from another build or another author is seen
   */
  test("a foreign authenticating step is seen by the cache guard", async () => {
    const foreign: Step<Adapter> & { [AUTHENTICATES]: true } = {
      operation: OperationType.HEADER,
      adapter: { adapterId: "test.login" },
      [AUTHENTICATES]: true,
      async execute(exchange) {
        return { kind: "continue", exchange };
      },
    };
    const plugin = branching([foreign], { declare: true });
    const project = defineProject({ plugins: [plugin] });
    let thrown: unknown;
    try {
      await new ContextBuilder()
        .with({ plugins: [plugin] })
        .routes([
          project
            .craft()
            .id("guarded")
            .cache({ ttl: "1m" })
            .from(direct())
            .customBranch()
            .to(noop()),
        ])
        .build();
    } catch (error) {
      thrown = error;
    }

    expect(rcCodeOf(thrown)).toBe("RC5003");
    expect(String(thrown)).toContain(".authenticate()");
  });

  /**
   * @case A validate hook returns a refusal built by hand with the registered brand rather than by refuse()
   * @preconditions The brand is Symbol.for("routecraft.hook.refusal"), as the package's other build would produce
   * @expectedResult RC5068: the refusal is read by its brand, not by the module that built it
   */
  test("a refusal from another build is read as one", async () => {
    const foreignRefusal = {
      [Symbol.for("routecraft.hook.refusal")]: true,
      reason: "denied elsewhere",
      kind: "forbidden",
    };
    const gate = definePlugin({
      id: "test.gate",
      hooks: {
        admitted: {
          id: "deny",
          phase: "validate",
          run: () => foreignRefusal as never,
        },
      },
    });
    t = await testContext()
      .with({ plugins: [gate] })
      .routes([craft().id("work").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();

    let thrown: unknown;
    try {
      await t.client.sendDirect("work", {});
    } catch (error) {
      thrown = error;
    }

    expect(rcCodeOf(thrown)).toBe("RC5068");
    expect(String(thrown)).toContain("denied elsewhere");
  });
});
