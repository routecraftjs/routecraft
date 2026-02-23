#!/usr/bin/env node
/**
 * Cursor stop hook: run lint/test only when this conversation recorded file edits.
 * Ask/plan-mode agents (no edits) are skipped. Uses shared state from track-edit.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

// Configurable per project (same as previous verify-before-stop)
const VERIFY_STEPS = [
  ["pnpm", ["lint"]],
  ["pnpm", ["format"]],
  ["pnpm", ["typecheck"]],
  ["pnpm", ["build"]],
  ["pnpm", ["test"]],
];

const STATE_FILE = ".cursor/hooks/state/edits.json";
const MAX_LOOP_COUNT = 4;
const FOLLOWUP_TRUNCATE = 3000;

function getCwd() {
  return process.env.CURSOR_PROJECT_DIR || process.cwd();
}

function readState(cwd) {
  const p = path.resolve(cwd, STATE_FILE);
  if (!fs.existsSync(p)) return {};
  try {
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") return data;
  } catch {
    /* ignore */
  }
  return {};
}

function runStep(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    stdio: "pipe",
    encoding: "utf8",
    shell: true,
    cwd,
  });
  const out = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();
  const combined = [out, err].filter(Boolean).join("\n");
  return { status: r.status, combined };
}

async function main() {
  let input = "";
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) input += line + "\n";
  let payload;
  try {
    payload = JSON.parse(input || "{}");
  } catch {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  const conversationId = payload.conversation_id;
  const loopCount = payload.loop_count;

  const cwd = getCwd();
  const state = readState(cwd);
  const entry = conversationId ? state[conversationId] : null;
  const hasEdits =
    entry && Array.isArray(entry.files) && entry.files.length > 0;

  if (!hasEdits) {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  if (typeof loopCount === "number" && loopCount >= MAX_LOOP_COUNT) {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  for (const [cmd, args] of VERIFY_STEPS) {
    const { status, combined } = runStep(cmd, args, cwd);
    if (status !== 0) {
      const prefix = `The following verification failed after your changes. Fix the errors before completing:\n\n`;
      let body = combined || `Command failed: ${cmd} ${args.join(" ")}`;
      if (body.length > FOLLOWUP_TRUNCATE) {
        body = body.slice(0, FOLLOWUP_TRUNCATE) + "\n\n... (output truncated)";
      }
      const msg = prefix + body;
      process.stdout.write(JSON.stringify({ followup_message: msg }) + "\n");
      process.exit(0);
    }
  }

  process.stdout.write("{}\n");
}

main().catch(() => {
  process.stdout.write("{}\n");
  process.exit(0);
});
