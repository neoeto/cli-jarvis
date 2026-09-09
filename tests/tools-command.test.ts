import displayWidth from "string-width";
import { describe, expect, it } from "vitest";
import { formatToolListPage, formatToolTable, paginateToolRows } from "../src/cli/commands/tools.js";

describe("tools list table", () => {
  it("renders aligned headers and compacts multiline external Tool descriptions", () => {
    const table = formatToolTable([
      { name: "list_files", risk: "low", source: "builtin", description: "List files in the workspace." },
      { name: "cli_very_long_external_command_4a22ed30b86f", risk: "high", source: "external-cli", description: "管理集群。\nUsage: clusterctl deploy --environment NAME\nExternal CLI; execution requires confirmation." }
    ], 100);
    const lines = table.split("\n");
    expect(lines[0]).toContain("NAME");
    expect(lines[0]).toContain("DESCRIPTION");
    expect(lines).toHaveLength(4);
    expect(table).not.toContain("\t");
    expect(table).not.toContain("\nUsage:");
    expect(lines.every((line) => displayWidth(line) <= 100)).toBe(true);
  });

  it("keeps a useful table at narrow terminal widths", () => {
    const table = formatToolTable([
      { name: "外部工具", risk: "high", source: "local-extension", description: "A description that should be truncated before it displaces other columns." }
    ], 40);
    expect(table.split("\n").every((line) => displayWidth(line) <= 80)).toBe(true);
    expect(table).toContain("…");
  });

  it("selects a requested page and reports pagination details", () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      name: `tool_${index + 1}`,
      risk: "low",
      source: "builtin",
      description: `Tool ${index + 1}`
    }));
    const page = paginateToolRows(rows, "2", "20");

    expect(page).toMatchObject({ page: 2, pageSize: 20, total: 25, totalPages: 2 });
    expect(page.rows.map((row) => row.name)).toEqual(["tool_21", "tool_22", "tool_23", "tool_24", "tool_25"]);
    expect(formatToolListPage(page)).toContain("Page 2/2 · 25 tools · 20 per page");
  });

  it("rejects invalid and unavailable pages", () => {
    const rows = [{ name: "tool", risk: "low", source: "builtin", description: "Tool" }];
    expect(() => paginateToolRows(rows, "0")).toThrow("page must be an integer");
    expect(() => paginateToolRows(rows, "2")).toThrow("page 2 is outside the available range 1-1");
    expect(() => paginateToolRows(rows, "1", "101")).toThrow("page-size must be an integer between 1 and 100");
  });
});
