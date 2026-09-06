/**
 * A profile is the mode: selecting one selects the environment that goes
 * with it.
 *
 * One concept rather than two overlapping ones, so the tests are about
 * which files a selection reads and in which order, and about the two
 * escapes from the cascade: a flag naming one file, and a profile naming
 * one file or carrying its values inline.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { loadEnvironment } = await import("../src/util.js");

/** Variables these cases write, restored after each one. */
const KEYS = ["RC_BASE", "RC_MODE", "RC_LOCAL", "RC_INLINE"] as const;

describe("environment selection", () => {
  const roots: string[] = [];
  const before = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of KEYS) {
      const original = before.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    before.clear();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** A project root holding the named env files. */
  function project(files: Record<string, string>): string {
    for (const key of KEYS) before.set(key, process.env[key]);
    for (const key of KEYS) delete process.env[key];
    const root = mkdtempSync(join(tmpdir(), "craft-env-"));
    roots.push(root);
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(root, name), contents, "utf8");
    }
    return root;
  }

  /**
   * @case With no profile the conventional pair is read, in order
   * @preconditions A project with .env and .env.local, the second redefining one value
   * @expectedResult Both are applied and the local file wins, which is the behaviour every existing invocation already has
   */
  test("the conventional pair still loads", () => {
    const root = project({
      ".env": "RC_BASE=base\nRC_LOCAL=from-env\n",
      ".env.local": "RC_LOCAL=from-local\n",
    });
    loadEnvironment({ defaultsFrom: root });
    expect(process.env["RC_BASE"]).toBe("base");
    expect(process.env["RC_LOCAL"]).toBe("from-local");
  });

  /**
   * @case A selected profile reads its own file between the pair
   * @preconditions .env, .env.ing and .env.local, each redefining the value before it
   * @expectedResult The profile's file overrides the base and is itself overridden by the local file, so one selection picks the instance and its environment together
   */
  test("a profile reads .env.<profile> between the pair", () => {
    const root = project({
      ".env": "RC_BASE=base\nRC_MODE=base\nRC_LOCAL=base\n",
      ".env.ing": "RC_MODE=ing\nRC_LOCAL=ing\n",
      ".env.local": "RC_LOCAL=local\n",
    });
    loadEnvironment({ profile: "ing", defaultsFrom: root });
    expect(process.env["RC_BASE"]).toBe("base");
    expect(process.env["RC_MODE"]).toBe("ing");
    expect(process.env["RC_LOCAL"]).toBe("local");
  });

  /**
   * @case A profile naming one file reads that file and not the cascade
   * @preconditions A profile whose env names a file, beside a .env the cascade would otherwise read
   * @expectedResult Only the named file is applied, because naming one is how somebody says they do not want the convention
   */
  test("a profile's env names one exact file", () => {
    const root = project({
      ".env": "RC_BASE=base\n",
      "ing.env": "RC_MODE=ing\n",
    });
    loadEnvironment({ profile: "ing", env: "ing.env", defaultsFrom: root });
    expect(process.env["RC_MODE"]).toBe("ing");
    expect(process.env["RC_BASE"]).toBeUndefined();
  });

  /**
   * @case A profile can carry values inline, for what does not deserve a file
   * @preconditions A profile whose env is a map, in a project that also has a .env
   * @expectedResult The inline values are applied and the cascade is not read, and a value the process already carries is left alone, matching how a .env file behaves
   */
  test("a profile's env can be an inline map", () => {
    const root = project({ ".env": "RC_BASE=base\n" });
    process.env["RC_INLINE"] = "already-set";
    loadEnvironment({
      profile: "ing",
      env: { RC_MODE: "inline", RC_INLINE: "from-profile" },
      defaultsFrom: root,
    });
    expect(process.env["RC_MODE"]).toBe("inline");
    expect(process.env["RC_INLINE"]).toBe("already-set");
    expect(process.env["RC_BASE"]).toBeUndefined();
  });

  /**
   * @case An explicit --env beats the profile and the cascade alike
   * @preconditions A project with a .env and a profile naming another file, with a third named by the flag
   * @expectedResult Only the flag's file is applied, because a path typed on the command line is the most specific thing anybody said
   */
  test("--env wins over the profile's own env", () => {
    const root = project({
      ".env": "RC_BASE=base\n",
      "profile.env": "RC_MODE=profile\n",
      "flag.env": "RC_MODE=flag\n",
    });
    loadEnvironment({
      explicit: join(root, "flag.env"),
      profile: "ing",
      env: "profile.env",
      defaultsFrom: root,
    });
    expect(process.env["RC_MODE"]).toBe("flag");
    expect(process.env["RC_BASE"]).toBeUndefined();
  });

  /**
   * @case A profile whose file does not exist is not an error
   * @preconditions A selected profile with no .env.<profile> beside the pair
   * @expectedResult The pair still loads, because a mode with nothing extra to say is an ordinary case rather than a misconfiguration
   */
  test("a missing .env.<profile> is not an error", () => {
    const root = project({ ".env": "RC_BASE=base\n" });
    loadEnvironment({ profile: "nothing-here", defaultsFrom: root });
    expect(process.env["RC_BASE"]).toBe("base");
  });
});
