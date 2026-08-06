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
      expect(build).toThrow(/mutually exclusive send behaviors/);
      try {
        build();
      } catch (error) {
        expect((error as { rc?: string }).rc).toBe("RC5003");
      }
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
