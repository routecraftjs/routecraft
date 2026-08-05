import { describe, expect, spyOn, test } from "bun:test";
import { CraftContext, type CraftConfig } from "../src/context.ts";
import { registerConfigApplier } from "../src/config-applier.ts";
import { logger } from "../src/logger.ts";

type WarnCall = [Record<string, unknown>, string];

/**
 * Build a stub child logger whose warn calls are captured. The context
 * creates its logger via `logger.child(...)` in the constructor, so the
 * spy must intercept `child` before construction.
 */
function stubChildLogger(calls: WarnCall[]) {
  const stub = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (obj: Record<string, unknown>, msg: string) => {
      calls.push([obj, msg]);
    },
    error: () => {},
    fatal: () => {},
    child: () => stub,
  };
  return stub as unknown as ReturnType<typeof logger.child>;
}

/** Construct a CraftContext with the child-logger spy installed and return the captured warn calls. */
function constructCapturingWarns(config: CraftConfig): WarnCall[] {
  const calls: WarnCall[] = [];
  const spy = spyOn(logger, "child").mockReturnValue(stubChildLogger(calls));
  try {
    new CraftContext(config);
  } finally {
    spy.mockRestore();
  }
  return calls;
}

describe("CraftContext unknown config keys", () => {
  /**
   * @case A config key with no registered applier warns at construction
   * @preconditions Context is constructed with `htttp` (typo) set to an object; no config applier is registered for that key
   * @expectedResult A warn log fires naming the key, so a typo'd or unregistered key is loud instead of a silent no-op
   */
  test("warns for a typo'd config key", () => {
    const calls = constructCapturingWarns({
      htttp: { port: 0 },
    } as CraftConfig);
    const hit = calls.find(([obj]) => obj["configKey"] === "htttp");
    expect(hit).toBeDefined();
    expect(hit![1]).toContain('Unknown config key "htttp"');
  });

  /**
   * @case Base constructor keys and registered applier keys do not warn
   * @preconditions A test applier is registered for a synthetic key; context is constructed with that key plus the base keys `name` and `plugins`
   * @expectedResult No unknown-config-key warning fires for any of them
   */
  test("does not warn for base keys or registered applier keys", () => {
    registerConfigApplier("unknownKeyTestApplier" as keyof CraftConfig, () => ({
      apply: () => {},
    }));
    const calls = constructCapturingWarns({
      name: "test",
      plugins: [],
      unknownKeyTestApplier: { enabled: true },
    } as CraftConfig);
    expect(
      calls.filter(([, msg]) => msg.includes("Unknown config key")),
    ).toEqual([]);
  });

  /**
   * @case An undefined value for an unknown key does not warn
   * @preconditions Context is constructed with an unknown key explicitly set to undefined
   * @expectedResult No warning fires; `undefined` means "not set" per the applier contract
   */
  test("does not warn when the unknown key is undefined", () => {
    const calls = constructCapturingWarns({ htttp: undefined } as CraftConfig);
    expect(
      calls.filter(([, msg]) => msg.includes("Unknown config key")),
    ).toEqual([]);
  });
});
