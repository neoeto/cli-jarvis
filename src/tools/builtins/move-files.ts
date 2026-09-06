import { randomUUID } from "node:crypto";
import { lstat, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { resolveDestinationPath, resolveExistingPath } from "../../policy/paths.js";
import { CjError } from "../../shared/errors.js";
import type { PreparedAction, Tool, ToolContext, ToolResult } from "../types.js";

const inputSchema = z
  .object({
    moves: z
      .array(
        z.object({
          source: z.string().min(1),
          destination: z.string().min(1)
        }).strict()
      )
      .min(1)
      .max(100),
    overwrite: z.boolean().default(false)
  })
  .strict();

type MoveFilesInput = z.infer<typeof inputSchema>;

interface PreparedMove {
  source: string;
  destination: string;
  sourceSize: number;
  sourceModifiedMs: number;
  destinationExisted: boolean;
}

interface MoveFilesPayload {
  moves: PreparedMove[];
  overwrite: boolean;
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

export class MoveFilesTool implements Tool<MoveFilesInput, MoveFilesPayload> {
  readonly defaultRisk = "medium" as const;
  readonly possibleEffects = ["move", "delete"] as const;
  readonly definition = {
    type: "function" as const,
    function: {
      name: "move_files",
      description:
        "Move or rename files and directories. Existing destinations are rejected unless overwrite=true; overwriting and external paths require confirmation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["moves"],
        properties: {
          moves: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["source", "destination"],
              properties: {
                source: { type: "string", minLength: 1 },
                destination: { type: "string", minLength: 1 }
              }
            }
          },
          overwrite: { type: "boolean", default: false }
        }
      }
    }
  };

  parse(input: unknown): MoveFilesInput {
    return inputSchema.parse(input);
  }

  async prepare(input: MoveFilesInput, context: ToolContext): Promise<PreparedAction<MoveFilesPayload>> {
    const prepared: PreparedMove[] = [];
    let highRisk = false;
    for (const item of input.moves) {
      const source = await resolveExistingPath(context.workspaceRoot, item.source);
      const destination = await resolveDestinationPath(context.workspaceRoot, item.destination);
      if (source.path === destination.path) {
        throw new CjError("TOOL_INPUT_INVALID", `Source and destination are the same: ${item.source}`);
      }
      const metadata = await lstat(source.path);
      const destinationExisted = await exists(destination.path);
      if (destinationExisted && !input.overwrite) {
        throw new CjError("TOOL_INPUT_INVALID", `Destination already exists: ${item.destination}`);
      }
      highRisk ||= source.external || destination.external || destinationExisted;
      prepared.push({
        source: source.path,
        destination: destination.path,
        sourceSize: metadata.size,
        sourceModifiedMs: metadata.mtimeMs,
        destinationExisted
      });
    }
    return {
      id: randomUUID(),
      toolName: "move_files",
      riskLevel: highRisk ? "high" : "medium",
      summary: context.language === "zh-CN"
        ? `移动 ${prepared.length} 个条目${input.overwrite ? "，允许覆盖目标" : ""}`
        : `Move ${prepared.length} item${prepared.length === 1 ? "" : "s"}${input.overwrite ? " with destination overwrite enabled" : ""}`,
      targets: prepared.flatMap((item) => [item.source, item.destination]),
      effects: input.overwrite ? ["move", "delete"] : ["move"],
      reversible: !input.overwrite,
      payload: { moves: prepared, overwrite: input.overwrite },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }

  async execute(action: PreparedAction<MoveFilesPayload>, context: ToolContext): Promise<ToolResult> {
    const effects: string[] = [];
    for (const item of action.payload.moves) {
      if (context.signal.aborted) throw context.signal.reason;
      const current = await lstat(item.source).catch(() => undefined);
      if (!current || current.size !== item.sourceSize || current.mtimeMs !== item.sourceModifiedMs) {
        throw new CjError("TOOL_FAILED", `Source changed after preview: ${item.source}`);
      }
      const destinationExists = await exists(item.destination);
      if (destinationExists !== item.destinationExisted) {
        throw new CjError("TOOL_FAILED", `Destination changed after preview: ${item.destination}`);
      }
      if (destinationExists && action.payload.overwrite) {
        await rm(item.destination, { recursive: true, force: false });
        effects.push(`Removed existing destination ${item.destination}`);
      }
      await rename(item.source, item.destination);
      effects.push(`Moved ${item.source} to ${item.destination}`);
    }
    return {
      success: true,
      message: context.language === "zh-CN"
        ? `已移动 ${action.payload.moves.length} 个条目`
        : `Moved ${action.payload.moves.length} item${action.payload.moves.length === 1 ? "" : "s"}`,
      effects
    };
  }
}
