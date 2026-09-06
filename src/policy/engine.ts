import { CjError } from "../shared/errors.js";
import type { PreparedAction, RiskLevel } from "../tools/types.js";

export interface ConfirmationRequest {
  actionId: string;
  toolName: string;
  summary: string;
  targets: string[];
  effects: string[];
  reversible?: boolean;
}

export type ConfirmationHandler = (
  request: ConfirmationRequest,
  signal: AbortSignal
) => Promise<boolean>;

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
  evaluate(action: PreparedAction): PolicyDecision {
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
}
