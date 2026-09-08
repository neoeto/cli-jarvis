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
}

export type ModelResponse = { reasoning?: string } & (
  | { kind: "message"; content: string; streamed?: boolean }
  | { kind: "tool_calls"; calls: ToolCall[]; content?: string }
);

export interface ModelProvider {
  readonly id: string;
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}
