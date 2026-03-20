import { render } from "ink-testing-library";
import { describe, test, expect } from "vitest";
import { DotGraph } from "../../../src/tui/components/dot-graph.js";

describe("DotGraph", () => {
  /**
   * @case Renders without crashing when given empty values
   * @preconditions Empty values array
   * @expectedResult A frame is produced (no error thrown)
   */
  test("renders without crashing with empty values", () => {
    const { lastFrame } = render(<DotGraph values={[]} columns={20} />);
    const frame = lastFrame()!;
    // Should produce some output (braille characters for zero values)
    expect(frame).toBeDefined();
  });

  /**
   * @case Renders with non-zero values and produces output
   * @preconditions Array of positive numbers
   * @expectedResult The frame contains characters (braille output is hard to assert exactly)
   */
  test("renders with values", () => {
    const values = [5, 15, 25, 35, 45, 10, 0, 20];
    const { lastFrame } = render(<DotGraph values={values} columns={20} />);
    const frame = lastFrame()!;
    // Should have non-empty output with braille characters
    expect(frame.trim().length).toBeGreaterThan(0);
  });

  /**
   * @case Renders optional label text below the graph
   * @preconditions A label prop is provided
   * @expectedResult The label text appears in the output
   */
  test("renders optional label", () => {
    const { lastFrame } = render(
      <DotGraph values={[10, 20, 30]} columns={10} label="Throughput" />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Throughput");
  });
});
