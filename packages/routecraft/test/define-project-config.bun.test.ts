import { describe, expect, expectTypeOf, test } from "bun:test";
import {
  type CraftConfig,
  defineProject,
  type EventName,
  type EventPayload,
} from "../src/index.ts";

/**
 * Stands in for an ecosystem package (such as `@routecraft/ai`) that adds a
 * first-class key. It targets the published specifier so it merges into the
 * same `CraftConfig` identity that project.ts imports.
 */
declare module "@routecraft/routecraft" {
  interface CraftConfig {
    __defineConfigTest?: { endpoint: string; retries?: number };
  }
}

describe("the configuration a project is defined with", () => {
  /**
   * @case A project carries the configuration it was defined with
   * @preconditions A definition with one core key and no plugins
   * @expectedResult The project's config holds the key as written, with an empty plugin list
   */
  test("carries the definition as its config", () => {
    const project = defineProject({ cron: { timezone: "UTC" } });

    expect(project.config).toEqual({ cron: { timezone: "UTC" }, plugins: [] });
  });

  /**
   * @case A top-level key CraftConfig does not declare is a compile error,
   *   even beside a valid key
   * @preconditions A config literal with a valid `name` and a misspelled
   *   `shutdwon` key
   * @expectedResult A compile error on the typo, so the `@ts-expect-error`
   *   is used. A bare generic parameter would let the valid `name` satisfy
   *   the constraint and never check the typo; the definition's mapped
   *   `never` is what keeps the check.
   */
  test("rejects an unknown top-level key", () => {
    const compiled = (): unknown =>
      defineProject({
        name: "app",
        // @ts-expect-error shutdwon is not a CraftConfig key
        shutdwon: { timeout: "10s" },
      });
    expect(compiled).toBeFunction();
  });

  /**
   * @case The 0.6 listener shape under `http` is a compile error
   * @preconditions `http: { host, port, auth }`, where 0.7 moved `host` and
   *   `port` to `servers` and kept only `auth` on the http options
   * @expectedResult TS2353 on `host`. The shared `auth` key is what let this
   *   compile under the generic signature: it satisfied the constraint on
   *   the all-optional http options, and `host` / `port` went unchecked
   *   until the config failed at boot.
   */
  test("rejects the 0.6 http listener shape", () => {
    const compiled = (): unknown =>
      defineProject({
        // @ts-expect-error host and port moved to servers in 0.7
        http: { host: "0.0.0.0", port: 8080, auth: false },
      });
    expect(compiled).toBeFunction();
  });

  /**
   * @case An unknown key nested inside a known block is a compile error
   * @preconditions `shutdown` carries the 0.7 `timeout` beside the removed
   *   0.6 `timeoutMs`
   * @expectedResult TS2353 on `timeoutMs`, the same error a
   *   `const c: CraftConfig = {...}` annotation reports
   */
  test("rejects an unknown nested key", () => {
    const compiled = (): unknown =>
      defineProject({
        // @ts-expect-error timeoutMs was renamed to timeout in 0.7
        shutdown: { timeout: "10s", timeoutMs: 10_000 },
      });
    expect(compiled).toBeFunction();
  });

  /**
   * @case A valid config, including a key added by module augmentation,
   *   compiles and is typed as CraftConfig
   * @preconditions This file augments CraftConfig with `__defineConfigTest`;
   *   the literal mixes core keys, an event handler, and the augmented key
   * @expectedResult The call typechecks, the result is a CraftConfig that
   *   can be handed to anything taking one, the augmented key carries its
   *   declared type, and the handler parameter is contextually typed
   */
  test("accepts a valid config with an augmented key", () => {
    const cfg = defineProject({
      name: "app",
      shutdown: { timeout: "10s" },
      on: {
        "context:starting": (payload) => {
          expectTypeOf(payload).toEqualTypeOf<EventPayload<EventName>>();
        },
      },
      __defineConfigTest: { endpoint: "https://example.test", retries: 2 },
    }).config;

    expectTypeOf(cfg).toEqualTypeOf<CraftConfig>();
    expectTypeOf(cfg.__defineConfigTest).toEqualTypeOf<
      { endpoint: string; retries?: number } | undefined
    >();
    expect(cfg.__defineConfigTest?.endpoint).toBe("https://example.test");
  });

  /**
   * @case An augmented key is held to its declared shape, not just accepted
   * @preconditions `__defineConfigTest` given a key its declaration lacks
   * @expectedResult TS2353 on the unknown key, so augmentation keys get the
   *   same exactness as core keys
   */
  test("rejects an unknown key inside an augmented block", () => {
    const compiled = (): unknown =>
      defineProject({
        // @ts-expect-error timeout is not part of the augmented shape
        __defineConfigTest: { endpoint: "https://example.test", timeout: 5 },
      });
    expect(compiled).toBeFunction();
  });
});
