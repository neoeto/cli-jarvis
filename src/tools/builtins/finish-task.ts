import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PreparedAction, Tool, ToolContext, ToolResult } from "../types.js";

const inputSchema = z.object({
  answer: z.string().trim().min(1).max(20_000)
}).strict();

type FinishTaskInput = z.infer<typeof inputSchema>;

/**
 * A host-recognized terminal action. Requiring this Tool makes completion an
 * explicit part of the model protocol instead of inferring it from free text.
 */
export class FinishTaskTool implements Tool<FinishTaskInput, FinishTaskInput, { answer: string }> {
  readonly defaultRisk = "low" as const;
  readonly possibleEffects = [] as const;
  readonly definition = {
    type: "function" as const,
    function: {
      name: "finish_task",
      description: "Finish the current task and deliver the final answer to the user. Call this alone, only when no more Tool calls or user input are needed. Put the complete user-visible answer in answer.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          answer: { type: "string", description: "Complete final answer for the user (maximum 20,000 characters)" }
        },
        required: ["answer"]
      }
    }
  };

  parse(input: unknown): FinishTaskInput {
    return inputSchema.parse(input);
  }

  async prepare(input: FinishTaskInput, _context: ToolContext): Promise<PreparedAction<FinishTaskInput>> {
    return {
      id: randomUUID(),
      toolName: "finish_task",
      riskLevel: "low",
      summary: "Finish the current task",
      targets: [],
      effects: [],
      reversible: true,
      payload: input,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }

  async execute(action: PreparedAction<FinishTaskInput>, _context: ToolContext): Promise<ToolResult<{ answer: string }>> {
    return {
      success: true,
      message: "Task finished",
      effects: [],
      data: { answer: action.payload.answer }
    };
  }
}
