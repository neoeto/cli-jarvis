import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agent/runtime.js";
import type { AgentEvent } from "../src/agent/events.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/providers/types.js";
import { ListFilesTool } from "../src/tools/builtins/list-files.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { PreparedAction, Tool, ToolContext, ToolResult } from "../src/tools/types.js";

class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly requests: Array<Omit<ModelRequest, "onTextDelta">> = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { onTextDelta: _onTextDelta, ...serializableRequest } = request;
    this.requests.push(structuredClone(serializableRequest));
    if (this.requests.length === 1) {
      return {
        kind: "tool_calls",
        calls: [{ id: "call-1", name: "list_files", arguments: '{"path":".","recursive":false}' }]
      };
    }
    return { kind: "message", content: "目录中有一个文件：hello.txt" };
  }
}

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AgentRuntime", () => {
  it("executes list_files and returns its result to the model", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    await writeFile(path.join(root, "hello.txt"), "hello");
    const provider = new FakeProvider();
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      provider,
      model: "fake-model",
      registry: new ToolRegistry().register(new ListFilesTool()),
      workspaceRoot: root,
      language: "zh-CN",
      maxToolCalls: 20,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event)
    });

    await expect(runtime.run("列出文件")).resolves.toBe("目录中有一个文件：hello.txt");
    expect(provider.requests).toHaveLength(2);
    const secondRequest = provider.requests[1];
    expect(secondRequest?.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-1" });
    expect(JSON.stringify(secondRequest?.messages.at(-1))).toContain("hello.txt");
    expect(events.map((event) => event.type)).toEqual([
      "status",
      "tool_start",
      "tool_result",
      "assistant"
    ]);
  });

  it("returns invalid Tool arguments to the model without executing", async () => {
    class InvalidProvider implements ModelProvider {
      readonly id = "fake";
      calls = 0;
      async complete(): Promise<ModelResponse> {
        this.calls += 1;
        return this.calls === 1
          ? { kind: "tool_calls", calls: [{ id: "bad", name: "list_files", arguments: "not json" }] }
          : { kind: "message", content: "无法执行：参数无效" };
      }
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    const runtime = new AgentRuntime({
      provider: new InvalidProvider(),
      model: "fake-model",
      registry: new ToolRegistry().register(new ListFilesTool()),
      workspaceRoot: root,
      language: "zh-CN",
      maxToolCalls: 20,
      signal: new AbortController().signal
    });

    await expect(runtime.run("列出文件")).resolves.toBe("无法执行：参数无效");
  });

  it("returns an unknown Tool error to the model for correction", async () => {
    class UnknownToolProvider implements ModelProvider {
      readonly id = "fake";
      calls = 0;
      lastRequest?: Omit<ModelRequest, "onTextDelta">;

      async complete(request: ModelRequest): Promise<ModelResponse> {
        this.calls += 1;
        const { onTextDelta: _onTextDelta, ...serializableRequest } = request;
        this.lastRequest = structuredClone(serializableRequest);
        return this.calls === 1
          ? { kind: "tool_calls", calls: [{ id: "unknown", name: "delete_everything", arguments: "{}" }] }
          : { kind: "message", content: "该工具不可用" };
      }
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    const provider = new UnknownToolProvider();
    const runtime = new AgentRuntime({
      provider,
      model: "fake-model",
      registry: new ToolRegistry().register(new ListFilesTool()),
      workspaceRoot: root,
      language: "zh-CN",
      maxToolCalls: 20,
      signal: new AbortController().signal
    });

    await expect(runtime.run("删除一切")).resolves.toBe("该工具不可用");
    expect(provider.lastRequest?.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "unknown" });
    expect(JSON.stringify(provider.lastRequest?.messages.at(-1))).toContain("Unknown Tool");
  });

  it("executes a high-risk Tool only after confirmation", async () => {
    let executed = false;
    const highRiskTool: Tool<Record<string, never>, Record<string, never>> = {
      definition: {
        type: "function",
        function: {
          name: "high_risk_test",
          description: "A test-only high-risk Tool",
          parameters: { type: "object", additionalProperties: false }
        }
      },
      defaultRisk: "high",
      possibleEffects: ["write"],
      parse: () => ({}),
      prepare: async (): Promise<PreparedAction<Record<string, never>>> => ({
        id: "approval1",
        toolName: "high_risk_test",
        riskLevel: "high",
        summary: "Perform test mutation",
        targets: ["test-target"],
        effects: ["write"],
        reversible: false,
        payload: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }),
      execute: async (
        _action: PreparedAction<Record<string, never>>,
        _context: ToolContext
      ): Promise<ToolResult> => {
        executed = true;
        return { success: true, message: "Executed", effects: ["Test mutation"] };
      }
    };
    class HighRiskProvider implements ModelProvider {
      readonly id = "fake";
      calls = 0;
      async complete(): Promise<ModelResponse> {
        this.calls += 1;
        return this.calls === 1
          ? { kind: "tool_calls", calls: [{ id: "high", name: "high_risk_test", arguments: "{}" }] }
          : { kind: "message", content: "完成" };
      }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      provider: new HighRiskProvider(),
      model: "fake-model",
      registry: new ToolRegistry().register(highRiskTool),
      workspaceRoot: root,
      language: "zh-CN",
      maxToolCalls: 20,
      signal: new AbortController().signal,
      interactive: true,
      confirm: async () => true,
      onEvent: (event) => events.push(event)
    });

    await expect(runtime.run("执行高风险操作")).resolves.toBe("完成");
    expect(executed).toBe(true);
    expect(events.map((event) => event.type)).toContain("confirmation_requested");
    expect(events).toContainEqual({
      type: "confirmation_resolved",
      actionId: "approval1",
      approved: true
    });
  });
});
