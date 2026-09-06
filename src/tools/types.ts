import type { ModelToolDefinition } from "../providers/types.js";

export type RiskLevel = "low" | "medium" | "high";
export type EffectKind = "read" | "write" | "move" | "trash" | "delete" | "process" | "network" | "git";

export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
  language?: "zh-CN" | "en";
}

export interface PreparedAction<P = unknown> {
  id: string;
  toolName: string;
  riskLevel: RiskLevel;
  summary: string;
  targets: string[];
  effects: EffectKind[];
  reversible?: boolean;
  payload: P;
  expiresAt: string;
}

export interface ToolResult<O = unknown> {
  success: boolean;
  message: string;
  effects: string[];
  data?: O;
}

export interface Tool<I = unknown, P = unknown, O = unknown> {
  readonly definition: ModelToolDefinition;
  readonly defaultRisk: RiskLevel;
  readonly possibleEffects: readonly EffectKind[];
  parse(input: unknown): I;
  prepare(input: I, context: ToolContext): Promise<PreparedAction<P>>;
  execute(action: PreparedAction<P>, context: ToolContext): Promise<ToolResult<O>>;
}
