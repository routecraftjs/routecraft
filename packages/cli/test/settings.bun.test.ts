import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
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

/**
 * An empty home, pinned into every resolution below.
 *
 * `resolveSettings` reads two files, and pinning only `cwd` isolates one of
 * them. A developer keeping their own `~/.routecraft/settings.yaml` would
 * otherwise decide what the cases about defaults resolve to, which is the
 * same machine-dependent failure the project file was isolated against.
 */
let home: string;

describe("CLI settings resolution", () => {
  const roots: string[] = [];

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "craft-settings-home-"));
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

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
    const settings = resolveSettings({ home, cwd: root, env: {} });
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
    const settings = resolveSettings({ home, cwd: root, env: {} });
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

    const fromEnv = resolveSettings({
      home,
      cwd: root,
      env: { CRAFT_URL: "http://from-env:8080" },
    });
    expect(fromEnv.url.value).toBe("http://from-env:8080");
    expect(fromEnv.url.source).toBe("environment");

    const fromFlag = resolveSettings({
      url: "http://from-flag:8080",
      home,
      cwd: root,
      env: { CRAFT_URL: "http://from-env:8080" },
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
    expect(resolveSettings({ home, cwd: root, env: {} }).token?.value).toBe(
      "from-file",
    );
    expect(
      resolveSettings({ token: "from-flag", home, cwd: root, env: {} }).token
        ?.value,
    ).toBe("from-flag");
  });

  /**
   * @case An unparseable settings file is an error, not a silent fallback
   * @preconditions A settings file containing YAML that cannot be parsed
   * @expectedResult SettingsError naming the file. An operator who wrote a settings file and silently got default behaviour would reasonably conclude the setting does not work
   */
  test("refuses a settings file that is not valid YAML", () => {
    const root = scratch("url: [unclosed\n");
    expect(() => resolveSettings({ home, cwd: root, env: {} })).toThrow(
      SettingsError,
    );
  });

  /**
   * @case A settings file that is not a mapping is refused
   * @preconditions A settings file containing a YAML sequence
   * @expectedResult SettingsError naming what the file should contain
   */
  test("refuses a settings file that is not a mapping", () => {
    const root = scratch("- url: http://nope\n");
    expect(() => resolveSettings({ home, cwd: root, env: {} })).toThrow(
      /mapping of settings/,
    );
  });

  /**
   * @case An unknown output format is refused rather than silently ignored
   * @preconditions format set to a value the renderer does not implement
   * @expectedResult SettingsError listing the formats that exist
   */
  test("refuses an unknown output format", () => {
    const root = scratch("format: yaml\n");
    expect(() => resolveSettings({ home, cwd: root, env: {} })).toThrow(
      /pretty, json, raw/,
    );
  });

  /**
   * @case A settings file that exists but cannot be read is an error
   * @preconditions .routecraft/settings.yaml created as a directory, so reading it fails with EISDIR rather than ENOENT
   * @expectedResult SettingsError naming the path. Only "it is not there" means no settings; anything else would hand back defaults to an operator who did configure something
   */
  test("refuses a settings file that exists but cannot be read", () => {
    const root = mkdtempSync(join(tmpdir(), "craft-settings-unreadable-"));
    roots.push(root);
    mkdirSync(join(root, ".routecraft", "settings.yaml"), { recursive: true });
    expect(() => resolveSettings({ home, cwd: root, env: {} })).toThrow(
      /could not be read/,
    );
  });

  /**
   * @case A URL that is not a URL is refused as configuration, not as a down instance
   * @preconditions A settings file whose url is not parseable
   * @expectedResult SettingsError naming the source. Letting it reach `fetch` would report the instance as unreachable, sending the reader to look at a server that is fine
   */
  test("refuses a url that cannot be parsed", () => {
    const root = scratch("url: not-a-url\n");
    expect(() => resolveSettings({ home, cwd: root, env: {} })).toThrow(
      /is not a URL/,
    );
  });

  /**
   * @case A URL on a scheme the client does not speak is refused
   * @preconditions A settings file pointing at a file: URL
   * @expectedResult SettingsError naming the scheme, since the ops server is reached over http or https and nothing else
   */
  test("refuses a url whose scheme is not http or https", () => {
    const root = scratch("url: file:///etc/passwd\n");
    expect(() => resolveSettings({ home, cwd: root, env: {} })).toThrow(
      /http or https/,
    );
  });

  /**
   * @case An empty environment variable is not a credential
   * @preconditions CRAFT_TOKEN exported empty, as an unset variable in a shell profile leaves it, with a token in the project file
   * @expectedResult The file's token wins. Read as present, the empty value makes the client present a bearer with nothing after it, and the operator is told their credential was rejected when they never supplied one
   */
  test("ignores a blank environment value", () => {
    const root = scratch("token: from_file\n");

    const settings = resolveSettings({
      home,
      cwd: root,
      env: { CRAFT_TOKEN: "" },
    });

    expect(settings.token?.value).toBe("from_file");
    expect(settings.token?.source).toBe("project file");
  });

  /**
   * @case An empty flag is not a value either
   * @preconditions --token and --url given as empty strings, which is what `--token "$UNSET"` expands to
   * @expectedResult Both fall through: no credential at all, and the default address rather than an empty one
   */
  test("ignores a blank flag", () => {
    const root = mkdtempSync(join(tmpdir(), "craft-settings-blank-"));
    roots.push(root);

    const settings = resolveSettings({
      home,
      cwd: root,
      env: {},
      token: "",
      url: "   ",
    });

    expect(settings.token).toBeUndefined();
    expect(settings.url.value).toBe(DEFAULT_URL);
    expect(settings.url.source).toBe("default");
  });

  /**
   * @case A blank value written into a file is still an error
   * @preconditions A settings file carrying `url:` with nothing after it
   * @expectedResult SettingsError. Somebody typed it and left it, so quietly using the default would hide the mistake rather than explain it, which is the opposite of what the blank-flag rule is for
   */
  test("still refuses a blank url in a settings file", () => {
    const root = scratch("url: ''\n");

    expect(() => resolveSettings({ home, cwd: root, env: {} })).toThrow(
      SettingsError,
    );
  });

  /**
   * @case A blank token written into a file is refused, not presented
   * @preconditions A settings file carrying an empty token string
   * @expectedResult SettingsError. It is the one source a blank can only reach by hand, and presenting it makes the client send a bearer with nothing after it, which is the misdiagnosis this whole rule exists to remove
   */
  test("refuses a blank token in a settings file", () => {
    const root = scratch('token: ""\n');

    expect(() => resolveSettings({ home, cwd: root, env: {} })).toThrow(
      SettingsError,
    );
  });

  /**
   * @case A missing settings file is the normal case and says nothing
   * @preconditions A working directory with no .routecraft directory at all
   * @expectedResult Defaults, with no error: not having a personal settings file is how most invocations run
   */
  test("treats a missing settings file as no settings", () => {
    const root = mkdtempSync(join(tmpdir(), "craft-settings-none-"));
    roots.push(root);
    const settings = resolveSettings({ home, cwd: root, env: {} });
    expect(settings.url.value).toBe(DEFAULT_URL);
  });
});
