import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, test, expect } from "vitest";
import { Table, type ColumnDef } from "../../../src/tui/components/table.js";

type Row = { id: string; name: string };

const columns: ColumnDef<Row>[] = [
  {
    header: "ID",
    width: 6,
    render: (row) => <Text>{row.id}</Text>,
  },
  {
    header: "Name",
    width: "flex",
    render: (row) => <Text>{row.name}</Text>,
  },
];

const sampleData: Row[] = [
  { id: "r1", name: "Alpha" },
  { id: "r2", name: "Bravo" },
  { id: "r3", name: "Charlie" },
  { id: "r4", name: "Delta" },
  { id: "r5", name: "Echo" },
];

describe("Table", () => {
  /**
   * @case Renders column headers
   * @preconditions Columns with header labels are provided
   * @expectedResult Both "ID" and "Name" headers appear in the output
   */
  test("renders column headers", () => {
    const { lastFrame } = render(
      <Table
        columns={columns}
        data={sampleData}
        rowKey={(row) => row.id}
        scrollOffset={0}
        visibleRows={5}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("ID");
    expect(frame).toContain("Name");
  });

  /**
   * @case Shows emptyMessage when data array is empty
   * @preconditions Empty data array and a custom emptyMessage
   * @expectedResult The empty message text appears in the output
   */
  test("renders empty state with emptyMessage", () => {
    const { lastFrame } = render(
      <Table
        columns={columns}
        data={[]}
        rowKey={(_, i) => String(i)}
        scrollOffset={0}
        visibleRows={5}
        emptyMessage="Nothing here"
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Nothing here");
  });

  /**
   * @case Renders data rows with cell content
   * @preconditions Non-empty data array
   * @expectedResult Row values like "Alpha" and "Bravo" are visible
   */
  test("renders data rows", () => {
    const { lastFrame } = render(
      <Table
        columns={columns}
        data={sampleData}
        rowKey={(row) => row.id}
        scrollOffset={0}
        visibleRows={5}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Alpha");
    expect(frame).toContain("Bravo");
    expect(frame).toContain("Charlie");
  });

  /**
   * @case Respects scrollOffset and visibleRows to show a window of data
   * @preconditions scrollOffset=2 and visibleRows=2 with 5 total rows
   * @expectedResult Only rows at index 2 and 3 are visible; earlier rows are not
   */
  test("respects scrollOffset and visibleRows", () => {
    const { lastFrame } = render(
      <Table
        columns={columns}
        data={sampleData}
        rowKey={(row) => row.id}
        scrollOffset={2}
        visibleRows={2}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Charlie");
    expect(frame).toContain("Delta");
    expect(frame).not.toContain("Alpha");
    expect(frame).not.toContain("Echo");
  });

  /**
   * @case Shows "more" indicator when rows exist below the visible window
   * @preconditions visibleRows is less than total data length
   * @expectedResult The down-arrow "more" text appears
   */
  test("shows more indicator when more rows exist below", () => {
    const { lastFrame } = render(
      <Table
        columns={columns}
        data={sampleData}
        rowKey={(row) => row.id}
        scrollOffset={0}
        visibleRows={2}
      />,
    );
    const frame = lastFrame()!;
    // U+2193 is the down arrow used for the "more" indicator
    expect(frame).toContain("\u2193 more");
  });
});
