#!/usr/bin/env node
/**
 * Cursor afterFileEdit hook: record conversation_id and file_path to state.
 * Does no expensive work. State used by stop-check to run lint/test only when edits occurred.
 */
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const STATE_DIR = ".cursor/hooks/state";
const STATE_FILE = path.join(STATE_DIR, "edits.json");
const LOCK_FILE = path.join(STATE_DIR, "edits.lock");
const LOCK_RETRIES = 10;
const LOCK_WAIT_MS = 50;

function getCwd() {
  return process.env.CURSOR_PROJECT_DIR || process.cwd();
}

function acquireLock() {
  const cwd = getCwd();
  const lockPath = path.resolve(cwd, LOCK_FILE);
  const stateDir = path.dirname(lockPath);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      fs.writeFileSync(lockPath, process.pid.toString(), { flag: "wx" });
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const deadline = Date.now() + LOCK_WAIT_MS;
      while (Date.now() < deadline) {
        /* busy wait */
      }
    }
  }
  return null;
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
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `edits.${process.pid}.${Date.now()}.tmp`);
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
  const conversationId = payload.conversation_id;
  const filePath = payload.file_path;
  const sessionId = payload.session_id;
  if (!conversationId || typeof conversationId !== "string") process.exit(0);
  if (!filePath || typeof filePath !== "string") process.exit(0);
  if (filePath.includes("\0")) process.exit(0);

  const cwd = getCwd();
  const release = acquireLock();
  if (!release) process.exit(0);
  try {
    const state = readState(cwd);
    const existing = state[conversationId] || { files: [], timestamp: 0 };
    const files = Array.isArray(existing.files) ? [...existing.files] : [];
    if (!files.includes(filePath)) files.push(filePath);
    state[conversationId] = {
      files,
      timestamp: Date.now(),
      ...(sessionId != null && { session_id: String(sessionId) }),
    };
    writeStateAtomic(cwd, state);
  } finally {
    release();
  }
}

main().catch(() => process.exit(0));
