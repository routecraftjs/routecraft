/**
 * Profiles: one selection that picks the instance, the credential, the
 * output format, the agent and the environment together.
 *
 * The chain is the contract and so is the provenance. Every case here
 * asserts the source as well as the value, because the one question a
 * command that reached the wrong instance has to answer is who told it
 * that address.
 */

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

/** A throwaway directory holding one settings file. */
function scratchIn(contents: string | undefined, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  if (contents !== undefined) {
    mkdirSync(join(root, ".routecraft"), { recursive: true });
    writeFileSync(join(root, ".routecraft", "settings.yaml"), contents, "utf8");
  }
  return root;
}

describe("settings profiles", () => {
  const roots: string[] = [];
  let emptyHome: string;

  beforeAll(() => {
    emptyHome = mkdtempSync(join(tmpdir(), "craft-profiles-home-"));
  });

  afterAll(() => {
    rmSync(emptyHome, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function project(contents: string): string {
    const root = scratchIn(contents, "craft-profiles-");
    roots.push(root);
    return root;
  }

  function home(contents: string): string {
    const root = scratchIn(contents, "craft-profiles-home-");
    roots.push(root);
    return root;
  }

  /**
   * @case A selected profile supplies every value it carries
   * @preconditions A project file with two profiles and `profile:` naming one
   * @expectedResult The url, token, format and agent all come from that profile, each reported as coming from the project profile rather than from the file's top level
   */
  test("a selected profile supplies its values", () => {
    const cwd = project(`
profile: company
profiles:
  local:
    url: http://127.0.0.1:9999
  company:
    url: https://eywa.example
    token: company-token
    format: json
    agent: zoe
`);
    const settings = resolveSettings({ cwd, home: emptyHome, env: {} });
    expect(settings.url).toMatchObject({
      value: "https://eywa.example",
      source: "project profile",
    });
    expect(settings.token?.value).toBe("company-token");
    expect(settings.format.value).toBe("json");
    expect(settings.agent).toMatchObject({
      value: "zoe",
      source: "project profile",
    });
    expect(settings.profile).toMatchObject({
      value: "company",
      source: "project file",
    });
  });

  /**
   * @case Inside one file a profile beats a bare key
   * @preconditions A project file carrying both a top-level url and a selected profile with its own
   * @expectedResult The profile's url wins, because it is the more specific thing the person asked for
   */
  test("a profile beats its own file's top level", () => {
    const cwd = project(`
profile: company
url: http://127.0.0.1:1111
profiles:
  company:
    url: https://eywa.example
`);
    expect(
      resolveSettings({ cwd, home: emptyHome, env: {} }).url,
    ).toMatchObject({
      value: "https://eywa.example",
      source: "project profile",
    });
  });

  /**
   * @case A profile in a home directory cannot redirect an instance a repository pinned
   * @preconditions A project file with a top-level url, and a home file whose selected profile names another
   * @expectedResult The project's top-level url wins over the global file's profile, which is the rule the settings file has always documented and the one a per-file layering could quietly invert
   */
  test("a project top-level key beats a global profile", () => {
    const cwd = project(`url: http://127.0.0.1:1111`);
    const homeRoot = home(`
profile: company
profiles:
  company:
    url: https://somebody-elses.example
`);
    expect(resolveSettings({ cwd, home: homeRoot, env: {} }).url).toMatchObject(
      {
        value: "http://127.0.0.1:1111",
        source: "project file",
      },
    );
  });

  /**
   * @case A global profile still supplies what the project names nowhere
   * @preconditions The same pair, reading the token the project file does not carry
   * @expectedResult The token comes from the global profile, so the home directory is still useful for the values a repository has no opinion about
   */
  test("a global profile fills in what the project omits", () => {
    const cwd = project(`url: http://127.0.0.1:1111`);
    const homeRoot = home(`
profile: company
profiles:
  company:
    url: https://somebody-elses.example
    token: from-home
`);
    expect(
      resolveSettings({ cwd, home: homeRoot, env: {} }).token,
    ).toMatchObject({ value: "from-home", source: "global profile" });
  });

  /**
   * @case An environment variable wins over every file, profile or not
   * @preconditions A selected profile naming a url, with CRAFT_URL exported
   * @expectedResult The environment wins, because what somebody changes on a server is what has to win
   */
  test("the environment beats a profile", () => {
    const cwd = project(`
profile: company
profiles:
  company:
    url: https://eywa.example
`);
    expect(
      resolveSettings({
        cwd,
        home: emptyHome,
        env: { CRAFT_URL: "http://10.0.0.5:8080" },
      }).url,
    ).toMatchObject({ value: "http://10.0.0.5:8080", source: "environment" });
  });

  /**
   * @case A flag selects a profile above every other way of choosing one
   * @preconditions A file selecting one profile, with a flag naming the other
   * @expectedResult The flag's profile is used and reported as chosen by the flag
   */
  test("--profile beats the file's own selection", () => {
    const cwd = project(`
profile: company
profiles:
  local:
    url: http://127.0.0.1:9999
  company:
    url: https://eywa.example
`);
    const settings = resolveSettings({
      cwd,
      home: emptyHome,
      env: {},
      profile: "local",
    });
    expect(settings.profile).toMatchObject({ value: "local", source: "flag" });
    expect(settings.url.value).toBe("http://127.0.0.1:9999");
  });

  /**
   * @case CRAFT_PROFILE selects a profile when no flag does
   * @preconditions A file defining two profiles and selecting neither
   * @expectedResult The environment's choice holds and is reported as such
   */
  test("CRAFT_PROFILE selects a profile", () => {
    const cwd = project(`
profiles:
  local:
    url: http://127.0.0.1:9999
  company:
    url: https://eywa.example
`);
    const settings = resolveSettings({
      cwd,
      home: emptyHome,
      env: { CRAFT_PROFILE: "company" },
    });
    expect(settings.profile).toMatchObject({
      value: "company",
      source: "environment",
    });
    expect(settings.url.value).toBe("https://eywa.example");
  });

  /**
   * @case A profile named by a flag that exists nowhere is refused, naming what does exist
   * @preconditions Two defined profiles and a flag naming a third
   * @expectedResult A settings error naming the profiles that are defined, rather than a silent fall back to the loopback default
   */
  test("a missing profile named by the flag is refused", () => {
    const cwd = project(`
profiles:
  local:
    url: http://127.0.0.1:9999
  company:
    url: https://eywa.example
`);
    expect(() =>
      resolveSettings({ cwd, home: emptyHome, env: {}, profile: "staging" }),
    ).toThrow(SettingsError);
    try {
      resolveSettings({ cwd, home: emptyHome, env: {}, profile: "staging" });
    } catch (error: unknown) {
      expect((error as Error).message).toContain('No profile "staging"');
      expect((error as Error).message).toContain("company, local");
    }
  });

  /**
   * @case A file selecting a profile it does not define is refused the same way
   * @preconditions A project file whose `profile:` names nothing in its own map
   * @expectedResult The same refusal, naming the file that chose it, so the fix is findable without guessing which of two files is wrong
   */
  test("a missing profile named by a file is refused", () => {
    const cwd = project(`
profile: staging
profiles:
  local:
    url: http://127.0.0.1:9999
`);
    try {
      resolveSettings({ cwd, home: emptyHome, env: {} });
      throw new Error("expected a refusal");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SettingsError);
      expect((error as Error).message).toContain('No profile "staging"');
      expect((error as Error).message).toContain("settings.yaml");
    }
  });

  /**
   * @case A profile defined only in the home file is selectable from a project
   * @preconditions A home file defining a profile, selected by flag from a project that defines none
   * @expectedResult It resolves, because the two files' profile maps are one namespace as far as selection is concerned
   */
  test("a profile defined in the home file is selectable", () => {
    const cwd = project(`url: http://127.0.0.1:1111`);
    const homeRoot = home(`
profiles:
  company:
    token: from-home
`);
    const settings = resolveSettings({
      cwd,
      home: homeRoot,
      env: {},
      profile: "company",
    });
    expect(settings.token?.value).toBe("from-home");
    // And the project's own pinned url still holds, because nothing in the
    // selected profile named one.
    expect(settings.url.value).toBe("http://127.0.0.1:1111");
  });

  /**
   * @case Nothing selected leaves every value exactly where it was
   * @preconditions A file defining profiles but selecting none
   * @expectedResult The top-level keys resolve as they always did and no profile is reported, so profiles cost nothing to somebody who does not use them
   */
  test("defining profiles changes nothing until one is selected", () => {
    const cwd = project(`
url: http://127.0.0.1:1111
profiles:
  company:
    url: https://eywa.example
`);
    const settings = resolveSettings({ cwd, home: emptyHome, env: {} });
    expect(settings.profile).toBeUndefined();
    expect(settings.url).toMatchObject({
      value: "http://127.0.0.1:1111",
      source: "project file",
    });
    expect(settings.agent).toBeUndefined();
  });

  /**
   * @case A profile's env is reported as a path or as an inline map
   * @preconditions Two profiles, one naming a file and one carrying values inline
   * @expectedResult Each resolves to what it wrote, so the command that loads the environment can tell the two apart without re-reading the file
   */
  test("a profile's env resolves as a path or a map", () => {
    const cwd = project(`
profiles:
  filed:
    env: .env.ing
  inline:
    env:
      REGION: eu-west-1
`);
    expect(
      resolveSettings({ cwd, home: emptyHome, env: {}, profile: "filed" }).env,
    ).toMatchObject({ value: ".env.ing", source: "project profile" });
    expect(
      resolveSettings({ cwd, home: emptyHome, env: {}, profile: "inline" })?.env
        ?.value,
    ).toEqual({ REGION: "eu-west-1" });
  });

  /**
   * @case An env that is neither a path nor a map of strings is refused
   * @preconditions A profile whose env is a list
   * @expectedResult A settings error naming the file, because a value the loader cannot act on would otherwise be ignored in silence
   */
  test("a malformed env is refused", () => {
    const cwd = project(`
profiles:
  broken:
    env:
      - .env.one
      - .env.two
`);
    expect(() =>
      resolveSettings({ cwd, home: emptyHome, env: {}, profile: "broken" }),
    ).toThrow(/must be a path to an env file or a map/);
  });

  /**
   * @case With no settings anywhere the documented default still holds
   * @preconditions No files, no environment, no flags
   * @expectedResult The loopback default, and nothing about profiles in the answer
   */
  test("no settings at all still resolves the default", () => {
    const cwd = scratchIn(undefined, "craft-profiles-bare-");
    roots.push(cwd);
    const settings = resolveSettings({ cwd, home: emptyHome, env: {} });
    expect(settings.url).toMatchObject({
      value: DEFAULT_URL,
      source: "default",
    });
    expect(settings.profile).toBeUndefined();
    expect(settings.env).toBeUndefined();
  });

  /**
   * @case A profiles key that is not a map of maps is refused rather than resolved to the defaults
   * @preconditions Two files, one whose `profiles` is a scalar and one whose named profile is a scalar
   * @expectedResult Both are refused. Every other key in this file is shape-checked, and an unchecked one resolves to the loopback default while looking like it was honoured, which is the silence the file exists to prevent
   */
  test("a malformed profiles map is refused", () => {
    const scalarMap = project(`profile: local\nprofiles: local\n`);
    expect(() =>
      resolveSettings({ cwd: scalarMap, home: emptyHome, env: {} }),
    ).toThrow(/must be a map of profile names/);

    const scalarEntry = project(
      `profile: local\nprofiles:\n  local: http://127.0.0.1:9999\n`,
    );
    expect(() =>
      resolveSettings({ cwd: scalarEntry, home: emptyHome, env: {} }),
    ).toThrow(/must be a map of settings/);
  });

  /**
   * @case An env that is an empty string is refused rather than resolving to the project directory
   * @preconditions A selected profile whose env is the empty string
   * @expectedResult A settings error, because the command would otherwise run on without the environment the person selected and nothing would say so
   */
  test("an empty env is refused", () => {
    const cwd = project(`
profiles:
  blank:
    env: ""
`);
    expect(() =>
      resolveSettings({ cwd, home: emptyHome, env: {}, profile: "blank" }),
    ).toThrow(/must be a path to an env file or a map/);
  });
});
