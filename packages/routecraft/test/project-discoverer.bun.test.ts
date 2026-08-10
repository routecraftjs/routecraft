import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getProjectDiscoverers,
  mergeProjectConfig,
  registerProjectDiscoverer,
  type CraftConfig,
  type RegisteredProjectDiscoverer,
} from "../src/index.ts";

/**
 * Access the cross-instance discoverer registry directly so tests can
 * sandbox registrations and reset between cases. Mirrors the symbol
 * used in project-discoverer.ts.
 */
const REGISTRY_KEY = Symbol.for("routecraft.project-discoverer-registry");

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, RegisteredProjectDiscoverer>;
};

function snapshotRegistry(): Map<string, RegisteredProjectDiscoverer> {
  const g = globalThis as GlobalWithRegistry;
  return new Map(g[REGISTRY_KEY] ?? new Map());
}

function restoreRegistry(
  snapshot: Map<string, RegisteredProjectDiscoverer>,
): void {
  const g = globalThis as GlobalWithRegistry;
  g[REGISTRY_KEY] = new Map(snapshot);
}

describe("registerProjectDiscoverer", () => {
  let snapshot: Map<string, RegisteredProjectDiscoverer> | undefined;

  beforeEach(() => {
    snapshot = snapshotRegistry();
  });

  afterEach(() => {
    if (snapshot) restoreRegistry(snapshot);
    snapshot = undefined;
  });

  /**
   * @case A registered discoverer is retrievable by folder name
   * @preconditions One discoverer registered for "__testFolder"
   * @expectedResult getProjectDiscoverers includes it with the default order
   */
  test("registers a discoverer for a folder", () => {
    const discover = async (): Promise<Partial<CraftConfig>> => ({});
    registerProjectDiscoverer("__testFolder", discover);
    const found = getProjectDiscoverers().find(
      (d) => d.folder === "__testFolder",
    );
    expect(found).toMatchObject({ folder: "__testFolder", order: 0 });
    expect(found?.discover).toBe(discover);
  });

  /**
   * @case Discoverers run in ascending order regardless of registration order
   * @preconditions Two discoverers registered high-order first
   * @expectedResult The lower order comes first in the returned list
   */
  test("returns discoverers in ascending order", () => {
    registerProjectDiscoverer("__testLate", async () => ({}), { order: 20 });
    registerProjectDiscoverer("__testEarly", async () => ({}), { order: 10 });
    const folders = getProjectDiscoverers()
      .map((d) => d.folder)
      .filter((f) => f.startsWith("__test"));
    expect(folders).toEqual(["__testEarly", "__testLate"]);
  });

  /**
   * @case Equal orders keep registration order
   * @preconditions Two discoverers registered with no explicit order
   * @expectedResult The first registered comes first
   */
  test("ties keep registration order", () => {
    registerProjectDiscoverer("__testA", async () => ({}));
    registerProjectDiscoverer("__testB", async () => ({}));
    const folders = getProjectDiscoverers()
      .map((d) => d.folder)
      .filter((f) => f === "__testA" || f === "__testB");
    expect(folders).toEqual(["__testA", "__testB"]);
  });

  /**
   * @case Re-registering a folder replaces the previous discoverer
   * @preconditions Same folder registered twice with different functions
   * @expectedResult Only one entry remains and it is the last registered
   */
  test("re-registering a folder replaces the previous one", () => {
    const second = async (): Promise<Partial<CraftConfig>> => ({});
    registerProjectDiscoverer("__testDup", async () => ({}));
    registerProjectDiscoverer("__testDup", second);
    const matches = getProjectDiscoverers().filter(
      (d) => d.folder === "__testDup",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.discover).toBe(second);
  });
});

describe("mergeProjectConfig", () => {
  /**
   * @case Nested plain objects merge rather than replace
   * @preconditions Base declares one agent, fragment declares another
   * @expectedResult Both agents survive the merge
   */
  test("merges nested plain objects", () => {
    const base = { name: "app", agent: { agents: { a: 1 } } };
    const merged = mergeProjectConfig(
      base as unknown as CraftConfig,
      {
        agent: { agents: { b: 2 } },
      } as unknown as Partial<CraftConfig>,
    ) as unknown as {
      agent: { agents: Record<string, number> };
    };
    expect(merged.agent.agents).toEqual({ a: 1, b: 2 });
  });

  /**
   * @case Arrays concatenate with the base first
   * @preconditions Base and fragment both carry plugins
   * @expectedResult Result holds both, base-declared plugins first
   */
  test("concatenates arrays", () => {
    const one = { apply: (): void => {} };
    const two = { apply: (): void => {} };
    const merged = mergeProjectConfig({ plugins: [one] }, { plugins: [two] });
    expect(merged.plugins).toEqual([one, two]);
  });

  /**
   * @case A scalar in the fragment replaces the base value
   * @preconditions Base and fragment both set `name`
   * @expectedResult The fragment's value wins
   */
  test("fragment scalars replace base values", () => {
    const merged = mergeProjectConfig({ name: "base" }, { name: "fragment" });
    expect(merged.name).toBe("fragment");
  });

  /**
   * @case An undefined fragment value leaves the base untouched
   * @preconditions Fragment carries the key with an undefined value
   * @expectedResult The base value survives
   */
  test("ignores undefined fragment values", () => {
    const merged = mergeProjectConfig({ name: "base" }, {
      name: undefined,
    } as unknown as Partial<CraftConfig>);
    expect(merged.name).toBe("base");
  });

  /**
   * @case Neither input is mutated
   * @preconditions Base with a nested object, fragment adding to it
   * @expectedResult Base still holds only its original nested keys
   */
  test("does not mutate its inputs", () => {
    const base = { agent: { agents: { a: 1 } } } as unknown as CraftConfig;
    mergeProjectConfig(base, {
      agent: { agents: { b: 2 } },
    } as unknown as Partial<CraftConfig>);
    expect(
      (base as unknown as { agent: { agents: Record<string, number> } }).agent
        .agents,
    ).toEqual({ a: 1 });
  });

  /**
   * @case A branded object literal survives the merge intact
   * @preconditions Both sides hold an object literal carrying a Symbol.for brand
   * @expectedResult The fragment's object is kept by identity, brand and all
   */
  test("does not rebuild objects carrying a symbol brand", () => {
    const BRAND = Symbol.for("routecraft.test.brand");
    const selection = { [BRAND]: true, refs: ["a"] };
    const merged = mergeProjectConfig(
      {
        agent: { defaultOptions: { tools: { [BRAND]: true, refs: ["b"] } } },
      } as unknown as CraftConfig,
      {
        agent: { defaultOptions: { tools: selection } },
      } as unknown as Partial<CraftConfig>,
    ) as unknown as {
      agent: { defaultOptions: { tools: typeof selection } };
    };
    expect(merged.agent.defaultOptions.tools).toBe(selection);
    expect(merged.agent.defaultOptions.tools[BRAND]).toBe(true);
  });

  /**
   * @case A class instance in the fragment replaces rather than merges
   * @preconditions Base holds a plain object, fragment holds an instance
   * @expectedResult The instance survives intact, not spread into a literal
   */
  test("replaces non-plain objects instead of merging them", () => {
    class Selection {
      readonly kind = "selection";
    }
    const instance = new Selection();
    const merged = mergeProjectConfig(
      { agent: { defaultOptions: {} } } as unknown as CraftConfig,
      {
        agent: { defaultOptions: { tools: instance } },
      } as unknown as Partial<CraftConfig>,
    ) as unknown as {
      agent: { defaultOptions: { tools: Selection } };
    };
    expect(merged.agent.defaultOptions.tools).toBe(instance);
  });
});
