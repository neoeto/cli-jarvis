import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agent/runtime.js";
import type { AgentEvent } from "../src/agent/events.js";
import type { ModelProvider, ModelResponse } from "../src/providers/types.js";
import type { PreparedAction, Tool, ToolContext, ToolResult } from "../src/tools/types.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { FinishTaskTool } from "../src/tools/builtins/finish-task.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const previewTool: Tool<Record<string, never>, Record<string, never>> = {
  definition: { type: "function", function: { name: "preview_test", description: "test", parameters: { type: "object" } } },
  defaultRisk: "medium",
  possibleEffects: ["write"],
  parse: () => ({}),
  prepare: async (): Promise<PreparedAction<Record<string, never>>> => ({
    id: "preview", toolName: "preview_test", riskLevel: "medium", summary: "write a test file", targets: [], effects: ["write"],
    payload: {}, expiresAt: new Date(Date.now() + 60_000).toISOString()
  }),
  execute: async (_action: PreparedAction<Record<string, never>>, _context: ToolContext): Promise<ToolResult> => {
    throw new Error("dry-run must not execute");
  }
};

class PreviewProvider implements ModelProvider {
  readonly id = "fake";
  calls = 0;
  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    return this.calls === 1
      ? { kind: "tool_calls", calls: [{ id: "preview-call", name: "preview_test", arguments: "{}" }] }
      : { kind: "tool_calls", calls: [{ id: "finish", name: "finish_task", arguments: '{"answer":"preview complete"}' }] };
  }
}

describe("roadmap runtime controls", () => {
  it("emits lifecycle states and gives models a non-executing preview result", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "cj-runtime-test-"));
    created.push(workspace);
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      provider: new PreviewProvider(), model: "fake", registry: new ToolRegistry().register(previewTool).register(new FinishTaskTool()), workspaceRoot: workspace,
      language: "en", maxToolCalls: 2, signal: new AbortController().signal, dryRun: true, taskId: "task-1", emitLifecycle: true,
      onEvent: (event) => events.push(event)
    });
    await expect(runtime.run("preview")).resolves.toBe("preview complete");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_preview", name: "preview_test" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "task_status", status: "planning" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "task_status", status: "completed" }));
  });
});
