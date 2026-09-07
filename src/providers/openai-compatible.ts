import OpenAI from "openai";
import { CjError } from "../shared/errors.js";
import type {
  AgentMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse
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
          ...this.extraBody
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
      const stream = await this.client.chat.completions.create(
        body,
        { signal }
      );
      let content = "";
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      let streamed = false;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
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
          calls: normalized,
          ...(content ? { content } : {})
        };
      }
      if (!content) {
        throw new CjError("MODEL_RESPONSE_INVALID", "Provider returned neither text nor Tool calls");
      }
      return { kind: "message", content, streamed };
    } catch (error) {
      if (error instanceof CjError) throw error;
      if (signal.aborted) throw new CjError("ABORTED", "Task aborted", { cause: error });
      throw new CjError("PROVIDER_UNAVAILABLE", `${this.id} request failed`, { cause: error });
    }
  }
}
