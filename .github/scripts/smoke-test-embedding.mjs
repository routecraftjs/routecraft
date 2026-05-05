#!/usr/bin/env node

/**
 * Smoke test for the Node embedding path: pack @routecraft/routecraft, install
 * it from the tarball into a clean temp dir under npm, write a small runner.ts
 * that builds a context and dispatches a message via the client, and execute
 * it under plain Node (no CLI). Asserts the expected log line appears in
 * stdout and the process exits 0.
 *
 * Run from repo root after `bun run version:set` and `bun run build`. Uses only
 * npm and node so behaviour matches a real Node user embedding Routecraft in
 * their own application.
 *
 * Usage: node .github/scripts/smoke-test-embedding.mjs [version]
 *   version: optional; defaults to packages/routecraft/package.json version
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");

const version =
  process.argv[2] ||
  JSON.parse(
    readFileSync(join(rootDir, "packages/routecraft/package.json"), "utf8"),
  ).version;

if (!version) {
  console.error("Usage: node smoke-test-embedding.mjs [version]");
  process.exit(1);
}

const packDir = join(rootDir, "dist", "packs");
const smokeDir = process.env.RUNNER_TEMP
  ? join(process.env.RUNNER_TEMP, "smoke-embedding")
  : join(tmpdir(), "routecraft-smoke-embedding");

function run(cmd, opts = {}) {
  const cwd = opts.cwd || rootDir;
  console.log(`$ ${cmd}`);
  return execSync(cmd, {
    cwd,
    stdio: opts.stdio ?? "inherit",
    ...opts,
  });
}

console.log(`Smoke testing Node embedding (version: ${version})\n`);

// 1. Pack routecraft. Embedding does not need the CLI or testing tarballs:
//    consumers depend on @routecraft/routecraft only.
mkdirSync(packDir, { recursive: true });
run(`npm pack --pack-destination "${packDir}"`, {
  cwd: join(rootDir, "packages", "routecraft"),
});

const tarballs = readdirSync(packDir).filter(
  (f) => f.startsWith("routecraft-routecraft-") && f.endsWith(".tgz"),
);
if (tarballs.length !== 1) {
  console.error(
    `Expected 1 routecraft tarball in ${packDir}, got: ${
      tarballs.join(", ") || "none"
    }`,
  );
  process.exit(1);
}

// 2. Temp dir: npm init + install routecraft from the tarball only.
mkdirSync(smokeDir, { recursive: true });
run("npm init -y", { cwd: smokeDir });
const smokePkgPath = join(smokeDir, "package.json");
const smokePkg = JSON.parse(readFileSync(smokePkgPath, "utf8"));
smokePkg.type = "module";
writeFileSync(smokePkgPath, JSON.stringify(smokePkg, null, 2) + "\n");

const tarballPath = join(packDir, tarballs[0]);
// Install only @routecraft/routecraft; optional peer deps (croner, cheerio,
// imapflow, ...) must NOT be required for an embed that does not use the
// corresponding adapters.
run(`npm install "${tarballPath}"`, { cwd: smokeDir });

// 3. Write a runner.ts that exercises the embedding API: ContextBuilder,
//    a route with direct() source and log() destination, and a single
//    client.send() to assert the dispatch path works end to end.
const runnerSource = `import {
  craft,
  direct,
  log,
  ContextBuilder,
} from "@routecraft/routecraft";

const route = craft()
  .id("greet")
  .from(direct<{ name: string }>())
  .transform((body) => \`Hello, \${body.name}!\`)
  .to(log());

const builder = new ContextBuilder();
builder.routes(route);
const { context, client } = await builder.build();
context.start();

try {
  await client.send("greet", { name: "embedded-node" });
  console.log("[smoke-embedding] dispatched OK");
} finally {
  await context.stop();
}
`;
writeFileSync(join(smokeDir, "runner.ts"), runnerSource);

// 4. Execute under plain Node. Node 24 strips TypeScript types by default;
//    older versions need --experimental-strip-types. We pass the flag
//    unconditionally; on 24+ it is a harmless no-op alias.
//    CRAFT_LOG_LEVEL=info ensures log() output appears in the captured stream
//    (default is warn).
const output = run("node --experimental-strip-types runner.ts", {
  cwd: smokeDir,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, CRAFT_LOG_LEVEL: "info" },
}).toString();

if (!output.includes("[smoke-embedding] dispatched OK")) {
  console.error("Expected dispatch confirmation in output, got:\n" + output);
  process.exit(1);
}

if (!output.includes("Hello, embedded-node!")) {
  console.error(
    'Expected log() to emit "Hello, embedded-node!" in output, got:\n' + output,
  );
  process.exit(1);
}

console.log(output);

// 5. Negative arm: a runner that uses cron() (whose driver `croner` is an
//    optional peer dep that we deliberately did not install) should fail
//    with the friendly RC5017 message rather than `ERR_MODULE_NOT_FOUND`.
//    Locks the optional-peer contract: the package loads without croner,
//    the friendly error fires only when the adapter is actually used.
const negativeRunnerSource = `import {
  craft,
  cron,
  log,
  ContextBuilder,
} from "@routecraft/routecraft";

const route = craft()
  .id("tick")
  .from(cron("* * * * *"))
  .to(log());

const builder = new ContextBuilder();
builder.routes(route);
const { context } = await builder.build();

let captured = null;
context.on("context:error", ({ details }) => {
  if (!captured) captured = details.error;
});

await context.start();
// Give the rejecting subscribe() a tick to land on context:error.
await new Promise((r) => setTimeout(r, 100));
await context.stop();

if (!captured) {
  console.error("[smoke-embedding] expected context:error to fire");
  process.exit(1);
}
const err = captured;
console.log("[smoke-embedding] rc=" + (err && err.rc ? err.rc : "?"));
console.log(
  "[smoke-embedding] message=" +
    (err instanceof Error ? err.message : String(err)),
);
`;
writeFileSync(join(smokeDir, "negative-runner.ts"), negativeRunnerSource);

const negativeOutput = run(
  "node --experimental-strip-types negative-runner.ts",
  {
    cwd: smokeDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CRAFT_LOG_LEVEL: "silent" },
  },
).toString();

if (!negativeOutput.includes("rc=RC5017")) {
  console.error(
    "Expected rc=RC5017 in negative-arm output, got:\n" + negativeOutput,
  );
  process.exit(1);
}
if (!negativeOutput.includes("croner")) {
  console.error(
    'Expected "croner" mentioned in negative-arm output, got:\n' +
      negativeOutput,
  );
  process.exit(1);
}

console.log(negativeOutput);
console.log("\nNode embedding smoke test passed (positive + negative).");
