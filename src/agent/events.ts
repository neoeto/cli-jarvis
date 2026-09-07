import type { RecoveryInfo, RiskLevel } from "../tools/types.js";
import type { ConfirmationRequest } from "../policy/engine.js";

export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "task_status"; taskId: string; status: TaskStatus; detail?: string }
  | { type: "task_step"; taskId: string; stepId: string; tool: string; status: "queued" | "prepared" | "running" | "completed" | "failed" | "skipped"; dependsOn: string[]; detail?: string }
  | { type: "tool_start"; name: string; summary: string; riskLevel: RiskLevel }
  | { type: "tool_preview"; name: string; summary: string; riskLevel: RiskLevel }
  | { type: "tool_result"; name: string; success: boolean; message: string; durationMs: number; data?: unknown; recovery?: RecoveryInfo }
  | { type: "confirmation_requested"; request: ConfirmationRequest }
  | { type: "confirmation_resolved"; actionId: string; approved: boolean }
  | { type: "confirmation_batch_requested"; requests: ConfirmationRequest[] }
  | { type: "confirmation_batch_resolved"; actionIds: string[]; approved: boolean }
  | { type: "assistant_delta"; content: string }
  | { type: "assistant"; content: string; streamed?: boolean }
  | { type: "memory_used"; ids: string[]; purpose: string };

export type TaskStatus = "queued" | "planning" | "waiting_confirmation" | "running" | "completed" | "failed" | "cancelled";

export type EventSink = (event: AgentEvent) => void | Promise<void>;
