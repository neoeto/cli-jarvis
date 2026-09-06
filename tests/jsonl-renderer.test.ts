import { describe, expect, it, vi } from "vitest";
import { jsonlRenderer } from "../src/cli/renderers/jsonl.js";

describe("JSONL renderer", () => {
  it("does not expose prepared-action ids in public confirmation events", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await jsonlRenderer({
        type: "confirmation_requested",
        request: {
          actionId: "internal-action-id",
          toolName: "run_command",
          summary: "Run a command",
          targets: ["/workspace"],
          effects: ["process"]
        }
      });
      const serialized = String(write.mock.calls[0]?.[0]);
      expect(serialized).not.toContain("internal-action-id");
      expect(serialized).toContain('"type":"confirmation_requested"');
    } finally {
      write.mockRestore();
    }
  });
});
