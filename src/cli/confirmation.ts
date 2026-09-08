import { confirm as askConfirm } from "@inquirer/prompts";
import type { ConfirmationHandler } from "../policy/engine.js";
import { CjError } from "../shared/errors.js";

function details(request: { summary: string; targets: string[] }): string {
  return [request.summary, ...request.targets.map((target) => `→ ${target}`)].join("\n");
}

export function createTerminalConfirmation(language: "zh-CN" | "en"): ConfirmationHandler {
  const handler: ConfirmationHandler = async (request, signal) => {
    try {
      return await askConfirm(
        {
          message: language === "zh-CN"
            ? `${details(request)}\n确认执行“${request.toolName}”吗？`
            : `${details(request)}\nProceed with “${request.toolName}”?`,
          default: false
        },
        { signal }
      );
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "ExitPromptError")) {
        throw new CjError("ABORTED", "Task aborted", { cause: error });
      }
      throw error;
    }
  };
  handler.confirmBatch = async (requests, signal) => {
    try {
      return await askConfirm(
        {
          message: language === "zh-CN"
            ? `${requests.map(details).join("\n\n")}\n确认执行这 ${requests.length} 个高风险操作吗？`
            : `${requests.map(details).join("\n\n")}\nProceed with these ${requests.length} high-risk operations?`,
          default: false
        },
        { signal }
      );
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "ExitPromptError")) {
        throw new CjError("ABORTED", "Task aborted", { cause: error });
      }
      throw error;
    }
  };
  return handler;
}
