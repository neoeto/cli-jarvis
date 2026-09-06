import { randomUUID } from "node:crypto";
import { appendFile, chmod, lstat, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveDestinationPath, resolveExistingPath } from "../../policy/paths.js";
import { sensitivePathReason } from "../../policy/sensitive-data.js";
import { CjError } from "../../shared/errors.js";
import type { PreparedAction, Tool, ToolContext, ToolResult } from "../types.js";

const inputSchema = z
  .object({
    path: z.string().min(1),
    operation: z.enum(["create", "overwrite", "append"]),
    content: z.string().max(2 * 1024 * 1024)
  })
  .strict();

type WriteFileInput = z.infer<typeof inputSchema>;

interface FileSnapshot {
  size: number;
  modifiedMs: number;
  mode: number;
}

interface WriteFilePayload extends WriteFileInput {
  target: string;
  snapshot?: FileSnapshot;
}

async function existingSnapshot(file: string): Promise<FileSnapshot | undefined> {
  try {
    const metadata = await lstat(file);
    return { size: metadata.size, modifiedMs: metadata.mtimeMs, mode: metadata.mode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertUnchanged(expected: FileSnapshot, actual: FileSnapshot | undefined, file: string): void {
  if (!actual || expected.size !== actual.size || expected.modifiedMs !== actual.modifiedMs) {
    throw new CjError("TOOL_FAILED", `File changed after preview: ${file}`);
  }
}

export class WriteFileTool implements Tool<WriteFileInput, WriteFilePayload> {
  readonly defaultRisk = "medium" as const;
  readonly possibleEffects = ["write"] as const;
  readonly definition = {
    type: "function" as const,
    function: {
      name: "write_file",
      description:
        "Create, append to, or overwrite one UTF-8 text file. The operation must be explicit. Overwrite and writes outside the workspace require confirmation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path", "operation", "content"],
        properties: {
          path: { type: "string", minLength: 1 },
          operation: { type: "string", enum: ["create", "overwrite", "append"] },
          content: { type: "string", maxLength: 2097152 }
        }
      }
    }
  };

  parse(input: unknown): WriteFileInput {
    return inputSchema.parse(input);
  }

  async prepare(input: WriteFileInput, context: ToolContext): Promise<PreparedAction<WriteFilePayload>> {
    const destination = await resolveDestinationPath(context.workspaceRoot, input.path);
    let target = destination.path;
    let external = destination.external;
    let snapshot = await existingSnapshot(target);

    if (snapshot) {
      const resolved = await resolveExistingPath(context.workspaceRoot, input.path);
      target = resolved.path;
      external = resolved.external;
      snapshot = await existingSnapshot(target);
    }
    if (input.operation === "create" && snapshot) {
      throw new CjError("TOOL_INPUT_INVALID", `File already exists: ${input.path}`);
    }
    if (input.operation !== "create" && !snapshot) {
      throw new CjError("TOOL_INPUT_INVALID", `File does not exist: ${input.path}`);
    }
    if (snapshot && !(await lstat(target)).isFile()) {
      throw new CjError("TOOL_INPUT_INVALID", `Not a regular file: ${input.path}`);
    }

    const sensitive = sensitivePathReason(target);
    const highRisk = external || input.operation === "overwrite" || Boolean(sensitive);
    return {
      id: randomUUID(),
      toolName: "write_file",
      riskLevel: highRisk ? "high" : "medium",
      summary: context.language === "zh-CN"
        ? `${input.operation === "create" ? "创建" : input.operation === "append" ? "追加" : "覆盖"} UTF-8 文件 ${input.path}（${Buffer.byteLength(input.content)} 字节）${sensitive ? `；敏感目标：${sensitive}` : ""}`
        : `${input.operation} UTF-8 file ${input.path} (${Buffer.byteLength(input.content)} bytes)${sensitive ? `; sensitive target: ${sensitive}` : ""}`,
      targets: [target],
      effects: ["write"],
      reversible: input.operation !== "overwrite",
      payload: { ...input, target, ...(snapshot ? { snapshot } : {}) },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }

  async execute(action: PreparedAction<WriteFilePayload>, context: ToolContext): Promise<ToolResult> {
    if (context.signal.aborted) throw context.signal.reason;
    const { operation, target, content, snapshot } = action.payload;
    const current = await existingSnapshot(target);

    if (operation === "create") {
      if (current) throw new CjError("TOOL_FAILED", `Target appeared after preview: ${target}`);
      await writeFile(target, content, { encoding: "utf8", flag: "wx" });
    } else if (operation === "append") {
      assertUnchanged(snapshot!, current, target);
      await appendFile(target, content, "utf8");
    } else {
      assertUnchanged(snapshot!, current, target);
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, content, { encoding: "utf8", mode: snapshot!.mode });
        if (process.platform !== "win32") await chmod(temporary, snapshot!.mode & 0o777);
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    }

    return {
      success: true,
      message: context.language === "zh-CN"
        ? `${action.payload.path} 的${operation === "create" ? "创建" : operation === "append" ? "追加" : "覆盖"}操作已完成`
        : `${operation} completed for ${action.payload.path}`,
      effects: [`${operation} file ${target}`]
    };
  }
}
