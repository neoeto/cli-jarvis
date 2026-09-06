import type { RiskLevel } from "../tools/types.js";
import type { ConfirmationRequest } from "../policy/engine.js";

export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "tool_start"; name: string; summary: string; riskLevel: RiskLevel }
  | { type: "tool_result"; name: string; success: boolean; message: string; durationMs: number; data?: unknown }
  | { type: "confirmation_requested"; request: ConfirmationRequest }
  | { type: "confirmation_resolved"; actionId: string; approved: boolean }
  | { type: "assistant_delta"; content: string }
  | { type: "assistant"; content: string; streamed?: boolean };

export type EventSink = (event: AgentEvent) => void | Promise<void>;
