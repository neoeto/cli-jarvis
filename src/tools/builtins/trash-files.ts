import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import trash from "trash";
import { z } from "zod";
import { resolveExistingPath } from "../../policy/paths.js";
import type { PreparedAction, Tool, ToolContext, ToolResult } from "../types.js";

const inputSchema = z
  .object({ paths: z.array(z.string().min(1)).min(1).max(100) })
  .strict();

type TrashFilesInput = z.infer<typeof inputSchema>;

interface TrashTarget {
  path: string;
  size: number;
  modifiedMs: number;
}

interface TrashFilesPayload {
  targets: TrashTarget[];
}

export class TrashFilesTool implements Tool<TrashFilesInput, TrashFilesPayload> {
  readonly defaultRisk = "medium" as const;
  readonly possibleEffects = ["trash", "move"] as const;
  readonly definition = {
    type: "function" as const,
    function: {
      name: "trash_files",
      description:
        "Move files or directories to the operating-system trash/recycle bin. This Tool does not permanently delete them.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["paths"],
        properties: {
          paths: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            uniqueItems: true,
            items: { type: "string", minLength: 1 }
          }
        }
      }
    }
  };

  parse(input: unknown): TrashFilesInput {
    return inputSchema.parse(input);
  }

  async prepare(input: TrashFilesInput, context: ToolContext): Promise<PreparedAction<TrashFilesPayload>> {
    const targets: TrashTarget[] = [];
    let highRisk = false;
    for (const requested of [...new Set(input.paths)]) {
      const resolved = await resolveExistingPath(context.workspaceRoot, requested);
      const metadata = await lstat(resolved.path);
      highRisk ||= resolved.external || metadata.isDirectory() || resolved.path === resolved.workspaceRoot;
      targets.push({ path: resolved.path, size: metadata.size, modifiedMs: metadata.mtimeMs });
    }
    return {
      id: randomUUID(),
      toolName: "trash_files",
      riskLevel: highRisk ? "high" : "medium",
      summary: context.language === "zh-CN"
        ? `将 ${targets.length} 个条目移动到操作系统回收站`
        : `Move ${targets.length} item${targets.length === 1 ? "" : "s"} to the operating-system trash`,
      targets: targets.map((target) => target.path),
      effects: ["trash", "move"],
      reversible: true,
      recovery: { instruction: "Restore the item from the operating-system trash/recycle bin; cj does not claim it has been restored." },
      payload: { targets },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }

  async execute(action: PreparedAction<TrashFilesPayload>, context: ToolContext): Promise<ToolResult> {
    if (context.signal.aborted) throw context.signal.reason;
    for (const target of action.payload.targets) {
      const current = await lstat(target.path).catch(() => undefined);
      if (!current || current.size !== target.size || current.mtimeMs !== target.modifiedMs) {
        throw new Error(`Target changed after preview: ${target.path}`);
      }
    }
    await trash(action.payload.targets.map((target) => target.path));
    return {
      success: true,
      message: context.language === "zh-CN"
        ? `已将 ${action.payload.targets.length} 个条目移动到回收站`
        : `Moved ${action.payload.targets.length} item${action.payload.targets.length === 1 ? "" : "s"} to trash`,
      effects: action.payload.targets.map((target) => `Moved ${target.path} to trash`),
      ...(action.recovery === undefined ? {} : { recovery: action.recovery })
    };
  }
}
