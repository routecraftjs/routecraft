import { spawn } from "bun";
/* eslint-disable no-console -- Executable spike reports intentionally write validation evidence. */
/** Builds declarations + JS, packs, and installs in an isolated consumer with no workspace aliases. */
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "../.."),
  out = join(import.meta.dir, "package");
async function run(args: string[], cwd = root) {
  const p = spawn(args, {
    cwd,
    env: {
      ...process.env,
      TMPDIR: "/private/tmp",
      BUN_INSTALL_CACHE_DIR: "/private/tmp/routecraft-bun-cache",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  if (code) throw Error(`${args.join(" ")}\n${stdout}\n${stderr}`);
  return stdout;
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await run([
  process.execPath,
  "build",
  "src/v2/index.ts",
  "--target=bun",
  "--outfile",
  join(out, "index.js"),
]);
await run([
  process.execPath,
  resolve(root, "../../node_modules/typescript/bin/tsc"),
  "-p",
  "validation/round-two/tsconfig.publish.json",
]);
for (const file of readdirSync(out).filter((f) => f.endsWith(".d.ts"))) {
  const path = join(out, file);
  writeFileSync(
    path,
    readFileSync(path, "utf8")
      .replaceAll('.ts"', '.js"')
      .replaceAll(".ts'", ".js'"),
  );
}
writeFileSync(
  join(out, "package.json"),
  JSON.stringify({
    name: "@routecraft/spike-plugin-architecture",
    version: "0.0.5",
    type: "module",
    exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
    files: ["*.js", "*.d.ts"],
  }),
);
writeFileSync(join(out, "private.js"), "export const secret = 1;\n");
await run(
  [process.execPath, "pm", "pack", "--destination", import.meta.dir],
  out,
);
const tar = join(
  import.meta.dir,
  readdirSync(import.meta.dir).find((f) => f.endsWith(".tgz"))!,
);
const consumer = mkdtempSync(join(tmpdir(), "routecraft-external-"));
try {
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "outside-consumer",
      type: "module",
      dependencies: { "@routecraft/spike-plugin-architecture": `file:${tar}` },
    }),
  );
  await run([process.execPath, "install", "--ignore-scripts"], consumer);
  // Type support is copied, never linked to workspace sources; only the artifact is the framework dependency.
  for (const name of ["bun-types", "@types/node"]) {
    const dest = join(consumer, "node_modules", name);
    mkdirSync(resolve(dest, ".."), { recursive: true });
    cpSync(resolve(root, "../../node_modules", name), dest, {
      recursive: true,
      dereference: true,
    });
  }
  cpSync(
    join(import.meta.dir, "external.fixture.ts"),
    join(consumer, "index.ts"),
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "Preserve",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["bun-types"],
      },
      include: ["index.ts"],
    }),
  );
  await run(
    [
      process.execPath,
      resolve(root, "../../node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.json",
    ],
    consumer,
  );
  console.log((await run([process.execPath, "index.ts"], consumer)).trim());
  // Boundary negative control is checked against the installed artifact, not aliases.
  writeFileSync(
    join(consumer, "private.ts"),
    "import '@routecraft/spike-plugin-architecture/private.js';\n",
  );
  if (
    !readFileSync(
      join(
        consumer,
        "node_modules/@routecraft/spike-plugin-architecture/private.js",
      ),
      "utf8",
    ).includes("secret")
  )
    throw Error("negative-control file absent");
  const probe = spawn([process.execPath, "private.ts"], {
    cwd: consumer,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await probe.exited) === 0)
    throw Error("private import unexpectedly resolved");
  console.log("PACKED: private package subpath refused PASS");
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
