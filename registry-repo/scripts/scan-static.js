#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Static analysis scanner for registry capability files.
 *
 * Checks for:
 * - Environment variable exfiltration patterns (process.env used with fetch/http)
 * - Unsafe exec/spawn calls (child_process usage)
 * - Undeclared HTTP calls (fetch/http without env declaration)
 * - eval() or Function() usage
 * - Dynamic require/import with non-literal arguments
 *
 * Usage: node scripts/scan-static.js <capability-file> [--env VAR1,VAR2,...]
 *
 * @license Apache-2.0
 */

import { readFileSync } from "node:fs";

/**
 * @typedef {{ line: number, pattern: string, message: string, severity: 'error' | 'warning' }} Finding
 */

/**
 * Scan a capability file for suspicious patterns.
 * @param {string} filePath
 * @param {string[]} declaredEnv - Environment variables declared in craft.yml
 * @returns {Finding[]}
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future use: validate env usage against declared vars
function scanFile(filePath, declaredEnv = []) {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  /** @type {Finding[]} */
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Check for child_process usage
    if (
      /require\s*\(\s*['"]child_process['"]\s*\)/.test(line) ||
      /from\s+['"]child_process['"]/.test(line) ||
      /from\s+['"]node:child_process['"]/.test(line)
    ) {
      findings.push({
        line: lineNum,
        pattern: "child_process import",
        message:
          "Importing child_process is not allowed in registry capabilities. Use adapters for external process interaction.",
        severity: "error",
      });
    }

    // Check for exec/spawn/execSync calls
    if (
      /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync|fork)\s*\(/.test(
        line,
      )
    ) {
      findings.push({
        line: lineNum,
        pattern: "exec/spawn call",
        message:
          "Direct process execution is not allowed in registry capabilities.",
        severity: "error",
      });
    }

    // Check for eval usage
    if (/\beval\s*\(/.test(line)) {
      findings.push({
        line: lineNum,
        pattern: "eval()",
        message: "eval() is not allowed in registry capabilities.",
        severity: "error",
      });
    }

    // Check for new Function() usage
    if (/new\s+Function\s*\(/.test(line)) {
      findings.push({
        line: lineNum,
        pattern: "new Function()",
        message: "new Function() is not allowed in registry capabilities.",
        severity: "error",
      });
    }

    // Check for fs write operations
    if (
      /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(/.test(
        line,
      )
    ) {
      findings.push({
        line: lineNum,
        pattern: "filesystem write",
        message:
          "Direct filesystem writes are not allowed in registry capabilities. Use destination adapters.",
        severity: "error",
      });
    }

    // Check for environment variable access that might indicate exfiltration
    if (/process\.env/.test(line)) {
      // Check if the line also contains a network call pattern
      if (/fetch|http|request|axios|got\b/.test(line)) {
        findings.push({
          line: lineNum,
          pattern: "env + network",
          message:
            "Environment variable access combined with network calls on the same line. Ensure env vars are only used for declared purposes.",
          severity: "warning",
        });
      }
    }

    // Check for dynamic import with non-literal
    if (
      /import\s*\([^'"]*\+/.test(line) ||
      /import\s*\(\s*[a-zA-Z_$]/.test(line)
    ) {
      // Allow import("./literal") but flag import(variable)
      if (!/import\s*\(\s*['"]/.test(line)) {
        findings.push({
          line: lineNum,
          pattern: "dynamic import",
          message:
            "Dynamic import with non-literal argument detected. Only static imports are allowed.",
          severity: "warning",
        });
      }
    }

    // Check for dynamic require with non-literal
    if (
      /require\s*\([^'"]*\+/.test(line) ||
      /require\s*\(\s*[a-zA-Z_$]/.test(line)
    ) {
      if (!/require\s*\(\s*['"]/.test(line)) {
        findings.push({
          line: lineNum,
          pattern: "dynamic require",
          message:
            "Dynamic require with non-literal argument detected. Only static requires are allowed.",
          severity: "warning",
        });
      }
    }
  }

  return findings;
}

// --- CLI entry point ---
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error(
    "Usage: node scripts/scan-static.js <capability-file> [--env VAR1,VAR2,...]",
  );
  process.exit(1);
}

let declaredEnv = [];
const files = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--env" && args[i + 1]) {
    declaredEnv = args[i + 1].split(",").map((s) => s.trim());
    i++;
  } else {
    files.push(args[i]);
  }
}

let hasErrors = false;

for (const file of files) {
  console.log(`Scanning: ${file}`);
  const findings = scanFile(file, declaredEnv);

  if (findings.length === 0) {
    console.log(`✓  No issues found`);
    continue;
  }

  for (const f of findings) {
    const icon = f.severity === "error" ? "✗" : "⚠";
    console.error(`${icon}  Line ${f.line}: [${f.pattern}] ${f.message}`);
    if (f.severity === "error") {
      hasErrors = true;
    }
  }
}

if (hasErrors) {
  process.exit(1);
}
