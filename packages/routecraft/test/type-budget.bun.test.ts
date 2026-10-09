import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures", "type-budget");
const ROOT = join(import.meta.dir, "..", "..", "..");

interface TscRun {
  readonly output: string;
  readonly instantiations: number;
  readonly checkSeconds: number;
}

/** Type-check one fixture project with diagnostics and read its cost. */
async function tsc(config: string): Promise<TscRun> {
  const output = await new Promise<string>((settle, fail) => {
    const proc = spawn(
      "bunx",
      ["tsc", "-p", join(FIXTURE, config), "--noEmit", "--extendedDiagnostics"],
      { cwd: ROOT },
    );
    let text = "";
    proc.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (text += chunk.toString()));
    proc.on("error", fail);
    // A fixture with type errors exits non-zero; the output is the result.
    proc.on("close", () => settle(text));
  });
  const number = (label: string): number =>
    Number(output.match(new RegExp(`${label}:\\s+([\\d.]+)`))?.[1] ?? NaN);
  return {
    output,
    instantiations: number("Instantiations"),
    checkSeconds: number("Check time"),
  };
}

/**
 * The cost of typed plugin steps. Every installed plugin's steps become
 * methods computed from the route's state, so the cost grows with the
 * plugins a project installs; this pins it where a regression shows.
 */
describe("the type budget of plugin steps", () => {
  /**
   * @case A project installing ten plugins with two steps each type-checks within budget
   * @preconditions The fixture project chains thirteen plugin and built-in steps across a choice, a defer and authenticate; a baseline fixture builds one bare route
   * @expectedResult The fixture compiles clean, adds fewer than 200k instantiations over the baseline, and checks in under 15 seconds
   */
  test(
    "ten plugins stay inside the budget",
    async () => {
      const [baseline, project] = await Promise.all([
        tsc("tsconfig.baseline.json"),
        tsc("tsconfig.json"),
      ]);

      expect(project.output).not.toContain("error TS");
      expect(project.instantiations - baseline.instantiations).toBeLessThan(
        200_000,
      );
      expect(project.checkSeconds).toBeLessThan(15);
    },
    { timeout: 120_000 },
  );

  /**
   * @case A wrong argument to a plugin step still produces a readable error
   * @preconditions The wrong fixture passes a key function returning a number where a string is declared, then calls an Order-only step on a string body
   * @expectedResult tsc reports the mismatched type and the missing method by name, and never gives up with an instantiation-depth error
   */
  test(
    "a wrong argument is a readable error",
    async () => {
      const wrong = await tsc("tsconfig.wrong.json");

      expect(wrong.output).toContain(
        "Type 'number' is not assignable to type 'string'",
      );
      expect(wrong.output).toContain("Property 'bravoOrder' does not exist");
      expect(wrong.output).not.toContain("excessively deep");
    },
    { timeout: 120_000 },
  );

  /**
   * @case A plugin the application does not install is absent from its routes
   * @preconditions The overrides fixture lists a replacement for a plugin a bundle brings, and displaces the default auth plugin beside a service typed as the plain Plugin
   * @expectedResult tsc reports the brought plugin's method and the displaced default's method as missing by name, and the replacement's method compiles
   */
  test(
    "a plugin the application does not install has no methods",
    async () => {
      const overrides = await tsc("tsconfig.overrides.json");

      expect(overrides.output).toContain("Property 'obsolete' does not exist");
      expect(overrides.output).toContain(
        "Property 'authenticate' does not exist",
      );
      expect(overrides.output).not.toContain(
        "Property 'current' does not exist",
      );
      expect(overrides.output).not.toContain("excessively deep");
    },
    { timeout: 120_000 },
  );
});
