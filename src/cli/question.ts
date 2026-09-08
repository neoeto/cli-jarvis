import { checkbox, input, select } from "@inquirer/prompts";
import type { QuestionAnswer, QuestionHandler, QuestionRequest } from "../agent/questions.js";
import { CjError } from "../shared/errors.js";

const CUSTOM_VALUE = "__cj_custom_answer__";

function answerSummary(selected: string[], custom: string | undefined): string {
  if (selected.length && custom) return `Selected options: ${selected.join(", ")}\nAdditional input: ${custom}`;
  if (selected.length) return `Selected options: ${selected.join(", ")}`;
  return custom ?? "";
}

async function customInput(language: "zh-CN" | "en", signal: AbortSignal): Promise<string> {
  return (await input(
    {
      message: language === "zh-CN" ? "请输入你的回答：" : "Enter your answer:",
      required: true,
      validate: (value) => value.trim().length > 0 && value.length <= 4_000
        ? true
        : (language === "zh-CN" ? "请输入 1–4000 个字符。" : "Enter between 1 and 4000 characters.")
    },
    { signal }
  )).trim();
}

/** Create the host-owned terminal UI used by the ask_question Tool. */
export function createTerminalQuestion(language: "zh-CN" | "en"): QuestionHandler {
  return async (request: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer> => {
    try {
      if (request.options.length === 0) {
        const custom = await input({
          message: request.question,
          required: true,
          validate: (value) => value.trim().length > 0 && value.length <= 4_000
            ? true
            : (language === "zh-CN" ? "请输入 1–4000 个字符。" : "Enter between 1 and 4000 characters.")
        }, { signal });
        const trimmed = custom.trim();
        return { selected: [], custom: trimmed, answer: trimmed };
      }

      const choices = request.options.map((option, index) => ({
        name: option.label,
        value: String(index),
        ...(option.description ? { description: option.description } : {})
      }));
      const customChoice = {
        name: language === "zh-CN" ? "自行输入" : "Enter a custom answer",
        value: CUSTOM_VALUE
      };

      if (!request.multiple) {
        const selectedValue = await select({ message: request.question, choices: [...choices, customChoice] }, { signal });
        if (selectedValue === CUSTOM_VALUE) {
          const custom = await customInput(language, signal);
          return { selected: [], custom, answer: custom };
        }
        const selected = request.options[Number(selectedValue)]?.label;
        if (!selected) throw new CjError("TOOL_FAILED", "The selected question option was invalid");
        return { selected: [selected], answer: answerSummary([selected], undefined) };
      }

      const selectedValues = await checkbox({
        message: request.question,
        choices: [...choices, customChoice],
        required: true
      }, { signal });
      const needsCustom = selectedValues.includes(CUSTOM_VALUE);
      const selected = selectedValues
        .filter((value) => value !== CUSTOM_VALUE)
        .flatMap((value) => {
          const option = request.options[Number(value)]?.label;
          return option ? [option] : [];
        });
      const custom = needsCustom ? await customInput(language, signal) : undefined;
      return {
        selected,
        ...(custom ? { custom } : {}),
        answer: answerSummary(selected, custom)
      };
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "ExitPromptError")) {
        throw new CjError("ABORTED", "Task aborted", { cause: error });
      }
      throw error;
    }
  };
}
