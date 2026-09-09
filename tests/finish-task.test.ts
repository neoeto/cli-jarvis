import { describe, expect, it } from "vitest";
import { FinishTaskTool } from "../src/tools/builtins/finish-task.js";

describe("finish_task Tool", () => {
  it("accepts a bounded final answer and returns it unchanged to the host", async () => {
    const tool = new FinishTaskTool();
    const context = { workspaceRoot: process.cwd(), signal: new AbortController().signal };
    const action = await tool.prepare(tool.parse({ answer: "Task complete." }), context);
    await expect(tool.execute(action, context)).resolves.toMatchObject({
      success: true,
      data: { answer: "Task complete." }
    });
  });

  it("rejects an empty or unbounded answer", () => {
    const tool = new FinishTaskTool();
    expect(() => tool.parse({ answer: "   " })).toThrow();
    expect(() => tool.parse({ answer: "x".repeat(20_001) })).toThrow();
  });
});
