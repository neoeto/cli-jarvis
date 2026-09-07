import { confirm as askConfirm } from "@inquirer/prompts";
import type { ConfirmationHandler } from "../policy/engine.js";
import { CjError } from "../shared/errors.js";

export function createTerminalConfirmation(language: "zh-CN" | "en"): ConfirmationHandler {
  const handler: ConfirmationHandler = async (request, signal) => {
    try {
      return await askConfirm(
        {
          message: language === "zh-CN"
            ? `确认执行“${request.toolName}”吗？`
            : `Proceed with “${request.toolName}”?`,
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
            ? `确认执行这 ${requests.length} 个高风险操作吗？`
            : `Proceed with these ${requests.length} high-risk operations?`,
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
