/**
 * Public local Tool SDK surface. A local tool is opt-in and is still wrapped
 * by the host's validation, risk, confirmation, timeout, output and audit
 * controls. Tool code itself runs with the current user's OS permissions.
 */
export type {
  EffectKind,
  PreparedAction,
  RecoveryInfo,
  RiskLevel,
  Tool,
  ToolContext,
  ToolResult
} from "./types.js";
export type { ModelToolDefinition } from "../providers/types.js";

export const TOOL_SDK_VERSION = 1;
