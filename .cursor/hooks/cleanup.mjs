#!/usr/bin/env node
/**
 * Cursor sessionEnd hook: remove this session's state so we don't leak entries.
 * Matches by session_id (stored in state by track-edit when present) or TTL (24h).
 */
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const STATE_FILE = ".cursor/hooks/state/edits.json";
const TTL_MS = 24 * 60 * 60 * 1000;

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

function writeStateAtomic(cwd, state) {
  const p = path.resolve(cwd, STATE_FILE);
  const dir = path.dirname(p);
  const tmp = path.join(dir, `edits.cleanup.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 0), "utf8");
  fs.renameSync(tmp, p);
}

async function main() {
  let input = "";
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) input += line + "\n";
  let payload;
  try {
    payload = JSON.parse(input || "{}");
  } catch {
    process.exit(0);
  }

  const sessionId = payload.session_id;
  const conversationId = payload.conversation_id;

  const cwd = getCwd();
  const state = readState(cwd);
  const now = Date.now();

  // Remove entry matching this session (session_id or conversation_id)
  if (sessionId != null && typeof sessionId === "string") {
    for (const [cid, data] of Object.entries(state)) {
      if (data && data.session_id === sessionId) {
        delete state[cid];
        break;
      }
    }
  }
  if (conversationId != null && typeof conversationId === "string") {
    delete state[conversationId];
  }

  // TTL: drop entries older than 24h
  for (const [cid, data] of Object.entries(state)) {
    if (
      data &&
      typeof data.timestamp === "number" &&
      now - data.timestamp > TTL_MS
    ) {
      delete state[cid];
    }
  }

  if (Object.keys(state).length === 0) {
    const p = path.resolve(cwd, STATE_FILE);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } else {
    writeStateAtomic(cwd, state);
  }
}

main().catch(() => process.exit(0));
