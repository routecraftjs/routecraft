import { describe, expect, test } from "bun:test";
import {
  ContextBuilder,
  definePlugin,
  port,
  rcCodeOf,
  type Plugin,
} from "../src/index.ts";

async function refusal(plugins: Plugin[]): Promise<unknown> {
  try {
    await new ContextBuilder().with({ plugins }).build();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * A port's version is part of its identity, so two versions are two ports.
 * The kernel says so where a plugin built against one meets an application
 * that holds the other, instead of leaving either side to find out.
 */
describe("port versions", () => {
  const V1 = port<string>("test.rates@1");
  const V2 = port<string>("test.rates@2");

  const providesV1 = definePlugin({
    id: "test.rates-v1",
    provides: [V1],
    bind(c) {
      c.provide(V1, "one");
    },
  });

  /**
   * @case A replacement written for another version than the one installed
   * @preconditions One plugin providing test.rates@1, and one providing and replacing test.rates@2
   * @expectedResult RC1119 naming both plugins and both versions, rather than an application that runs both
   */
  test("a replacement that targets another version is RC1119", async () => {
    const error = await refusal([
      providesV1,
      definePlugin({
        id: "test.rates-v2",
        provides: [V2],
        replaces: [V2],
        bind(c) {
          c.provide(V2, "two");
        },
      }),
    ]);

    expect(rcCodeOf(error)).toBe("RC1119");
    const message = String(error);
    expect(message).toContain("test.rates-v1");
    expect(message).toContain("test.rates-v2");
    expect(message).toContain("test.rates@1");
    expect(message).toContain("test.rates@2");
  });

  /**
   * @case A defensive replacement of a port nobody provides at any version
   * @preconditions One plugin providing and replacing test.rates@2, and no other provider of test.rates
   * @expectedResult The application builds: displacing nobody is a fault only when another version is installed
   */
  test("a replacement with no provider at any version builds", async () => {
    const error = await refusal([
      definePlugin({
        id: "test.rates-v2",
        provides: [V2],
        replaces: [V2],
        bind(c) {
          c.provide(V2, "two");
        },
      }),
    ]);

    expect(error).toBeUndefined();
  });

  /**
   * @case One plugin ships both versions of its port and replaces both
   * @preconditions One plugin providing test.rates@1, and a migration plugin providing and replacing test.rates@1 and test.rates@2
   * @expectedResult The application builds: the old version is displaced, and the plugin's own second version is no sibling of itself
   */
  test("a plugin replacing both versions builds", async () => {
    const error = await refusal([
      providesV1,
      definePlugin({
        id: "test.rates-both",
        provides: [V1, V2],
        replaces: [V1, V2],
        bind(c) {
          c.provide(V1, "one");
          c.provide(V2, "two");
        },
      }),
    ]);

    expect(error).toBeUndefined();
  });

  /**
   * @case One plugin provides two versions and replaces only the newer
   * @preconditions A single plugin providing test.rates@1 and test.rates@2 and replacing test.rates@2, with no other provider
   * @expectedResult The application builds: the plugin's own older version does not make the replacement a mismatch
   */
  test("a plugin's own other version is not a sibling", async () => {
    const error = await refusal([
      definePlugin({
        id: "test.rates-both",
        provides: [V1, V2],
        replaces: [V2],
        bind(c) {
          c.provide(V1, "one");
          c.provide(V2, "two");
        },
      }),
    ]);

    expect(error).toBeUndefined();
  });

  /**
   * @case A plugin requires a version nobody provides while another is installed
   * @preconditions One plugin providing test.rates@1, and one requiring test.rates@2
   * @expectedResult RC1104 naming the installed test.rates@1 and its provider
   */
  test("a requirement of another version names the installed one", async () => {
    const error = await refusal([
      providesV1,
      definePlugin({ id: "test.consumer", requires: [V2] }),
    ]);

    expect(rcCodeOf(error)).toBe("RC1104");
    const message = String(error);
    expect(message).toContain('"test.rates@2"');
    expect(message).toContain('"test.rates-v1" provides "test.rates@1"');
  });

  /**
   * @case A requirement nobody provides at any version
   * @preconditions One plugin requiring test.rates@2, and no provider of test.rates
   * @expectedResult RC1104 with no sentence about another version
   */
  test("a requirement with no sibling says nothing of versions", async () => {
    const error = await refusal([
      definePlugin({ id: "test.consumer", requires: [V2] }),
    ]);

    expect(rcCodeOf(error)).toBe("RC1104");
    expect(String(error)).not.toContain("another version");
  });
});
