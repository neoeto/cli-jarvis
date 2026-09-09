import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agent/runtime.js";
import type { AgentEvent } from "../src/agent/events.js";
import type { AgentMessage, ModelProvider, ModelRequest, ModelResponse } from "../src/providers/types.js";
import { ListFilesTool } from "../src/tools/builtins/list-files.js";
import { AskQuestionTool } from "../src/tools/builtins/ask-question.js";
import { FinishTaskTool } from "../src/tools/builtins/finish-task.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { PreparedAction, Tool, ToolContext, ToolResult } from "../src/tools/types.js";
import type { ConfirmationHandler } from "../src/policy/engine.js";

const finish = (answer: string): ModelResponse => ({
  kind: "tool_calls",
  calls: [{ id: "finish", name: "finish_task", arguments: JSON.stringify({ answer }) }]
});

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
    return finish("目录中有一个文件：hello.txt");
  }
}

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AgentRuntime", () => {
  it("fails closed when a model asks or answers in ordinary text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-text-protocol-"));
    created.push(root);
    let toolChoice: ModelRequest["toolChoice"] | undefined;
    const provider: ModelProvider = {
      id: "fake",
      async complete(request) {
        toolChoice = request.toolChoice;
        return { kind: "message", content: "请问您想了解哪一种？" };
      }
    };
    const runtime = new AgentRuntime({
      provider, model: "fake", registry: new ToolRegistry().register(new FinishTaskTool()),
      workspaceRoot: root, language: "zh-CN", maxToolCalls: 20, signal: new AbortController().signal
    });

    await expect(runtime.run("查询资料")).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
    expect(toolChoice).toBe("required");
  });

  it("requires finish_task to be the only Tool call in its response", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-finish-protocol-"));
    created.push(root);
    let calls = 0;
    const provider: ModelProvider = {
      id: "fake",
      async complete() {
        calls += 1;
        return calls === 1
          ? {
              kind: "tool_calls",
              calls: [
                { id: "finish", name: "finish_task", arguments: '{"answer":"ignore this"}' },
                { id: "list", name: "list_files", arguments: '{"path":"."}' }
              ]
            }
          : finish("Done.");
      }
    };
    const runtime = new AgentRuntime({
      provider, model: "fake", registry: new ToolRegistry().register(new FinishTaskTool()).register(new ListFilesTool()),
      workspaceRoot: root, language: "en", maxToolCalls: 20, signal: new AbortController().signal
    });

    await expect(runtime.run("do work")).resolves.toBe("Done.");
    expect(calls).toBe(2);
  });

  it("classifies tool-call commentary and reasoning separately from the final answer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-output-"));
    created.push(root);
    let round = 0;
    const provider: ModelProvider = {
      id: "fake",
      async complete(request) {
        if (round++ === 0) {
          await request.onTextDelta?.("先列出文件。\n\n");
          return {
            kind: "tool_calls",
            content: "先列出文件。\n\n",
            reasoning: "需要检查目录。",
            calls: [{ id: "list", name: "list_files", arguments: '{"path":"."}' }]
          };
        }
        await request.onTextDelta?.("目录为空。");
        return finish("目录为空。");
      }
    };
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      provider, model: "fake", registry: new ToolRegistry().register(new ListFilesTool()).register(new FinishTaskTool()),
      workspaceRoot: root, language: "zh-CN", maxToolCalls: 20,
      signal: new AbortController().signal, onEvent: (event) => events.push(event)
    });
    await expect(runtime.run("检查目录")).resolves.toBe("目录为空。");
    expect(events.filter((event) => ["reasoning", "assistant_progress", "assistant"].includes(event.type))).toEqual([
      { type: "reasoning", content: "需要检查目录。" },
      { type: "assistant_progress", content: "先列出文件。\n\n" },
      { type: "assistant", content: "目录为空。" }
    ]);
  });

  it("executes list_files and returns its result to the model", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    await writeFile(path.join(root, "hello.txt"), "hello");
    const provider = new FakeProvider();
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      provider,
      model: "fake-model",
      registry: new ToolRegistry().register(new ListFilesTool()).register(new FinishTaskTool()),
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
      "tool_start", "tool_result", "assistant"
    ]);
  });

  it("can continue a successful turn with the same in-memory transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    await writeFile(path.join(root, "hello.txt"), "hello");
    const provider = new FakeProvider();
    const messages: AgentMessage[] = [];
    const base = {
      provider,
      model: "fake-model",
      registry: new ToolRegistry().register(new ListFilesTool()).register(new FinishTaskTool()),
      workspaceRoot: root,
      language: "zh-CN" as const,
      maxToolCalls: 20,
      messages,
      interactive: false
    };

    await new AgentRuntime({ ...base, signal: new AbortController().signal }).run("列出文件");
    await expect(
      new AgentRuntime({ ...base, signal: new AbortController().signal }).run("那里面有什么？")
    ).resolves.toBe("目录中有一个文件：hello.txt");

    const secondTurnRequest = provider.requests[2];
    expect(secondTurnRequest?.messages.filter((message) => message.role === "user")).toEqual([
      { role: "user", content: "列出文件" },
      { role: "user", content: "那里面有什么？" }
    ]);
    expect(secondTurnRequest?.messages.at(-2)).toMatchObject({
      role: "assistant",
      content: "目录中有一个文件：hello.txt"
    });
  });

  it("returns a host-collected clarification answer to the model and continues the same task", async () => {
    class ClarifyingProvider implements ModelProvider {
      readonly id = "fake";
      calls = 0;
      lastRequest?: Omit<ModelRequest, "onTextDelta">;
      async complete(request: ModelRequest): Promise<ModelResponse> {
        this.calls += 1;
        const { onTextDelta: _onTextDelta, ...serializableRequest } = request;
        this.lastRequest = structuredClone(serializableRequest);
        return this.calls === 1
          ? {
              kind: "tool_calls",
              calls: [{
                id: "question-1",
                name: "ask_question",
                arguments: JSON.stringify({
                  question: "Which format should I use?",
                  options: [{ label: "Markdown" }, { label: "Plain text" }]
                })
              }]
            }
          : finish("I will use Markdown.");
      }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    const provider = new ClarifyingProvider();
    const events: AgentEvent[] = [];
    const waiting: boolean[] = [];
    const runtime = new AgentRuntime({
      provider,
      model: "fake-model",
      registry: new ToolRegistry().register(new AskQuestionTool()).register(new FinishTaskTool()),
      workspaceRoot: root,
      language: "en",
      maxToolCalls: 20,
      interactive: true,
      askQuestion: async () => ({ selected: ["Markdown"], answer: "Selected options: Markdown" }),
      onQuestionWaiting: (value) => waiting.push(value),
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event)
    });

    await expect(runtime.run("prepare a document")).resolves.toBe("I will use Markdown.");
    expect(provider.calls).toBe(2);
    expect(JSON.stringify(provider.lastRequest?.messages.at(-1))).toContain("Selected options: Markdown");
    expect(events).toContainEqual(expect.objectContaining({ type: "question_requested" }));
    expect(events).toContainEqual({ type: "question_resolved", selectedCount: 1, hasCustomInput: false });
    expect(JSON.stringify(events)).not.toContain("Selected options: Markdown");
    expect(waiting).toEqual([true, false]);
  });

  it("requires ask_question to be the only Tool call in its response", async () => {
    class MixedQuestionProvider implements ModelProvider {
      readonly id = "fake";
      calls = 0;
      requests: Array<Omit<ModelRequest, "onTextDelta">> = [];
      async complete(request: ModelRequest): Promise<ModelResponse> {
        this.calls += 1;
        const { onTextDelta: _onTextDelta, ...serializableRequest } = request;
        this.requests.push(structuredClone(serializableRequest));
        if (this.calls === 1) {
          return {
            kind: "tool_calls",
            calls: [
              { id: "question", name: "ask_question", arguments: '{"question":"Choose one"}' },
              { id: "list", name: "list_files", arguments: '{"path":"."}' }
            ]
          };
        }
        if (this.calls === 2) {
          return { kind: "tool_calls", calls: [{ id: "question-2", name: "ask_question", arguments: '{"question":"Choose one"}' }] };
        }
        return finish("Done.");
      }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    const provider = new MixedQuestionProvider();
    const runtime = new AgentRuntime({
      provider,
      model: "fake-model",
      registry: new ToolRegistry().register(new AskQuestionTool()).register(new FinishTaskTool()).register(new ListFilesTool()),
      workspaceRoot: root,
      language: "en",
      maxToolCalls: 20,
      interactive: true,
      askQuestion: async () => ({ selected: [], custom: "A", answer: "A" }),
      signal: new AbortController().signal
    });

    await expect(runtime.run("do work")).resolves.toBe("Done.");
    expect(provider.calls).toBe(3);
    const correctionRequest = provider.requests[1];
    expect(correctionRequest?.messages.filter((message) => message.role === "tool")).toHaveLength(2);
    expect(JSON.stringify(correctionRequest)).toContain("ask_question and finish_task must each be the only Tool call");
  });

  it("fails closed after emitting a clarification event without an interactive terminal", async () => {
    class QuestionProvider implements ModelProvider {
      readonly id = "fake";
      async complete(): Promise<ModelResponse> {
        return { kind: "tool_calls", calls: [{ id: "question", name: "ask_question", arguments: '{"question":"Continue?"}' }] };
      }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      provider: new QuestionProvider(), model: "fake-model", registry: new ToolRegistry().register(new AskQuestionTool()).register(new FinishTaskTool()),
      workspaceRoot: root, language: "en", maxToolCalls: 20, interactive: false,
      signal: new AbortController().signal, onEvent: (event) => events.push(event)
    });

    await expect(runtime.run("do work")).rejects.toMatchObject({ code: "INTERACTION_REQUIRED" });
    expect(events).toContainEqual(expect.objectContaining({ type: "question_requested" }));
    expect(events.some((event) => event.type === "question_resolved")).toBe(false);
  });

  it("does not open a clarification UI during dry-run", async () => {
    class DryQuestionProvider implements ModelProvider {
      readonly id = "fake";
      calls = 0;
      async complete(): Promise<ModelResponse> {
        this.calls += 1;
        return this.calls === 1
          ? { kind: "tool_calls", calls: [{ id: "question", name: "ask_question", arguments: '{"question":"Continue?"}' }] }
          : finish("Preview complete.");
      }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      provider: new DryQuestionProvider(), model: "fake-model", registry: new ToolRegistry().register(new AskQuestionTool()).register(new FinishTaskTool()),
      workspaceRoot: root, language: "en", maxToolCalls: 20, interactive: true, dryRun: true,
      askQuestion: async () => { throw new Error("Question UI must not open in dry-run"); },
      signal: new AbortController().signal, onEvent: (event) => events.push(event)
    });

    await expect(runtime.run("do work")).resolves.toBe("Preview complete.");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_preview", name: "ask_question" }));
    expect(events.some((event) => event.type === "question_requested")).toBe(false);
  });

  it("does not apply the per-Tool timeout while waiting for a clarification", async () => {
    class SlowQuestionProvider implements ModelProvider {
      readonly id = "fake";
      calls = 0;
      async complete(): Promise<ModelResponse> {
        this.calls += 1;
        return this.calls === 1
          ? { kind: "tool_calls", calls: [{ id: "question", name: "ask_question", arguments: '{"question":"Continue?"}' }] }
          : finish("Continued.");
      }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    const runtime = new AgentRuntime({
      provider: new SlowQuestionProvider(), model: "fake-model", registry: new ToolRegistry().register(new AskQuestionTool()).register(new FinishTaskTool()),
      workspaceRoot: root, language: "en", maxToolCalls: 20, interactive: true, toolTimeoutMs: 1,
      askQuestion: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        return { selected: [], custom: "yes", answer: "yes" };
      },
      signal: new AbortController().signal
    });

    await expect(runtime.run("do work")).resolves.toBe("Continued.");
  });

  it("returns invalid Tool arguments to the model without executing", async () => {
    class InvalidProvider implements ModelProvider {
      readonly id = "fake";
      calls = 0;
      async complete(): Promise<ModelResponse> {
        this.calls += 1;
        return this.calls === 1
          ? { kind: "tool_calls", calls: [{ id: "bad", name: "list_files", arguments: "not json" }] }
          : finish("无法执行：参数无效");
      }
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    const runtime = new AgentRuntime({
      provider: new InvalidProvider(),
      model: "fake-model",
      registry: new ToolRegistry().register(new ListFilesTool()).register(new FinishTaskTool()),
      workspaceRoot: root,
      language: "zh-CN",
      maxToolCalls: 20,
      signal: new AbortController().signal
    });

    await expect(runtime.run("列出文件")).resolves.toBe("无法执行：参数无效");
  });

  it("returns every invalid call from one model turn before asking the model to correct itself", async () => {
    class MultipleInvalidProvider implements ModelProvider {
      readonly id = "fake";
      calls = 0;
      lastMessages?: AgentMessage[];
      async complete(request: ModelRequest): Promise<ModelResponse> {
        this.calls += 1;
        this.lastMessages = structuredClone(request.messages);
        return this.calls === 1
          ? {
              kind: "tool_calls",
              calls: ["one.txt", "two.txt", "three.txt"].map((file, index) => ({
                id: `bad-${index}`,
                name: "list_files",
                arguments: JSON.stringify({ path: file })
              }))
            }
          : finish("Those are files; I should use read_file for their contents.");
      }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    await Promise.all(["one.txt", "two.txt", "three.txt"].map((file) => writeFile(path.join(root, file), "test")));
    const provider = new MultipleInvalidProvider();
    const runtime = new AgentRuntime({
      provider, model: "fake-model", registry: new ToolRegistry().register(new ListFilesTool()).register(new FinishTaskTool()), workspaceRoot: root,
      language: "en", maxToolCalls: 20, signal: new AbortController().signal
    });
    await expect(runtime.run("inspect files")).resolves.toContain("read_file");
    expect(provider.calls).toBe(2);
    expect(provider.lastMessages?.filter((message) => message.role === "tool")).toHaveLength(3);
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
          : finish("该工具不可用");
      }
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    const provider = new UnknownToolProvider();
    const runtime = new AgentRuntime({
      provider,
      model: "fake-model",
      registry: new ToolRegistry().register(new ListFilesTool()).register(new FinishTaskTool()),
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
          : finish("完成");
      }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      provider: new HighRiskProvider(),
      model: "fake-model",
      registry: new ToolRegistry().register(highRiskTool).register(new FinishTaskTool()),
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

  it("can collect one explicit confirmation for a batch while authorizing every action", async () => {
    let executed = 0;
    const highRiskTool: Tool<Record<string, never>, { id: string }> = {
      definition: { type: "function", function: { name: "batch_risk_test", description: "test", parameters: { type: "object" } } },
      defaultRisk: "high",
      possibleEffects: ["write"],
      parse: () => ({}),
      prepare: async (): Promise<PreparedAction<{ id: string }>> => ({
        id: randomUUID(), toolName: "batch_risk_test", riskLevel: "high", summary: "Write test data", targets: [], effects: ["write"],
        payload: { id: randomUUID() }, expiresAt: new Date(Date.now() + 60_000).toISOString()
      }),
      execute: async (): Promise<ToolResult> => {
        executed += 1;
        return { success: true, message: "done", effects: ["write"] };
      }
    };
    class BatchProvider implements ModelProvider {
      readonly id = "fake";
      calls = 0;
      async complete(): Promise<ModelResponse> {
        this.calls += 1;
        return this.calls === 1
          ? { kind: "tool_calls", calls: [
            { id: "batch-1", name: "batch_risk_test", arguments: "{}" },
            { id: "batch-2", name: "batch_risk_test", arguments: "{}" }
          ] }
          : finish("done");
      }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-agent-test-"));
    created.push(root);
    let batchPrompts = 0;
    const confirmation: ConfirmationHandler = Object.assign(async () => true, {
      confirmBatch: async (requests: unknown[]) => {
        batchPrompts += 1;
        return requests.length === 2;
      }
    });
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      provider: new BatchProvider(), model: "fake", registry: new ToolRegistry().register(highRiskTool).register(new FinishTaskTool()), workspaceRoot: root,
      language: "en", maxToolCalls: 2, signal: new AbortController().signal, interactive: true, confirm: confirmation,
      onEvent: (event) => events.push(event)
    });
    await expect(runtime.run("batch")).resolves.toBe("done");
    expect(batchPrompts).toBe(1);
    expect(executed).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "confirmation_batch_requested" }));
  });
});
