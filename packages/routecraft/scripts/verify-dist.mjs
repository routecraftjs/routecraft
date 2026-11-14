/**
 * Post-build guard for the config-applier registrations (issue #423).
 *
 * The first-class config keys (`http`, `cron`, `direct`, `mail`, `carddav`,
 * `telemetry`) are wired through bare side-effect imports in `src/index.ts`.
 * Side-effect imports are exactly what packaging misconfiguration silently
 * drops: a `sideEffects` allowlist in package.json that omits the src config
 * modules made esbuild prune all of them from the published bundles, so
 * `defineConfig({ mail: {...} })` typechecked but did nothing at runtime.
 *
 * This script derives the expected applier keys from the source (any
 * `registerConfigApplier("key", ...)` call under `src/`), imports the built
 * bundle, and asserts every key is present in the live registry. Run once
 * per output format: `bun scripts/verify-dist.mjs esm|cjs`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// fileURLToPath (not URL.pathname) so the root is a real filesystem path
// on every platform; the dist import below converts back to a file URL,
// which the ESM loader requires for absolute specifiers on Windows.
const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

// Anchored to line start so indented JSDoc examples do not match; real
// registrations are top-level statements.
const APPLIER_CALL = /^registerConfigApplier\(\s*"([^"]+)"/gm;
const SHIPPED_CALL = /^registerShippedPlugin\(/gm;

function collectSourceKeys(dir, found = { keys: new Set(), shipped: 0 }) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceKeys(path, found);
    } else if (entry.name.endsWith(".ts")) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(APPLIER_CALL)) {
        found.keys.add(match[1]);
      }
      found.shipped += [...source.matchAll(SHIPPED_CALL)].length;
    }
  }
  return found;
}

const found = collectSourceKeys(join(pkgRoot, "src"));
const expected = [...found.keys].sort();
if (expected.length === 0 || found.shipped === 0) {
  const empty = [
    ...(expected.length === 0 ? ["registerConfigApplier()"] : []),
    ...(found.shipped === 0 ? ["registerShippedPlugin()"] : []),
  ];
  console.error(
    `verify-dist: found no ${empty.join(" or ")} calls under src/; the scan is broken.`,
  );
  process.exit(1);
}

// Reject an unrecognised mode instead of defaulting to ESM: a silent
// fallback would verify dist/index.js twice and report success while the
// CJS bundle went unchecked, defeating the guard for exactly the
// packaging regression it exists to catch.
const ENTRIES = { esm: "dist/index.js", cjs: "dist/index.cjs" };
const mode = process.argv[2] ?? "esm";

/**
 * One route over every wrapper, the nesting steps and the helpers that
 * return functions, built by the given main entry.
 */
function identityCorpus(m) {
  return m
    .craft()
    .id("identity")
    .from(m.direct())
    .transform((body) => body)
    .header("literal", "value")
    .validate(m.authorize({ roles: ["admin"] }))
    .enrich(
      m.http({ url: "https://a.example" }),
      m.only((r) => r.id, "id"),
    )
    .enrich(m.http({ url: "https://b.example" }), m.none())
    .transform(m.keep({ id: true }))
    .transform(m.mask({ id: () => "x" }))
    .transform(
      m.group({ comparator: m.cosine({ field: "e" }), from: (body) => body }),
    )
    .split()
    .aggregate()
    .retry({ maxAttempts: 2 })
    .timeout("1s")
    .throttle({ rate: 1, per: "1s" })
    .circuitBreaker({ failureThreshold: 2 })
    .concurrency({ max: 2 })
    .delay("1s")
    .cache({})
    .error(() => null)
    .to(m.noop())
    .choice(
      m.when(
        () => true,
        (branch) => branch.to(m.noop()),
      ),
      m.otherwise((branch) => branch.halt()),
    )
    .multicast(
      (branch) => branch.to(m.noop()),
      (branch) => branch.to(m.noop()),
    )
    .dispatch("round-robin", m.noop(), m.noop())
    .dedupe({ key: (exchange) => exchange.id })
    .defer({ ttl: "1h" })
    .log()
    .to(m.noop())
    .build()[0].steps;
}

/**
 * The `./internal` subpath is a second bundle, so the package `exports` map
 * and both of its outputs are checked against the shipped artifacts: a
 * sibling package resolves it by package name and gets nothing if either
 * is missing.
 */
if (mode === "internal") {
  const { createRequire } = await import("node:module");
  const esm = await import("@routecraft/routecraft/internal");
  const cjs = createRequire(import.meta.url)("@routecraft/routecraft/internal");
  const expected = Object.keys(
    await import(pathToFileURL(join(pkgRoot, "src/internal.ts")).href),
  ).sort();
  for (const [format, built] of [
    ["esm", esm],
    ["cjs", cjs],
  ]) {
    const actual = Object.keys(built).sort();
    if (expected.length === 0 || expected.join() !== actual.join()) {
      console.error(
        `verify-dist: the ${format} build of ./internal exports [${actual.join(", ")}]; src/internal.ts names [${expected.join(", ")}].`,
      );
      process.exit(1);
    }
  }
  const mains = [
    ["esm", await import("@routecraft/routecraft")],
    ["cjs", createRequire(import.meta.url)("@routecraft/routecraft")],
  ];
  for (const [format, built] of [
    ["esm", esm],
    ["cjs", cjs],
  ]) {
    let raised;
    try {
      built.rejectStaleOptions({ intervalMs: 1 }, "verifyDist");
    } catch (error) {
      raised = error;
    }
    for (const [mainFormat, main] of mains) {
      if (!main.isRoutecraftError(raised) || raised.rc !== "RC5003") {
        console.error(
          `verify-dist: an error raised through the ${format} build of ./internal is not recognised by the ${mainFormat} main entry.`,
        );
        process.exit(1);
      }
    }
  }
  // A step's identity must not depend on which build made it: a deferral
  // parked by an app on one format has to resume on the other.
  const digests = mains.map(([format, main]) => {
    const described = (format === "esm" ? esm : cjs).describeSteps(
      identityCorpus(main),
    );
    if (described.inferred.length > 0) {
      console.error(
        `verify-dist: the ${format} build leaves step identity inferred at ${described.inferred.map((node) => node.path).join(", ")}.`,
      );
      process.exit(1);
    }
    return described.digest;
  });
  if (digests[0] !== digests[1]) {
    console.error(
      "verify-dist: the same route digests differently in the ESM and the CJS build.",
    );
    process.exit(1);
  }
  console.log(
    `verify-dist: ./internal resolves in ESM and CJS with ${expected.length} runtime exports, and step identity agrees across the two.`,
  );
  process.exit(0);
}

/**
 * The two builds composed in one process: what a dependency graph that
 * resolves the package once as ESM and once as CJS gets. Both are supported
 * only one at a time, but the guards that keep a caller out must not read a
 * foreign-build object as "not ours": the cache-versus-authenticate guard
 * and the validate-hook refusal are structural (registered symbols), and
 * this is where that is held against the shipped artifacts.
 */
if (mode === "mixed") {
  // The two-copy warning and the refusal the probe expects are not build output.
  process.env.LOG_LEVEL ??= "silent";
  const { createRequire } = await import("node:module");
  const esm = await import(pathToFileURL(join(pkgRoot, ENTRIES.esm)).href);
  const cjs = createRequire(import.meta.url)(join(pkgRoot, ENTRIES.cjs));

  const project = esm.defineProject({ plugins: [cjs.authPlugin()] });
  const guarded = project
    .craft()
    .id("guarded")
    .cache({ ttl: "1m" })
    .from(esm.direct())
    .authenticate(() => ({ scheme: "verify", subject: "s" }))
    .to(esm.noop());
  let refused;
  try {
    await new esm.ContextBuilder().with(project.config).routes(guarded).build();
  } catch (error) {
    refused = error.rc;
  }
  if (refused !== "RC5003") {
    console.error(
      `verify-dist: a route-scope .cache() beside the CJS build's .authenticate() built in the ESM host (got ${refused ?? "no refusal"}, expected RC5003). The guard must see the step by its mark, not its class.`,
    );
    process.exit(1);
  }

  const gate = esm.definePlugin({
    id: "verify.gate",
    hooks: {
      admitted: {
        id: "deny",
        phase: "validate",
        run: () => cjs.refuse("denied", { kind: "forbidden" }),
      },
    },
  });
  const { context, client } = await new esm.ContextBuilder()
    .with({ plugins: [gate] })
    .routes(esm.craft().id("deny").from(esm.direct()).to(esm.noop()))
    .build();
  const running = context.start();
  running.catch(() => {});
  let code;
  try {
    await context.whenStarted();
    await client.sendDirect("deny", {});
  } catch (error) {
    code = error.rc;
  } finally {
    await context.stop();
    await running;
  }
  if (code !== "RC5068") {
    console.error(
      `verify-dist: a validate hook returning the CJS build's refuse() in the ESM host failed with ${code ?? "no error"}, expected RC5068. The refusal must be read by its brand, not its module.`,
    );
    process.exit(1);
  }
  console.log(
    "verify-dist: mixed ESM and CJS builds keep the guard and the refusal.",
  );
  process.exit(0);
}

const entry = ENTRIES[mode];
if (entry === undefined) {
  console.error(
    `verify-dist: unknown mode "${mode}"; expected one of ${[...Object.keys(ENTRIES), "mixed", "internal"].join(", ")}.`,
  );
  process.exit(1);
}
await import(pathToFileURL(join(pkgRoot, entry)).href);

const registry = globalThis[Symbol.for("routecraft.config-applier-registry")];
const missing = expected.filter((key) => !registry?.has(key));
if (missing.length > 0) {
  console.error(
    `verify-dist: ${entry} does not register config applier(s): ${missing.join(", ")}. ` +
      "The side-effect imports in src/index.ts were tree-shaken out of the bundle " +
      "(check the tsup config and any package.json sideEffects field).",
  );
  process.exit(1);
}

// The shipped-plugin registry is module-local by design, so the bundle is
// read for the registration calls themselves: one per `registerShippedPlugin`
// statement under src/, each at the top level of its module.
const bundle = readFileSync(join(pkgRoot, entry), "utf8");
const shippedInBundle = [
  ...bundle.matchAll(/(?<!function )registerShippedPlugin\(/g),
].length;
if (shippedInBundle < found.shipped) {
  console.error(
    `verify-dist: ${entry} carries ${shippedInBundle} registerShippedPlugin() call(s); src/ has ${found.shipped}. ` +
      "A default plugin's registration was tree-shaken out of the bundle, so an application would start without it.",
  );
  process.exit(1);
}

console.log(
  `verify-dist: ${entry} registers ${expected.length} config appliers (${expected.join(", ")}) and ${found.shipped} shipped plugins.`,
);
process.exit(0);
