import { randomUUID } from "node:crypto";
import { CjError } from "../shared/errors.js";
import { PolicyEngine, type ConfirmationHandler } from "../policy/engine.js";
import type { AgentMessage, ModelProvider } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import type { EventSink } from "./events.js";
import { createSystemPrompt } from "./system-prompt.js";

export interface AgentRuntimeOptions {
  provider: ModelProvider;
  model: string;
  registry: ToolRegistry;
  workspaceRoot: string;
  language: "zh-CN" | "en";
  maxToolCalls: number;
  signal: AbortSignal;
  interactive?: boolean;
  confirm?: ConfirmationHandler;
  policy?: PolicyEngine;
  onEvent?: EventSink;
}

function parseArguments(raw: string, toolName: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CjError("TOOL_INPUT_INVALID", `Invalid JSON arguments for ${toolName}`, { cause: error });
  }
}

function serializableResult(result: ToolResult): string {
  return JSON.stringify({
    success: result.success,
    message: result.message,
    effects: result.effects,
    ...(result.data === undefined ? {} : { data: result.data })
  });
}

export class AgentRuntime {
  constructor(private readonly options: AgentRuntimeOptions) {}

  async run(prompt: string): Promise<string> {
    const { provider, model, registry, workspaceRoot, language, maxToolCalls, signal } = this.options;
    const emit: EventSink = this.options.onEvent ?? (() => undefined);
    const policy = this.options.policy ?? new PolicyEngine();
    const messages: AgentMessage[] = [
      { role: "system", content: createSystemPrompt(workspaceRoot, language) },
      { role: "user", content: prompt }
    ];
    const context: ToolContext = { workspaceRoot, signal, language };
    let executedCalls = 0;
    let invalidCalls = 0;

    await emit({ type: "status", message: language === "zh-CN" ? "正在理解任务…" : "Understanding task…" });

    while (true) {
      if (signal.aborted) throw new CjError("ABORTED", "Task aborted");
      const response = await provider.complete(
        {
          model,
          messages,
          tools: registry.definitions(),
          toolChoice: "auto",
          onTextDelta: async (content) => emit({ type: "assistant_delta", content })
        },
        signal
      );

      if (response.kind === "message") {
        messages.push({ role: "assistant", content: response.content });
        await emit({
          type: "assistant",
          content: response.content,
          ...(response.streamed === undefined ? {} : { streamed: response.streamed })
        });
        return response.content;
      }

      messages.push({
        role: "assistant",
        content: response.content ?? null,
        toolCalls: response.calls
      });

      for (const call of response.calls) {
        const callStartedAt = performance.now();
        if (executedCalls >= maxToolCalls) {
          throw new CjError("LIMIT_EXCEEDED", `Maximum Tool call count (${maxToolCalls}) exceeded`);
        }
        let result: ToolResult;
        try {
          const tool = registry.get(call.name);
          const parsed = tool.parse(parseArguments(call.arguments, call.name));
          const action = await tool.prepare(parsed, context);
          if (new Date(action.expiresAt).getTime() <= Date.now()) {
            throw new CjError("TOOL_FAILED", `Prepared action expired: ${action.id}`);
          }
          const decision = policy.evaluate(action);
          await emit({
            type: "tool_start",
            name: call.name,
            summary: action.summary,
            riskLevel: decision.effectiveRisk
          });
          if (decision.confirmation) {
            await emit({ type: "confirmation_requested", request: decision.confirmation });
            try {
              await policy.authorize(decision, {
                interactive: this.options.interactive ?? false,
                signal,
                ...(this.options.confirm ? { confirm: this.options.confirm } : {})
              });
              await emit({
                type: "confirmation_resolved",
                actionId: decision.confirmation.actionId,
                approved: true
              });
            } catch (error) {
              await emit({
                type: "confirmation_resolved",
                actionId: decision.confirmation.actionId,
                approved: false
              });
              throw error;
            }
          }
          if (new Date(action.expiresAt).getTime() <= Date.now()) {
            throw new CjError("TOOL_FAILED", `Prepared action expired after confirmation: ${action.id}`);
          }
          result = await tool.execute(action, context);
          executedCalls += 1;
          await emit({
            type: "tool_result",
            name: call.name,
            success: result.success,
            message: result.message,
            durationMs: Math.round(performance.now() - callStartedAt),
            ...(result.data === undefined ? {} : { data: result.data })
          });
        } catch (error) {
          if (
            error instanceof CjError &&
            ["CONFIRMATION_REQUIRED", "CONFIRMATION_REJECTED", "ABORTED"].includes(error.code)
          ) {
            throw error;
          }
          invalidCalls += 1;
          const normalized = error instanceof CjError
            ? error
            : new CjError("TOOL_INPUT_INVALID", error instanceof Error ? error.message : String(error), {
                cause: error
              });
          result = { success: false, message: normalized.message, effects: [] };
          await emit({
            type: "tool_result",
            name: call.name,
            success: false,
            message: normalized.message,
            durationMs: Math.round(performance.now() - callStartedAt)
          });
          if (invalidCalls >= 3) {
            throw new CjError("LIMIT_EXCEEDED", "The model produced three invalid Tool calls");
          }
        }

        messages.push({ role: "tool", toolCallId: call.id || randomUUID(), content: serializableResult(result) });
      }
    }
  }
}
