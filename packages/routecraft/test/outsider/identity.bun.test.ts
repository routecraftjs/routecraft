import { describe, expect, test } from "bun:test";
import {
  IDENTITY,
  OperationType,
  definePlugin,
  defineProject,
  direct,
  identified,
  secret,
  step,
  versioned,
  type Identity,
  type IdentifiedAdapter,
  type IdentifiedStep,
} from "@routecraft/routecraft";
import { describeIdentity } from "@routecraft/testing";

describe("step identity from the published packages", () => {
  /**
   * @case A plugin author ships a step and says when its behaviour changed
   * @preconditions A catalogue step built with `step(fn, { identity })`, at two versions and with two arguments
   * @expectedResult The digest moves with the version and with the argument, holds otherwise, names the kind after the plugin, and reports nothing inferred
   */
  test("a catalogue step versions itself", () => {
    const steps = (version: number, rate: number) => {
      const pricing = definePlugin({
        id: "acme.pricing",
        steps: {
          withTax: (r: number) =>
            step<{ total: number }, number>((ex) => ex.body.total * r, {
              identity: { version },
            }),
        },
      });
      return defineProject({ plugins: [pricing] })
        .craft()
        .id("pricing")
        .from(direct<{ total: number }>())
        .withTax(rate)
        .build()[0]!.steps;
    };
    const base = describeIdentity(steps(1, 0.1));
    expect(base.inferred).toEqual([]);
    expect(base.kinds).toEqual(["acme.pricing.withTax"]);
    expect(base.digest).toBe(describeIdentity(steps(1, 0.1)).digest);
    expect(base.digest).not.toBe(describeIdentity(steps(2, 0.1)).digest);
    expect(base.digest).not.toBe(describeIdentity(steps(1, 0.2)).digest);
  });

  /**
   * @case A hand-written step and adapter state their identity
   * @preconditions A raw step implementing `[IDENTITY]` over an adapter that implements it too, holding a token, a client and a url
   * @expectedResult Rotating the token or replacing the client instance keeps the digest; changing the url or the client's stated version moves it; nothing is inferred
   */
  test("a raw step and its adapter state what defines them", () => {
    class Client {}
    const payout = (
      url: string,
      token: string,
      clientVersion: string,
    ): IdentifiedStep => {
      const adapter: IdentifiedAdapter = {
        adapterId: "acme.payout",
        [IDENTITY]: () => ({
          options: {
            url,
            token: secret(token),
            client: versioned(new Client(), clientVersion),
          },
        }),
      };
      return {
        operation: OperationType.TO,
        adapter,
        execute: async (exchange) => ({ kind: "continue", exchange }),
        [IDENTITY]: (): Identity => ({
          kind: "acme.payout.send",
          options: { adapter },
        }),
      };
    };
    const digest = (...args: Parameters<typeof payout>) =>
      describeIdentity([payout(...args)]);

    const base = digest("https://a.example", "old", "v1");
    expect(base.inferred).toEqual([]);
    expect(base.digest).toBe(digest("https://a.example", "new", "v1").digest);
    expect(base.digest).not.toBe(
      digest("https://b.example", "old", "v1").digest,
    );
    expect(base.digest).not.toBe(
      digest("https://a.example", "old", "v2").digest,
    );
  });

  /**
   * @case A step holds a value it does not describe
   * @preconditions A raw step whose stated identity carries a class instance
   * @expectedResult The description names where the value sits, which is what RC5071 reports on a route that defers
   */
  test("an undescribed value is reported, not hidden", () => {
    class Client {}
    const blind: IdentifiedStep = {
      operation: OperationType.PROCESS,
      adapter: {},
      execute: async (exchange) => ({ kind: "continue", exchange }),
      [IDENTITY]: (): Identity => ({
        kind: "acme.blind",
        options: { client: new Client() },
      }),
    };
    expect(describeIdentity([blind]).inferred).toEqual([
      { path: "steps[0].options.client", reason: "a class instance" },
    ]);
  });

  /**
   * @case A third party's helper returns a function and states what it was given
   * @preconditions A catalogue step taking a predicate; a helper `atLeast(min)` returning one closure text for every `min`, wrapped with `identified()`
   * @expectedResult Two thresholds digest differently and nothing is inferred, using published names only
   */
  test("a helper identifies the function it returns", () => {
    const atLeast = (min: number) =>
      identified((value: number) => value >= min, {
        kind: "acme.atLeast",
        options: { min },
      });
    const gate = definePlugin({
      id: "acme.gate",
      steps: {
        gate: (allow: (value: number) => boolean) =>
          step<number, number>((ex) => (allow(ex.body) ? ex.body : 0)),
      },
    });
    const steps = (min: number) =>
      defineProject({ plugins: [gate] })
        .craft()
        .id("gate")
        .from(direct<number>())
        .gate(atLeast(min))
        .build()[0]!.steps;
    expect(describeIdentity(steps(1)).inferred).toEqual([]);
    expect(describeIdentity(steps(1)).digest).not.toBe(
      describeIdentity(steps(2)).digest,
    );
  });
});
