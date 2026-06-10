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
   * @preconditions The choice/when/otherwise example with a factory-rooted enrich callback and a log template literal
   * @expectedResult Parameter-threaded builders stay inline, while the factory-rooted (ex) => direct(...).send(...) breaks its body onto a new line
   */
  test("issue example compacts builders and breaks factory-rooted callbacks", async () => {
    const out = await format(
      `export const route = craft().id("mail").from(mail({ action: "watch" })).choice((c) => c.when(senderInAllowlist(env.MAIL_ALLOWED_INBOUND), (b) => b.enrich((ex) => direct<{ name: string; body: MailMessage }, AgentResult>("agent").send(DefaultExchange.rewrap(ex, { body: { name: "zoe", body: ex.body } })), only((r) => r, "agent")).to(mail({ action: "move", folder: "[Gmail]/All Mail" })).log((ex) => \`Processed: \${ex.body.from} [\${ex.body.sender?.address}] - \${ex.body.subject}\`)).otherwise((b) => b));`,
    );
    // Parameter-threaded builders stay inline: parameter on the arrow line.
    expect(out).toContain("(c) => c\n");
    expect(out).toContain("(b) => b\n");
    // Factory-rooted callback: the body breaks onto its own indented line so the
    // parameter and the factory chain do not crowd together.
    expect(out).toMatch(/\(ex\) =>\s*\n\s*direct</);
    expect(out).not.toContain("(ex) => direct<");
    // A non-chain body (template literal) is still left to Prettier.
    expect(out).toMatch(/\(ex\) =>\s*\n\s*`Processed:/);
    expect(await format(out)).toBe(out);
  });

  /**
   * @case A factory-rooted callback that is the sole argument of a DSL call hugs the call line
   * @preconditions A single-argument .enrich((ex) => direct(...).send(...)) inside a craft() chain
   * @expectedResult The parameter stays on the enrich line and the factory chain breaks onto the next line
   */
  test("single-arg factory-rooted callback hugs the call line", async () => {
    const out = await format(
      `export const route = craft().id("m").from(src()).choice((c) => c.when(isA(), (b) => b.enrich((ex) => direct<{ name: string; body: MailMessage }, AgentResult>("agent").send(DefaultExchange.rewrap(ex, { body: { name: "zoe", body: ex.body } })))).otherwise((b) => b));`,
    );
    expect(out).toMatch(/\.enrich\(\(ex\) =>\s*\n\s*direct</);
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

  /**
   * @case An arrow whose body carries a leading comment is left to Prettier and stays idempotent
   * @preconditions A choice arrow with a comment between => and the body: (c) => / comment / c.when(...)
   * @expectedResult Output is roundtrip stable and matches stock Prettier (the plugin bails to the default printer for comment-bearing arrows)
   */
  test("arrow with a comment before its body is stable and left to Prettier", async () => {
    const src = `export const r = craft().id("x").from(s()).choice((c) =>\n  // pick a branch\n  c.when(isA(), (b) => b.to(a())).otherwise((b) => b));`;
    const once = await format(src);
    // Idempotent: formatting the result again is a no-op.
    expect(await format(once)).toBe(once);
    // Comment-bearing arrow falls through to stock Prettier's layout.
    expect(once).toBe(await formatStock(src));
  });

  /**
   * @case Comments on branches inside the chain keep the compact layout
   * @preconditions A choice whose .when()/.otherwise() branches are preceded by line comments
   * @expectedResult The chain stays compact (parameter on the arrow line) and output is roundtrip stable
   */
  test("branch comments keep the compact layout", async () => {
    const out = await format(
      `export const r = craft().id("x").from(s()).choice((c) => c\n  // urgent\n  .when(isUrgent, (b) => b.to(urgent))\n  // everything else\n  .otherwise((b) => b));`,
    );
    expect(out).toContain("(c) => c\n");
    expect(out).toContain("// urgent");
    expect(out).toContain("// everything else");
    expect(await format(out)).toBe(out);
  });

  /**
   * @case An arrow with a typed parameter is left to Prettier (the type annotation is never broken to fit)
   * @preconditions A craft chain whose .enrich() projection uses a callback with a wide inline object type, e.g. only((r: { output?: { links: string[] } }) => r.output?.links, "links")
   * @expectedResult Output matches stock Prettier byte-for-byte and is roundtrip stable, so the type annotation stays intact
   */
  test("typed-parameter arrows are left to Prettier", async () => {
    const src = `export const r = craft().id("x").from(s()).enrich(enricher, only((r: { output?: { links: string[] } }) => r.output?.links, "links")).to(out());`;
    const out = await format(src);
    expect(out).toBe(await formatStock(src));
    expect(await format(out)).toBe(out);
  });
});
