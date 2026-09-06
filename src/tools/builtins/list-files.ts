import { randomUUID } from "node:crypto";
import { lstat, opendir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveExistingPath } from "../../policy/paths.js";
import type { PreparedAction, Tool, ToolContext, ToolResult } from "../types.js";

const inputSchema = z
  .object({
    path: z.string().default("."),
    recursive: z.boolean().default(false),
    maxDepth: z.number().int().min(0).max(10).default(3),
    limit: z.number().int().min(1).max(500).default(100),
    includeHidden: z.boolean().default(false)
  })
  .strict();

type ListFilesInput = z.infer<typeof inputSchema>;

interface ListFilesPayload extends ListFilesInput {
  target: string;
  workspaceRoot: string;
}

export interface FileEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: string;
}

export class ListFilesTool implements Tool<ListFilesInput, ListFilesPayload, { entries: FileEntry[]; truncated: boolean }> {
  readonly defaultRisk = "low" as const;
  readonly possibleEffects = ["read"] as const;
  readonly definition = {
    type: "function" as const,
    function: {
      name: "list_files",
      description: "List files and directories with metadata inside the current workspace. Use recursive mode to inspect nested directories.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Workspace-relative directory path", default: "." },
          recursive: { type: "boolean", default: false },
          maxDepth: { type: "integer", minimum: 0, maximum: 10, default: 3 },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          includeHidden: { type: "boolean", default: false }
        }
      }
    }
  };

  parse(input: unknown): ListFilesInput {
    return inputSchema.parse(input);
  }

  async prepare(input: ListFilesInput, context: ToolContext): Promise<PreparedAction<ListFilesPayload>> {
    const resolved = await resolveExistingPath(context.workspaceRoot, input.path);
    const { workspaceRoot, path: target } = resolved;
    const targetStat = await stat(target);
    if (!targetStat.isDirectory()) throw new Error(`Not a directory: ${input.path}`);
    return {
      id: randomUUID(),
      toolName: "list_files",
      riskLevel: resolved.external ? "high" : "low",
      summary: context.language === "zh-CN"
        ? `${input.recursive ? "递归列出" : "列出"} ${input.path} 中的条目`
        : `List ${input.recursive ? "recursive contents of" : "entries in"} ${input.path}`,
      targets: [target],
      effects: ["read"],
      reversible: true,
      payload: { ...input, target, workspaceRoot },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }

  async execute(
    action: PreparedAction<ListFilesPayload>,
    context: ToolContext
  ): Promise<ToolResult<{ entries: FileEntry[]; truncated: boolean }>> {
    const entries: FileEntry[] = [];
    const { target, workspaceRoot, recursive, maxDepth, limit, includeHidden } = action.payload;
    let truncated = false;

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (context.signal.aborted) throw context.signal.reason;
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (!includeHidden && entry.name.startsWith(".")) continue;
        if (entries.length >= limit) {
          truncated = true;
          break;
        }
        const absolute = path.join(directory, entry.name);
        const metadata = await lstat(absolute, { bigint: false }).catch(() => undefined);
        entries.push({
          path: path.relative(workspaceRoot, absolute) || ".",
          type: entry.isFile()
            ? "file"
            : entry.isDirectory()
              ? "directory"
              : entry.isSymbolicLink()
                ? "symlink"
                : "other",
          size: metadata?.size ?? 0,
          modifiedAt: metadata?.mtime.toISOString() ?? new Date(0).toISOString()
        });
        if (recursive && entry.isDirectory() && depth < maxDepth && entries.length < limit) {
          await visit(absolute, depth + 1);
        }
      }
    };

    await visit(target, 0);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return {
      success: true,
      message: context.language === "zh-CN"
        ? `已列出 ${entries.length} 个条目${truncated ? "（结果已截断）" : ""}`
        : `Listed ${entries.length} entries${truncated ? " (truncated)" : ""}`,
      effects: [`Read directory ${target}`],
      data: { entries, truncated }
    };
  }
}
