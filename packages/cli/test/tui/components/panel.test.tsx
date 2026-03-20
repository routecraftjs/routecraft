import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, test, expect } from "vitest";
import { Panel } from "../../../src/tui/components/panel.js";

describe("Panel", () => {
  /**
   * @case Renders with title text and a separator line
   * @preconditions A title string is provided
   * @expectedResult Output contains the title text and a horizontal rule
   */
  test("renders with title and separator", () => {
    const { lastFrame } = render(
      <Panel title="My Panel">
        <Text>body</Text>
      </Panel>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("My Panel");
    // Separator uses U+2500 (box drawing horizontal)
    expect(frame).toContain("\u2500");
  });

  /**
   * @case Renders without title when none is provided
   * @preconditions No title prop is passed
   * @expectedResult Output does not contain a separator line but still renders children
   */
  test("renders without title", () => {
    const { lastFrame } = render(
      <Panel>
        <Text>child content</Text>
      </Panel>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("child content");
    // The Panel uses U+2500 for separator; the border uses U+2502/U+256D etc.
    // Without a title there should be no U+2500 separator line inside the box.
    // The round border uses different characters (U+256D, U+256E, U+2500 in border).
    // We check that no bold title text is present (no separator drawn by Panel logic).
    // Since the border itself uses U+2500, we verify no repeated separator beyond border.
    const lines = frame.split("\n");
    // The inner lines (not first/last border) should not contain a full separator
    const innerLines = lines.slice(1, -1);
    const hasTitleSeparator = innerLines.some(
      (l) => l.includes("\u2500".repeat(10)) && !l.startsWith("\u2570"),
    );
    expect(hasTitleSeparator).toBe(false);
  });

  /**
   * @case Renders subtitle alongside title
   * @preconditions Both title and subtitle props are provided
   * @expectedResult Output contains both the title and the subtitle text
   */
  test("renders with subtitle alongside title", () => {
    const { lastFrame } = render(
      <Panel title="Header" subtitle={<Text>(extra)</Text>}>
        <Text>content</Text>
      </Panel>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Header");
    expect(frame).toContain("(extra)");
  });

  /**
   * @case Children content is visible in the rendered output
   * @preconditions Panel has children nodes
   * @expectedResult The children text appears in the frame
   */
  test("children content is visible", () => {
    const { lastFrame } = render(
      <Panel title="Wrapper">
        <Text>first child</Text>
        <Text>second child</Text>
      </Panel>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("first child");
    expect(frame).toContain("second child");
  });
});
