import { describe, test, expect } from "vitest";
import { checkBunRuntime } from "../src/runtime-gate";

describe("checkBunRuntime", () => {
  /**
   * @case Runtime is Node, not Bun
   * @preconditions process.versions.bun is undefined
   * @expectedResult Returns ok: false with a message that flags Bun is required and points at the embedding doc
   */
  test("rejects when bun is not the runtime", () => {
    const result = checkBunRuntime(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("requires Bun");
      expect(result.message).toContain("https://bun.com/docs/installation");
      expect(result.message).toContain("programmatic-invocation");
    }
  });

  /**
   * @case Bun version is below the supported floor
   * @preconditions process.versions.bun is "1.0.0", below the 1.1.0 floor
   * @expectedResult Returns ok: false with a message naming the actual version, the floor, and the install URL
   */
  test("rejects below the version floor", () => {
    const result = checkBunRuntime("1.0.0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("1.0.0");
      expect(result.message).toContain("1.1.0");
      expect(result.message).toContain("https://bun.com/docs/installation");
    }
  });

  /**
   * @case Bun version is exactly at the supported floor
   * @preconditions process.versions.bun is "1.1.0"
   * @expectedResult Returns ok: true
   */
  test("accepts exactly at the floor", () => {
    expect(checkBunRuntime("1.1.0")).toEqual({ ok: true });
  });

  /**
   * @case Bun version is above the supported floor
   * @preconditions process.versions.bun is "1.3.9"
   * @expectedResult Returns ok: true
   */
  test("accepts above the floor", () => {
    expect(checkBunRuntime("1.3.9")).toEqual({ ok: true });
  });

  /**
   * @case Bun version has a prerelease suffix above the floor
   * @preconditions process.versions.bun is "1.3.9-canary.1"
   * @expectedResult Returns ok: true; the prerelease tag is stripped before semver comparison
   */
  test("accepts prerelease versions above the floor", () => {
    expect(checkBunRuntime("1.3.9-canary.1")).toEqual({ ok: true });
  });

  /**
   * @case Bun reports a version string that is not parseable as semver
   * @preconditions process.versions.bun is "not-a-version"
   * @expectedResult Returns ok: false with a "could not parse" message that still points at the install URL
   */
  test("rejects unparseable version strings", () => {
    const result = checkBunRuntime("not-a-version");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Could not parse");
      expect(result.message).toContain("https://bun.com/docs/installation");
    }
  });
});
