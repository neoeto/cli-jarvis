import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CjError } from "../../shared/errors.js";
import type { QuestionAnswer, QuestionRequest } from "../../agent/questions.js";
import type { PreparedAction, Tool, ToolContext, ToolResult } from "../types.js";

const optionSchema = z.object({
  label: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(400).optional()
}).strict();

const inputSchema = z.object({
  question: z.string().trim().min(1).max(1_200),
  options: z.array(optionSchema).min(1).max(8).optional(),
  multiple: z.boolean().default(false)
}).strict().superRefine((input, context) => {
  const labels = new Set<string>();
  for (const [index, option] of (input.options ?? []).entries()) {
    const normalized = option.label.toLocaleLowerCase();
    if (labels.has(normalized)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["options", index, "label"], message: "Option labels must be unique" });
    }
    labels.add(normalized);
  }
});

type AskQuestionInput = z.infer<typeof inputSchema>;

export class AskQuestionTool implements Tool<AskQuestionInput, QuestionRequest, QuestionAnswer> {
  readonly defaultRisk = "low" as const;
  readonly possibleEffects = [] as const;
  readonly definition = {
    type: "function" as const,
    function: {
      name: "ask_question",
      description: "Ask the user one material clarification question and wait for an answer. Use this instead of ending a response with a question. Call it alone: never combine it with another Tool call. Options are optional; the host always permits a free-text answer.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string", description: "One clear question for the user (maximum 1200 characters)" },
          options: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            description: "Optional mutually distinguishable choices. The user may still enter custom text.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: "string", description: "Choice label" },
                description: { type: "string", description: "Optional brief explanation" }
              },
              required: ["label"]
            }
          },
          multiple: { type: "boolean", default: false, description: "Allow choosing more than one predefined option" }
        },
        required: ["question"]
      }
    }
  };

  parse(input: unknown): AskQuestionInput {
    return inputSchema.parse(input);
  }

  async prepare(input: AskQuestionInput): Promise<PreparedAction<QuestionRequest>> {
    const request: QuestionRequest = {
      question: input.question,
      options: (input.options ?? []).map((option) => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description })
      })),
      multiple: input.multiple
    };
    return {
      id: randomUUID(),
      toolName: "ask_question",
      riskLevel: "low",
      summary: "Request a material clarification from the user",
      targets: [],
      effects: [],
      reversible: true,
      payload: request,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }

  async execute(action: PreparedAction<QuestionRequest>, context: ToolContext): Promise<ToolResult<QuestionAnswer>> {
    if (!context.askQuestion) {
      throw new CjError("INTERACTION_REQUIRED", "The model requested user input, but this command is not running in an interactive terminal");
    }
    const answer = await context.askQuestion(action.payload, context.signal);
    return {
      success: true,
      message: context.language === "zh-CN" ? "已收到用户回答" : "Received user answer",
      effects: [],
      data: answer
    };
  }
}
