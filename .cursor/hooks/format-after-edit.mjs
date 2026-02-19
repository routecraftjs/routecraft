#!/usr/bin/env node
/**
 * Cursor afterFileEdit hook: run Prettier on the edited file.
 * Receives JSON with file_path; only formats known file types.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

const PRETTIER_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|md|css|html)$/i;

async function main() {
  const rl = createInterface({ input: process.stdin });
  let input = "";
  for await (const line of rl) input += line + "\n";
  const payload = JSON.parse(input || "{}");
  const filePath = payload.file_path;
  if (!filePath || typeof filePath !== "string") process.exit(0);
  if (filePath.includes("\0")) process.exit(0);
  if (!PRETTIER_EXT.test(filePath)) process.exit(0);
  const cwd = process.env.CURSOR_PROJECT_DIR || process.cwd();
  const resolved = path.resolve(cwd, filePath);
  const rel = path.relative(cwd, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) process.exit(0);
  const r = spawnSync(
    "pnpm",
    ["exec", "prettier", "--write", "--ignore-unknown", resolved],
    {
      stdio: "inherit",
      cwd,
    },
  );
  process.exit(r.status === 0 ? 0 : 0); // always exit 0 so we don't block the edit
}

main().catch(() => process.exit(0));
