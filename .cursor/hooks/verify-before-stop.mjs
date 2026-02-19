#!/usr/bin/env node
/**
 * Cursor stop hook: run full verification (lint, format check, typecheck, build, test).
 * If any step fails, sends a followup_message so the agent can fix and retry.
 */
import { spawnSync } from "node:child_process";

const cwd = process.env.CURSOR_PROJECT_DIR || process.cwd();
const steps = [
  ["pnpm", ["lint"]],
  ["pnpm", ["format"]],
  ["pnpm", ["typecheck"]],
  ["pnpm", ["build"]],
  ["pnpm", ["test"]],
];

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    stdio: "pipe",
    encoding: "utf8",
    shell: true,
    cwd,
  });
  return r.status;
}

function main() {
  for (const [cmd, args] of steps) {
    const code = run(cmd, args);
    if (code !== 0) {
      const msg =
        "Verification failed (lint, format, typecheck, build, or test). Please fix the reported errors and run: pnpm lint && pnpm format && pnpm typecheck && pnpm build && pnpm test.";
      process.stdout.write(JSON.stringify({ followup_message: msg }) + "\n");
      process.exit(0);
    }
  }
  process.stdout.write("{}\n");
}

main();
