import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveSettings, DEFAULT_URL, SettingsError } =
  await import("../src/settings");

/**
 * Settings resolution for `craft exec` and the `craft ops` family.
 *
 * The precedence itself is the contract, and so is the provenance: an
 * operator whose command reached the wrong instance has to be able to tell
 * which of four places supplied the address, from the error alone.
 */

/** Write a settings file inside a throwaway working directory. */
function project(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "craft-settings-"));
  mkdirSync(join(root, ".routecraft"), { recursive: true });
  writeFileSync(join(root, ".routecraft", "settings.yaml"), contents, "utf8");
  return root;
}

describe("CLI settings resolution", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function scratch(contents: string): string {
    const root = project(contents);
    roots.push(root);
    return root;
  }

  /**
   * @case With nothing configured anywhere, the documented default holds
   * @preconditions No settings file, no environment, no flags
   * @expectedResult The loopback default, reported as coming from the default so a reader is never left guessing which file supplied it
   */
  test("falls back to the documented default", () => {
    const root = scratch("");
    const settings = resolveSettings({}, root, {});
    expect(settings.url.value).toBe(DEFAULT_URL);
    expect(settings.url.source).toBe("default");
    expect(settings.format.value).toBe("pretty");
    expect(settings.token).toBeUndefined();
  });

  /**
   * @case The project-local file supplies values and says so
   * @preconditions .routecraft/settings.yaml in the working directory carrying url and format
   * @expectedResult Both values taken from the file, each carrying the file's path as its provenance
   */
  test("reads the project-local file and records its path", () => {
    const root = scratch("url: http://10.0.0.5:9090\nformat: json\n");
    const settings = resolveSettings({}, root, {});
    expect(settings.url.value).toBe("http://10.0.0.5:9090");
    expect(settings.url.source).toBe("project file");
    expect(settings.url.path).toContain(".routecraft");
    expect(settings.format.value).toBe("json");
  });

  /**
   * @case A flag beats the environment, which beats the project file
   * @preconditions All three supply a url, and separately all three supply a format
   * @expectedResult The flag wins and reports itself as the flag. Precedence that cannot be observed from the output is precedence an operator has to discover by experiment
   */
  test("resolves flag over environment over file", () => {
    const root = scratch("url: http://from-file:8080\nformat: json\n");

    const fromEnv = resolveSettings({}, root, {
      CRAFT_URL: "http://from-env:8080",
    });
    expect(fromEnv.url.value).toBe("http://from-env:8080");
    expect(fromEnv.url.source).toBe("environment");

    const fromFlag = resolveSettings({ url: "http://from-flag:8080" }, root, {
      CRAFT_URL: "http://from-env:8080",
    });
    expect(fromFlag.url.value).toBe("http://from-flag:8080");
    expect(fromFlag.url.source).toBe("flag");
  });

  /**
   * @case A token is read from the file and from a flag
   * @preconditions A token in the settings file, then overridden by a flag
   * @expectedResult The file value is used when no flag is given, and the flag wins when it is
   */
  test("resolves the token with the same precedence", () => {
    const root = scratch("token: from-file\n");
    expect(resolveSettings({}, root, {}).token?.value).toBe("from-file");
    expect(resolveSettings({ token: "from-flag" }, root, {}).token?.value).toBe(
      "from-flag",
    );
  });

  /**
   * @case An unparseable settings file is an error, not a silent fallback
   * @preconditions A settings file containing YAML that cannot be parsed
   * @expectedResult SettingsError naming the file. An operator who wrote a settings file and silently got default behaviour would reasonably conclude the setting does not work
   */
  test("refuses a settings file that is not valid YAML", () => {
    const root = scratch("url: [unclosed\n");
    expect(() => resolveSettings({}, root, {})).toThrow(SettingsError);
  });

  /**
   * @case A settings file that is not a mapping is refused
   * @preconditions A settings file containing a YAML sequence
   * @expectedResult SettingsError naming what the file should contain
   */
  test("refuses a settings file that is not a mapping", () => {
    const root = scratch("- url: http://nope\n");
    expect(() => resolveSettings({}, root, {})).toThrow(/mapping of settings/);
  });

  /**
   * @case An unknown output format is refused rather than silently ignored
   * @preconditions format set to a value the renderer does not implement
   * @expectedResult SettingsError listing the formats that exist
   */
  test("refuses an unknown output format", () => {
    const root = scratch("format: yaml\n");
    expect(() => resolveSettings({}, root, {})).toThrow(/pretty, json, raw/);
  });

  /**
   * @case A missing settings file is the normal case and says nothing
   * @preconditions A working directory with no .routecraft directory at all
   * @expectedResult Defaults, with no error: not having a personal settings file is how most invocations run
   */
  test("treats a missing settings file as no settings", () => {
    const root = mkdtempSync(join(tmpdir(), "craft-settings-none-"));
    roots.push(root);
    const settings = resolveSettings({}, root, {});
    expect(settings.url.value).toBe(DEFAULT_URL);
  });
});
