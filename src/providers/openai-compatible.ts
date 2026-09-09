import OpenAI from "openai";
import { CjError } from "../shared/errors.js";
import type {
  AgentMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelUsage
} from "./types.js";

export interface OpenAICompatibleOptions {
  id: string;
  apiKey: string;
  baseURL: string;
  extraBody?: Record<string, unknown>;
}

function toOpenAIMessages(messages: AgentMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    switch (message.role) {
      case "system":
      case "user":
        return message;
      case "tool":
        return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
      case "assistant":
        return {
          role: "assistant",
          content: message.content,
          ...(message.toolCalls
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: call.arguments }
                }))
              }
            : {})
        };
    }
  });
}

function optionalTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeUsage(raw: OpenAI.Completions.CompletionUsage): ModelUsage {
  const extended = raw as OpenAI.Completions.CompletionUsage & {
    prompt_cache_hit_tokens?: unknown;
    prompt_cache_miss_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  const cachedInputTokens = optionalTokenCount(extended.prompt_cache_hit_tokens)
    ?? optionalTokenCount(raw.prompt_tokens_details?.cached_tokens);
  const uncachedInputTokens = optionalTokenCount(extended.prompt_cache_miss_tokens)
    ?? (cachedInputTokens === undefined ? undefined : Math.max(0, raw.prompt_tokens - cachedInputTokens));
  const reasoningTokens = optionalTokenCount(extended.completion_tokens_details?.reasoning_tokens);
  return {
    inputTokens: raw.prompt_tokens,
    outputTokens: raw.completion_tokens,
    totalTokens: raw.total_tokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens })
  };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly client: OpenAI;
  private readonly extraBody: Record<string, unknown>;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
    this.extraBody = options.extraBody ?? {};
  }

  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    try {
      const body = {
          model: request.model,
          messages: toOpenAIMessages(request.messages),
          ...(request.tools.length
            ? { tools: request.tools, tool_choice: request.toolChoice }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
          ...this.extraBody
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
      const stream = await this.client.chat.completions.create(
        body,
        { signal }
      );
      let content = "";
      let reasoning = "";
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      let streamed = false;
      let usage: ModelUsage | undefined;
      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = normalizeUsage(chunk.usage);
          await request.onUsage?.(usage);
        }
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        const reasoningContent = (delta as typeof delta & { reasoning_content?: unknown }).reasoning_content;
        if (typeof reasoningContent === "string") reasoning += reasoningContent;
        if (delta.content) {
          content += delta.content;
          if (request.onTextDelta) {
            streamed = true;
            await request.onTextDelta(delta.content);
          }
        }
        for (const call of delta.tool_calls ?? []) {
          if (call.type && call.type !== "function") continue;
          const current = calls.get(call.index) ?? { id: "", name: "", arguments: "" };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments) current.arguments += call.function.arguments;
          calls.set(call.index, current);
        }
      }

      if (calls.size) {
        const normalized = [...calls.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, call]) => call);
        if (normalized.some((call) => !call.id || !call.name)) {
          throw new CjError("MODEL_RESPONSE_INVALID", "Provider returned an incomplete Tool call");
        }
        return {
          kind: "tool_calls",
          ...(reasoning ? { reasoning } : {}),
          ...(usage ? { usage } : {}),
          calls: normalized,
          ...(content ? { content } : {})
        };
      }
      if (!content) {
        throw new CjError("MODEL_RESPONSE_INVALID", "Provider returned neither text nor Tool calls");
      }
      return { kind: "message", content, streamed, ...(reasoning ? { reasoning } : {}), ...(usage ? { usage } : {}) };
    } catch (error) {
      if (error instanceof CjError) throw error;
      if (signal.aborted) throw new CjError("ABORTED", "Task aborted", { cause: error });
      throw new CjError("PROVIDER_UNAVAILABLE", `${this.id} request failed`, { cause: error });
    }
  }
}
