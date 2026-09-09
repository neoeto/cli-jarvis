export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelRequest {
  model: string;
  messages: AgentMessage[];
  tools: ModelToolDefinition[];
  toolChoice: "auto" | "none" | "required";
  onTextDelta?: (delta: string) => void | Promise<void>;
  /** Receives provider-reported cumulative usage snapshots for this request. */
  onUsage?: (usage: ModelUsage) => void | Promise<void>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Input tokens served from a provider context cache. Subset of inputTokens. */
  cachedInputTokens?: number;
  /** Input tokens not served from cache. Subset of inputTokens. */
  uncachedInputTokens?: number;
  /** Reasoning tokens reported by the provider. Subset of outputTokens. */
  reasoningTokens?: number;
}

export type ModelResponse = { reasoning?: string; usage?: ModelUsage } & (
  | { kind: "message"; content: string; streamed?: boolean }
  | { kind: "tool_calls"; calls: ToolCall[]; content?: string }
);

export interface ModelProvider {
  readonly id: string;
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}
