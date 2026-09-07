import { CjError } from "../shared/errors.js";
import type { PreparedAction, RiskLevel } from "../tools/types.js";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { isPathWithin } from "./paths.js";

export interface ConfirmationRequest {
  actionId: string;
  toolName: string;
  summary: string;
  targets: string[];
  effects: string[];
  reversible?: boolean;
}

export type ConfirmationHandler = ((
  request: ConfirmationRequest,
  signal: AbortSignal
) => Promise<boolean>) & {
  /** Optional one-prompt UI for several already-previewed actions. */
  confirmBatch?: (requests: ConfirmationRequest[], signal: AbortSignal) => Promise<boolean>;
};

export interface PolicyDecision {
  effectiveRisk: RiskLevel;
  confirmation?: ConfirmationRequest;
}

export interface AuthorizationContext {
  interactive: boolean;
  signal: AbortSignal;
  confirm?: ConfirmationHandler;
}

export class PolicyEngine {
  constructor(private readonly options: { workspaceRoot?: string; allowedRoots?: string[] } = {}) {}

  evaluate(action: PreparedAction): PolicyDecision {
    this.assertTargetsAuthorized(action);
    const effectiveRisk: RiskLevel = action.toolName === "run_command" ? "high" : action.riskLevel;
    if (effectiveRisk !== "high") return { effectiveRisk };
    return {
      effectiveRisk,
      confirmation: {
        actionId: action.id,
        toolName: action.toolName,
        summary: action.summary,
        targets: action.targets,
        effects: action.effects,
        ...(action.reversible === undefined ? {} : { reversible: action.reversible })
      }
    };
  }

  private assertTargetsAuthorized(action: PreparedAction): void {
    if (!this.options.workspaceRoot || !this.options.allowedRoots) return;
    for (const target of action.targets) {
      // Tool targets may also contain descriptive identifiers such as a remote
      // service. Filesystem targets must be absolute and inside a configured,
      // workspace-bounded root.
      if (!path.isAbsolute(target)) continue;
      if (!isPathWithin(this.options.workspaceRoot, target) || !this.options.allowedRoots.some((root) => isPathWithin(root, target))) {
        throw new CjError("PATH_NOT_AUTHORIZED", `Target is outside the authorized workspace roots: ${target}`);
      }
    }
  }

  /** Re-resolve filesystem targets immediately before execution to catch a symlink/junction swap after preview. */
  async revalidate(action: PreparedAction): Promise<void> {
    if (!this.options.workspaceRoot || !this.options.allowedRoots) return;
    const resolvedTargets: string[] = [];
    for (const target of action.targets) {
      if (!path.isAbsolute(target)) {
        resolvedTargets.push(target);
        continue;
      }
      try {
        resolvedTargets.push(await realpath(target));
      } catch {
        try {
          const parent = await realpath(path.dirname(target));
          resolvedTargets.push(path.join(parent, path.basename(target)));
        } catch (error) {
          throw new CjError("TOOL_FAILED", `Target parent changed after preview: ${target}`, { cause: error });
        }
      }
    }
    this.assertTargetsAuthorized({ ...action, targets: resolvedTargets });
  }

  async authorize(decision: PolicyDecision, context: AuthorizationContext): Promise<void> {
    if (!decision.confirmation) return;
    if (!context.interactive || !context.confirm) {
      throw new CjError(
        "CONFIRMATION_REQUIRED",
        `The operation ${decision.confirmation.toolName} requires an interactive confirmation`
      );
    }
    if (context.signal.aborted) throw new CjError("ABORTED", "Task aborted");
    const approved = await context.confirm(decision.confirmation, context.signal);
    if (!approved) {
      throw new CjError("CONFIRMATION_REJECTED", "The user rejected the operation");
    }
  }

  /**
   * Keep authorization per action while letting an interactive UI collect one
   * answer for a contiguous, already prepared group. There is no implicit
   * approval: a batch is rejected unless its one explicit prompt is approved.
   */
  async authorizeBatch(decisions: PolicyDecision[], context: AuthorizationContext): Promise<void> {
    const requests = decisions.flatMap((decision) => decision.confirmation ? [decision.confirmation] : []);
    if (requests.length === 0) return;
    if (!context.interactive || !context.confirm) {
      throw new CjError("CONFIRMATION_REQUIRED", `The operation ${requests[0]?.toolName ?? "Tool"} requires an interactive confirmation`);
    }
    if (context.signal.aborted) throw new CjError("ABORTED", "Task aborted");
    if (requests.length === 1 || !context.confirm.confirmBatch) {
      for (const decision of decisions) await this.authorize(decision, context);
      return;
    }
    const approved = await context.confirm.confirmBatch(requests, context.signal);
    if (!approved) throw new CjError("CONFIRMATION_REJECTED", "The user rejected the operation batch");
  }
}
