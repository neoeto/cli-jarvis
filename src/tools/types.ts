import type { ModelToolDefinition } from "../providers/types.js";
import type { SkillCatalog } from "../skills/catalog.js";
import type { QuestionHandler } from "../agent/questions.js";

export type RiskLevel = "low" | "medium" | "high";
export type EffectKind = "read" | "write" | "move" | "trash" | "delete" | "process" | "network" | "git";

/** Host-owned capability for a configured web-search provider. Credentials are resolved only at execution time. */
export interface WebSearchCapability {
  enabled: boolean;
  resolveApiKey: () => Promise<string>;
}

export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
  language?: "zh-CN" | "en";
  /** Bounded host-supplied limits. Tool implementations must not increase them. */
  toolTimeoutMs?: number;
  maxOutputBytes?: number;
  /** Preview mode prepares and validates an action but never calls execute. */
  dryRun?: boolean;
  /** Host-validated Skill catalog available to the built-in read_skill Tool. */
  skillCatalog?: SkillCatalog;
  /** Host-owned interactive clarification handler available only on a TTY. */
  askQuestion?: QuestionHandler;
  /** Optional host-owned web-search configuration and deferred credential resolver. */
  webSearch?: WebSearchCapability;
}

export interface RecoveryInfo {
  /** A Tool-authored recovery hint. The host does not claim that recovery happened. */
  instruction: string;
  /** Optional opaque Tool snapshot identifier, never a credential or file body. */
  snapshotId?: string;
}

export interface PreparedAction<P = unknown> {
  id: string;
  toolName: string;
  riskLevel: RiskLevel;
  summary: string;
  targets: string[];
  effects: EffectKind[];
  reversible?: boolean;
  recovery?: RecoveryInfo;
  payload: P;
  expiresAt: string;
}

export interface ToolResult<O = unknown> {
  success: boolean;
  message: string;
  effects: string[];
  data?: O;
  recovery?: RecoveryInfo;
}

export interface Tool<I = unknown, P = unknown, O = unknown> {
  readonly definition: ModelToolDefinition;
  readonly defaultRisk: RiskLevel;
  readonly possibleEffects: readonly EffectKind[];
  parse(input: unknown): I;
  prepare(input: I, context: ToolContext): Promise<PreparedAction<P>>;
  execute(action: PreparedAction<P>, context: ToolContext): Promise<ToolResult<O>>;
}
