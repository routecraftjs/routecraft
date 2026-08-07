import { describe, expect, test } from "bun:test";
import { csv, file, html, json, jsonl } from "@routecraft/routecraft";

/**
 * The mutually-exclusive send-behavior law for the file family:
 * `append: true` and `delete: true` cannot be combined. The guard lives in
 * the destination adapter constructors (shared
 * `assertExclusiveSendBehavior` helper) and surfaces at factory-call time
 * because every factory constructs its destination eagerly.
 */
describe("file-family append/delete guard", () => {
  const factories: ReadonlyArray<
    readonly [name: string, build: () => unknown]
  > = [
    ["file", () => file({ path: "./x.txt", append: true, delete: true })],
    ["csv", () => csv({ path: "./x.csv", append: true, delete: true })],
    ["json", () => json({ path: "./x.json", append: true, delete: true })],
    ["jsonl", () => jsonl({ path: "./x.jsonl", append: true, delete: true })],
    ["html", () => html({ path: "./x.html", append: true, delete: true })],
  ];

  /**
   * @case append: true combined with delete: true is refused at construction
   * @preconditions Factory called with both send-behavior flags set
   * @expectedResult RC5003 with the shared mutually-exclusive message
   */
  test.each(factories)(
    "%s: append + delete throws RC5003 at construction",
    (_name, build) => {
      // One construction, one captured error: asserting inside a catch would
      // pass silently if the call stopped throwing.
      let thrown: unknown;
      try {
        build();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(
        /mutually exclusive send behaviors/,
      );
      expect((thrown as { rc?: string }).rc).toBe("RC5003");
    },
  );

  /**
   * @case Each flag alone is accepted
   * @preconditions Factory called with only append or only delete
   * @expectedResult Construction succeeds
   */
  test.each(factories.map(([name]) => name))(
    "%s: append or delete alone constructs fine",
    (name) => {
      const single = {
        file: () => [
          file({ path: "./x.txt", append: true }),
          file({ path: "./x.txt", delete: true }),
        ],
        csv: () => [
          csv({ path: "./x.csv", append: true }),
          csv({ path: "./x.csv", delete: true }),
        ],
        json: () => [
          json({ path: "./x.json", append: true }),
          json({ path: "./x.json", delete: true }),
        ],
        jsonl: () => [
          jsonl({ path: "./x.jsonl", append: true }),
          jsonl({ path: "./x.jsonl", delete: true }),
        ],
        html: () => [
          html({ path: "./x.html", append: true }),
          html({ path: "./x.html", delete: true }),
        ],
      }[name];
      expect(single).toBeDefined();
      expect(() => single!()).not.toThrow();
    },
  );
});

/**
 * The presence law for the factories discriminated by `path` (`json` and
 * `html`: transformer without one, file roles with one). "Presence" means the
 * key was supplied, so an empty string is a supplied path and not an absent
 * one; left to truthiness it would hand back a transformer that silently
 * ignores every file option passed alongside it.
 */
describe("path-presence role selection", () => {
  const empties: ReadonlyArray<readonly [name: string, build: () => unknown]> =
    [
      ["json", () => json({ path: "" })],
      ["html", () => html({ path: "" })],
    ];

  /**
   * @case An empty-string path is refused rather than selecting the transformer
   * @preconditions Factory called with path: ""
   * @expectedResult RC5003 naming the empty path
   */
  test.each(empties)("%s: path: '' throws RC5003", (_name, build) => {
    let thrown: unknown;
    try {
      build();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/`path` is an empty string/);
    expect((thrown as { rc?: string }).rc).toBe("RC5003");
  });

  /**
   * @case A supplied-but-undefined path is refused rather than selecting the transformer
   * @preconditions Options carrying an explicit `path: undefined`, reached past
   *   the overloads by cast (with exactOptionalPropertyTypes the type system
   *   already refuses this shape; the guard backstops untyped JS and casts)
   * @expectedResult RC5003 naming the supplied-but-undefined path
   */
  test.each([
    ["json", (o: object) => json(o as { path: string })],
    ["html", (o: object) => html(o as { path: string })],
  ] as ReadonlyArray<readonly [name: string, build: (o: object) => unknown]>)(
    "%s: path: undefined throws RC5003",
    (_name, build) => {
      // The absence-axis twin of the widened-boolean hazard: the caller means
      // "file adapter, path from config", so silently handing back a
      // transformer would ignore every file option passed alongside it.
      let thrown: unknown;
      try {
        build({ path: undefined });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(
        /`path` was supplied but is undefined/,
      );
      expect((thrown as { rc?: string }).rc).toBe("RC5003");
    },
  );

  /**
   * @case Omitting path entirely still selects the transformer role
   * @preconditions Factory called with no path key
   * @expectedResult A transformer (transform slot, no send/fetch/subscribe)
   */
  test.each([
    ["json", () => json({ pointer: "data" })],
    ["html", () => html({ selector: "h1" })],
  ] as ReadonlyArray<readonly [name: string, build: () => unknown]>)(
    "%s: no path selects the transformer role",
    (_name, build) => {
      const adapter = build() as Record<string, unknown>;
      expect(typeof adapter["transform"]).toBe("function");
      expect(adapter["send"]).toBeUndefined();
      expect(adapter["fetch"]).toBeUndefined();
      expect(adapter["subscribe"]).toBeUndefined();
    },
  );
});
