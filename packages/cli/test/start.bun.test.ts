import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Silence logger output. Bun:test has no `importActual`/spread-and-override
// equivalent for `mock.module`, so spy on the live `logger` singleton
// directly. Spies are installed once and restored after all tests.
const { logger } = await import("@routecraft/routecraft");
const { startCommand } = await import("../src/start");

/**
 * The discoverer registry is global and shared across every test file
 * in a `bun test` run, so a sibling package's registration would leak
 * in here. Snapshot and restore around each case.
 */
const REGISTRY_KEY = Symbol.for("routecraft.project-discoverer-registry");
type Registry = Map<string, unknown>;
type GlobalWithRegistry = typeof globalThis & { [REGISTRY_KEY]?: Registry };

function snapshotRegistry(): Registry {
  return new Map((globalThis as GlobalWithRegistry)[REGISTRY_KEY] ?? new Map());
}

function restoreRegistry(snapshot: Registry): void {
  (globalThis as GlobalWithRegistry)[REGISTRY_KEY] = new Map(snapshot);
}

describe("CLI start command", () => {
  let spies: Array<{ mockRestore: () => void }> = [];
  let warn: ReturnType<typeof spyOn> | undefined;
  let snapshot: Registry | undefined;
  let roots: string[] = [];
  let counter = 0;

  beforeAll(() => {
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
      spyOn(logger, "debug").mockImplementation(() => {}),
    ];
  });

  afterAll(() => {
    for (const s of spies) s.mockRestore();
    spies = [];
  });

  beforeEach(() => {
    snapshot = snapshotRegistry();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (snapshot) restoreRegistry(snapshot);
    snapshot = undefined;
    warn?.mockRestore();
    warn = undefined;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots = [];
  });

  /**
   * Write a project tree. Lives inside the package so a dynamic import
   * of a temp file resolves workspace packages by climbing to the root
   * `node_modules`.
   */
  function makeProject(files: Record<string, string>): string {
    counter += 1;
    const root = join(import.meta.dir, `tmp-start-${Date.now()}-${counter}`);
    roots.push(root);
    for (const [name, content] of Object.entries(files)) {
      const target = join(root, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf-8");
    }
    return root;
  }

  const EMPTY_CONFIG = `export const craftConfig = {};\n`;

  function routeFile(id: string): string {
    return [
      `import { craft, simple, log } from "@routecraft/routecraft";`,
      `export default craft().id(${JSON.stringify(id)}).from(simple("hi")).to(log());`,
      "",
    ].join("\n");
  }

  /**
   * @case A route that throws on the way up fails the command
   * @preconditions One capability whose source throws from its subscribe,
   *   beside a healthy one
   * @expectedResult Failure naming the dead route, because context.start()
   *   settles every route and resolves even when one of them rejected
   */
  test("reports a route that failed to start as a failed boot", async () => {
    const root = makeProject({
      "craft.config.ts": EMPTY_CONFIG,
      "capabilities/healthy.ts": routeFile("healthy"),
      "capabilities/broken.ts": [
        `import { craft, log } from "@routecraft/routecraft";`,
        `const exploding = {`,
        `  subscribe() { throw new Error("source refused to start"); },`,
        `};`,
        `export default craft().id("broken").from(exploding).to(log());`,
        "",
      ].join("\n"),
    });
    const result = await startCommand(root, { once: true, timeoutMs: 5_000 });
    expect(result).toMatchObject({ success: false, code: 1 });
    // The startup-failure wording, not just the route name: the fixture
    // file is also called "broken", so matching the name alone would let
    // an import error pass as proof of startup accounting.
    expect(result.success === false && result.message).toMatch(
      /route\(s\) failed to start: broken/,
    );
  });

  /**
   * @case A runtime exchange failure is not reported as a failed boot
   * @preconditions One capability that starts cleanly and then throws inside
   *   its pipeline. Run without --once so start() drains every route and the
   *   outcome is the startup verdict rather than a race between exchanges
   * @expectedResult Success. The pipeline emits context:error carrying a route
   *   for a failed exchange as well as for a route that never came up, so
   *   counting both would fail a command whose project started perfectly
   */
  test("does not report a runtime exchange failure as a startup failure", async () => {
    const root = makeProject({
      "craft.config.ts": EMPTY_CONFIG,
      "capabilities/throws.ts": [
        `import { craft, simple, log } from "@routecraft/routecraft";`,
        `export default craft()`,
        `  .id("throws")`,
        `  .from(simple("hi"))`,
        `  .transform(() => { throw new Error("exchange blew up"); })`,
        `  .to(log());`,
        "",
      ].join("\n"),
    });
    const result = await startCommand(root);
    expect(result).toMatchObject({ success: true });
  });

  /**
   * @case A project without a config file fails with an actionable message
   * @preconditions Directory holding capabilities but no craft.config.ts
   * @expectedResult Failure naming craft.config.ts and pointing at craft run
   */
  test("fails clearly when craft.config.ts is missing", async () => {
    const root = makeProject({
      "capabilities/hello/route.ts": routeFile("hello"),
    });
    const result = await startCommand(root);
    expect(result).toMatchObject({ success: false, code: 1 });
    expect(result.success === false && result.message).toMatch(
      /No craft\.config\.ts found/,
    );
  });

  /**
   * @case Capabilities load from the folder form and the single-file form
   * @preconditions A route.ts capability folder, a nested domain, and a bare module
   * @expectedResult All three routes are registered and the context starts
   */
  test("discovers capabilities in both forms", async () => {
    const root = makeProject({
      "craft.config.ts": EMPTY_CONFIG,
      "capabilities/comms/send-email/route.ts": routeFile("send-email"),
      "capabilities/comms/poll-mail.ts": routeFile("poll-mail"),
      "capabilities/health.ts": routeFile("health"),
    });
    const result = await startCommand(root, { once: true });
    expect(result).toMatchObject({ success: true });
  });

  /**
   * @case Colocated tests, fixtures and helpers inside a capability are never imported
   * @preconditions A capability folder holding a throwing helper, test and fixture
   * @expectedResult Start succeeds, proving only route.ts was imported
   */
  test("never imports tests, fixtures or helpers inside a capability", async () => {
    const throws = `throw new Error("this module must never be imported");\n`;
    const root = makeProject({
      "craft.config.ts": EMPTY_CONFIG,
      "capabilities/orders/route.ts": routeFile("orders"),
      "capabilities/orders/mapper.ts": throws,
      "capabilities/orders/route.test.ts": throws,
      "capabilities/orders/route.bun.test.ts": throws,
      "capabilities/orders/__fixtures__/sample.ts": throws,
      "capabilities/__tests__/helper.ts": throws,
    });
    const result = await startCommand(root, { once: true });
    expect(result).toMatchObject({ success: true });
  });

  /**
   * @case A plugin module default-exporting a factory is a pointed error
   * @preconditions plugins/health.ts exports a factory function
   * @expectedResult Failure naming the file and pointing at craft.config.ts
   */
  test("errors when a plugin file exports a factory", async () => {
    const root = makeProject({
      "craft.config.ts": EMPTY_CONFIG,
      "plugins/health.ts": `export default () => ({ apply() {} });\n`,
    });
    const result = await startCommand(root);
    expect(result).toMatchObject({ success: false });
    const message = result.success === false ? result.message : "";
    expect(message).toMatch(/plugins\/health\.ts/);
    expect(message).toMatch(/factory, not a plugin instance/);
    expect(message).toMatch(/craft\.config\.ts/);
  });

  /**
   * @case A plugin instance is loaded from the plugins folder
   * @preconditions plugins/health.ts default-exports an object with apply()
   * @expectedResult The plugin's apply runs during startup
   */
  test("loads a plugin instance from plugins/", async () => {
    const root = makeProject({
      "craft.config.ts": EMPTY_CONFIG,
      "plugins/health.ts": [
        `import { writeFileSync } from "node:fs";`,
        `export default { name: "health", apply() { writeFileSync(new URL("./applied.txt", import.meta.url), "yes"); } };`,
        "",
      ].join("\n"),
      "capabilities/health.ts": routeFile("health"),
    });
    const result = await startCommand(root, { once: true });
    expect(result).toMatchObject({ success: true });
    expect(readFileSync(join(root, "plugins", "applied.txt"), "utf-8")).toBe(
      "yes",
    );
  });

  /**
   * @case An agents folder with no registered discoverer fails loudly
   * @preconditions agents/ present, registry cleared of the ai discoverers
   * @expectedResult Failure naming the folder and the erased type-import trap
   */
  test("errors when agents/ has no registered discoverer", async () => {
    restoreRegistry(new Map());
    const root = makeProject({
      "craft.config.ts": EMPTY_CONFIG,
      "agents/triage.md": `---\nname: triage\ndescription: d\n---\nsystem`,
    });
    const result = await startCommand(root);
    expect(result).toMatchObject({ success: false });
    const message = result.success === false ? result.message : "";
    expect(message).toMatch(/@routecraft\/ai/);
    expect(message).toMatch(/type-only import/);
  });

  /**
   * @case A registered discoverer receives the folder and contributes config
   * @preconditions A discoverer registered for "agents" that records its argument
   * @expectedResult It is called with the absolute agents directory
   */
  test("hands a present folder to its registered discoverer", async () => {
    const { registerProjectDiscoverer } =
      await import("@routecraft/routecraft");
    let seen: string | undefined;
    registerProjectDiscoverer("agents", async (ctx) => {
      seen = ctx.directory;
      return {};
    });
    const root = makeProject({
      "craft.config.ts": EMPTY_CONFIG,
      "agents/triage.md": `---\nname: triage\ndescription: d\n---\nsystem`,
      "capabilities/health.ts": routeFile("health"),
    });
    const result = await startCommand(root, { once: true });
    expect(result).toMatchObject({ success: true });
    expect(seen).toBe(join(root, "agents"));
  });

  /**
   * @case The src-nested layout is discovered like the root-level one
   * @preconditions Convention folders under src/ with the config at the root
   * @expectedResult Capabilities under src/ are loaded
   */
  test("supports the src-nested layout", async () => {
    const root = makeProject({
      "craft.config.ts": EMPTY_CONFIG,
      "src/capabilities/health/route.ts": routeFile("health"),
    });
    const result = await startCommand(root, { once: true });
    expect(result).toMatchObject({ success: true });
  });

  /**
   * @case A default-exported config is accepted with a warning
   * @preconditions craft.config.ts default-exports the config object
   * @expectedResult Start succeeds and the warning names the craftConfig export
   */
  test("accepts a default-exported config with a warning", async () => {
    const root = makeProject({
      "craft.config.ts": `export default { name: "app" };\n`,
      "capabilities/health.ts": routeFile("health"),
    });
    const result = await startCommand(root, { once: true });
    expect(result).toMatchObject({ success: true });
    const warned =
      warn?.mock.calls.map((c: unknown[]) => String(c[0])).join("\n") ?? "";
    expect(warned).toMatch(/craftConfig/);
  });

  /**
   * @case --once settles even when a server ingress holds the context open
   * @preconditions A project with both a direct() ingress (which never resolves
   *   its subscription) and a finite source that produces one exchange
   * @expectedResult startCommand resolves rather than hanging. Awaiting
   *   context.start() before the exchange watcher would block here forever,
   *   which is the shape --once exists to avoid.
   */
  test("--once settles with a server ingress holding the context open", async () => {
    const root = makeProject({
      "craft.config.ts": EMPTY_CONFIG,
      "capabilities/inbox.ts": [
        `import { craft, direct, log } from "@routecraft/routecraft";`,
        `export default craft().id("inbox").from(direct()).to(log());`,
        "",
      ].join("\n"),
      "capabilities/tick.ts": routeFile("tick"),
    });
    const result = await startCommand(root, { once: true, timeoutMs: 10_000 });
    expect(result).toMatchObject({ success: true });
  });

  /**
   * @case --timeout turns a project that produces nothing into a diagnosis
   * @preconditions Only a server ingress, so no exchange ever reaches a
   *   terminal outcome
   * @expectedResult Fails non-zero naming the timeout, rather than waiting
   *   for the CI job to be killed
   */
  test("--timeout fails when no exchange arrives", async () => {
    const root = makeProject({
      "craft.config.ts": EMPTY_CONFIG,
      "capabilities/inbox.ts": [
        `import { craft, direct, log } from "@routecraft/routecraft";`,
        `export default craft().id("inbox").from(direct()).to(log());`,
        "",
      ].join("\n"),
    });
    const result = await startCommand(root, { once: true, timeoutMs: 250 });
    expect(result).toMatchObject({ success: false, code: 1 });
    expect(result.success === false && result.message).toMatch(
      /No exchange reached a terminal outcome within 250ms/,
    );
  });

  /**
   * @case A config file exporting neither shape fails rather than booting empty
   * @preconditions craft.config.ts exports a wrongly-named const
   * @expectedResult Failure naming the expected export, not a silent empty config
   */
  test("errors when craft.config.ts exports neither shape", async () => {
    const root = makeProject({
      "craft.config.ts": `export const config = {};\n`,
      "capabilities/health.ts": routeFile("health"),
    });
    const result = await startCommand(root);
    expect(result).toMatchObject({ success: false });
    expect(result.success === false && result.message).toMatch(
      /exports neither "craftConfig" nor a config object/,
    );
  });

  /**
   * @case A capability module that exports no routes names the file
   * @preconditions A barrel-style module with no default export
   * @expectedResult Failure naming the offending file
   */
  test("errors when a capability module exports no routes", async () => {
    const root = makeProject({
      "craft.config.ts": EMPTY_CONFIG,
      "capabilities/index.ts": `export const nothing = 1;\n`,
    });
    const result = await startCommand(root);
    expect(result).toMatchObject({ success: false });
    expect(result.success === false && result.message).toMatch(
      /capabilities\/index\.ts/,
    );
  });
});
