import { describe, expect, test } from "bun:test";
import prettier from "prettier";
import plugin from "../src/index.ts";

/** Format a TypeScript snippet with the Routecraft plugin enabled. */
async function format(source: string): Promise<string> {
  return prettier.format(source, {
    parser: "typescript",
    plugins: [plugin],
  });
}

/** Format the same snippet with stock Prettier (no plugin). */
async function formatStock(source: string): Promise<string> {
  return prettier.format(source, { parser: "typescript" });
}

describe("prettier-plugin-routecraft", () => {
  /**
   * @case A choice with a single when branch keeps the threaded parameter inline
   * @preconditions A craft() chain containing .choice((c) => c.when(...))
   * @expectedResult The arrow head stays on the choice line (`(c) => c`) rather than breaking onto its own line
   */
  test("single when branch stays compact", async () => {
    const out = await format(
      `export const r = craft().id("c").from(src()).choice((c) => c.when(isAllowed(env.X), (b) => b.enrich(agent("zoe")).to(out())));`,
    );
    // Single short link keeps `c.when(...)` inline; the key win is that the
    // parameter is never pushed onto its own line after the arrow.
    expect(out).not.toMatch(/\(c\) =>\s*\n\s*c\b/);
    expect(out).toContain("(b) => b\n");
  });

  /**
   * @case A choice with two when branches keeps both branches one indent level below choice
   * @preconditions A craft() chain with .choice((c) => c.when(...).when(...).otherwise(...))
   * @expectedResult Each branch stays compact and the chain remains roundtrip stable
   */
  test("two when branches stay compact", async () => {
    const out = await format(
      `export const r = craft().id("c").from(src()).choice((c) => c.when(isA(), (b) => b.to(a())).when(isB(), (b) => b.to(b())).otherwise((b) => b));`,
    );
    expect(out).toContain("(c) => c\n");
    expect(out).toContain(".when(isA(), (b) => b.to(a()))");
    expect(out).toContain(".when(isB(), (b) => b.to(b()))");
    expect(out).toContain(".otherwise((b) => b)");
    expect(await format(out)).toBe(out);
  });

  /**
   * @case A choice with three or more when branches remains readable and compact
   * @preconditions A craft() chain with three .when() branches and an .otherwise()
   * @expectedResult The arrow head stays inline and no branch is buried under an extra indent level
   */
  test("three when branches stay compact", async () => {
    const out = await format(
      `export const r = craft().id("c").from(src()).choice((c) => c.when(isA(), (b) => b.to(a())).when(isB(), (b) => b.to(b())).when(isC(), (b) => b.to(c())).otherwise((b) => b));`,
    );
    expect(out).toContain("(c) => c\n");
    expect(out).not.toMatch(/\(c\) =>\s*\n\s*c\b/);
    for (const branch of ["isA()", "isB()", "isC()"]) {
      expect(out).toContain(branch);
    }
    expect(await format(out)).toBe(out);
  });

  /**
   * @case A choice without an otherwise branch is still formatted compactly
   * @preconditions A craft() chain with .choice((c) => c.when(...)) and no .otherwise()
   * @expectedResult The threaded parameter stays inline and output is roundtrip stable
   */
  test("choice without otherwise stays compact", async () => {
    const src = `export const r = craft().id("c").from(src()).choice((c) => c.when(isA(), (b) => b.to(a())));`;
    const out = await format(src);
    expect(out).toContain(".choice((c) => c.when(isA(), (b) => b.to(a())));");
    expect(await format(out)).toBe(out);
  });

  /**
   * @case split and aggregate sub-builder closures are formatted compactly
   * @preconditions A craft() chain using .split((s) => ...) and .aggregate((a) => ...)
   * @expectedResult The threaded parameters stay inline with their arrows and output is roundtrip stable
   */
  test("split and aggregate chains stay compact", async () => {
    const out = await format(
      `export const r = craft().id("s").from(src()).split((s) => s.body.items).to(log()).aggregate((a) => a.size(10)).to(out());`,
    );
    expect(out).toContain(".split((s) => s.body.items)");
    expect(out).toContain(".aggregate((a) => a.size(10))");
    expect(await format(out)).toBe(out);
  });

  /**
   * @case A choice nested inside another choice keeps each level compact
   * @preconditions A craft() chain with .choice() whose when branch contains another .choice()
   * @expectedResult Both the outer and inner choice arrows keep their parameters inline and output is stable
   */
  test("deeply nested choice stays compact", async () => {
    const out = await format(
      `export const r = craft().id("n").from(src()).choice((c) => c.when(isA(), (b) => b.choice((c2) => c2.when(isB(), (b2) => b2.to(x())).otherwise((b2) => b2))).otherwise((b) => b));`,
    );
    expect(out).toContain("(c) => c\n");
    expect(out).toContain("(c2) => c2\n");
    expect(out).not.toMatch(/\(c\) =>\s*\n\s*c\b/);
    expect(out).not.toMatch(/\(c2\) =>\s*\n\s*c2\b/);
    expect(await format(out)).toBe(out);
  });

  /**
   * @case The full mail-routing example from the issue formats to the documented compact shape
   * @preconditions The choice/when/otherwise example with a non-threaded enrich callback and a log template literal
   * @expectedResult The DSL arrows compact while the non-DSL enrich callback (head is direct(...), not the parameter) is left to Prettier
   */
  test("issue example compacts DSL arrows but leaves non-DSL callbacks alone", async () => {
    const out = await format(
      `export const route = craft().id("mail").from(mail({ action: "watch" })).choice((c) => c.when(senderInAllowlist(env.MAIL_ALLOWED_INBOUND), (b) => b.enrich((ex) => direct<{ name: string; body: MailMessage }, AgentResult>("agent").send(DefaultExchange.rewrap(ex, { body: { name: "zoe", body: ex.body } })), only((r) => r, "agent")).to(mail({ action: "move", folder: "[Gmail]/All Mail" })).log((ex) => \`Processed: \${ex.body.from}\`)).otherwise((b) => b));`,
    );
    // DSL arrows compacted: parameter stays on the arrow line.
    expect(out).toContain("(c) => c\n");
    expect(out).toContain("(b) => b\n");
    // Non-DSL callback whose chain head is direct(...) keeps Prettier's default
    // layout: its parameter is not threaded, so the arrow body breaks normally.
    expect(out).toMatch(/\(ex\) =>\s*\n\s*direct</);
    expect(await format(out)).toBe(out);
  });

  /**
   * @case A non-Routecraft fluent chain is left exactly as stock Prettier would format it
   * @preconditions An arr.map((x) => x.foo().bar().baz()) chain with no craft() root, both short and long
   * @expectedResult Output is byte-for-byte identical to stock Prettier (plugin does not touch non-DSL chains)
   */
  test("non-DSL chains are untouched", async () => {
    const shortSrc = `const notDsl = arr.map((x) => x.foo().bar().baz());`;
    const longSrc = `const notDsl = someReallyLongCollectionName.map((item) => item.transformOne().transformTwo().transformThree().transformFour().transformFive());`;
    expect(await format(shortSrc)).toBe(await formatStock(shortSrc));
    expect(await format(longSrc)).toBe(await formatStock(longSrc));
  });
});
