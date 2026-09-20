import { spawn } from "bun";
import { test, expect } from "bun:test";
/**
 * @case external consumer
 * @preconditions pack installed in fresh directory
 * @expectedResult strict typecheck, public execution and private-import refusal */
test("independently compiled plugin consumes only the packed artifact", async () => {
  const proc = spawn(
    [
      process.execPath,
      new URL("../../validation/round-two/packed.ts", import.meta.url).pathname,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("actual resume PASS");
  expect(stdout).toContain("private package subpath refused PASS");
}, 30000);
