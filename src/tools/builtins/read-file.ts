import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveExistingPath } from "../../policy/paths.js";
import { redactSecrets, sensitivePathReason } from "../../policy/sensitive-data.js";
import { CjError } from "../../shared/errors.js";
import type { PreparedAction, Tool, ToolContext, ToolResult } from "../types.js";

const inputSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().min(1).default(1),
    maxLines: z.number().int().min(1).max(2_000).default(400),
    maxBytes: z.number().int().min(1).max(1024 * 1024).default(256 * 1024),
    allowSensitive: z.boolean().default(false)
  })
  .strict();

type ReadFileInput = z.infer<typeof inputSchema>;

interface ReadFilePayload extends ReadFileInput {
  target: string;
  workspaceRoot: string;
  sensitiveReason?: string;
}

interface ReadFileData {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
  redactions: number;
}

async function readBounded(file: string, maxBytes: number): Promise<{ data: Buffer; truncated: boolean }> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { data: buffer.subarray(0, Math.min(bytesRead, maxBytes)), truncated: bytesRead > maxBytes };
  } finally {
    await handle.close();
  }
}

export class ReadFileTool implements Tool<ReadFileInput, ReadFilePayload, ReadFileData> {
  readonly defaultRisk = "low" as const;
  readonly possibleEffects = ["read"] as const;
  readonly definition = {
    type: "function" as const,
    function: {
      name: "read_file",
      description:
        "Read a bounded range of a UTF-8 text file. Secrets are redacted by default. Set allowSensitive only when the task truly requires unredacted sensitive content; that always requires user confirmation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", minLength: 1, description: "Workspace-relative or absolute file path" },
          startLine: { type: "integer", minimum: 1, default: 1 },
          maxLines: { type: "integer", minimum: 1, maximum: 2000, default: 400 },
          maxBytes: { type: "integer", minimum: 1, maximum: 1048576, default: 262144 },
          allowSensitive: { type: "boolean", default: false }
        }
      }
    }
  };

  parse(input: unknown): ReadFileInput {
    return inputSchema.parse(input);
  }

  async prepare(input: ReadFileInput, context: ToolContext): Promise<PreparedAction<ReadFilePayload>> {
    const resolved = await resolveExistingPath(context.workspaceRoot, input.path);
    const metadata = await stat(resolved.path);
    if (!metadata.isFile()) throw new CjError("TOOL_INPUT_INVALID", `Not a regular file: ${input.path}`);
    const sensitiveReason = sensitivePathReason(resolved.path);
    if (sensitiveReason && !input.allowSensitive) {
      throw new CjError(
        "SENSITIVE_DATA_BLOCKED",
        `${input.path} is sensitive (${sensitiveReason}); request allowSensitive only if the user needs its contents`
      );
    }
    const highRisk = resolved.external || input.allowSensitive;
    return {
      id: randomUUID(),
      toolName: "read_file",
      riskLevel: highRisk ? "high" : "low",
      summary: context.language === "zh-CN"
        ? highRisk
          ? `读取 ${input.path} 并将未脱敏内容发送给已配置模型`
          : `读取 ${input.path}`
        : highRisk
          ? `Read ${input.path} and send its unredacted content to the configured model`
          : `Read ${input.path}`,
      targets: [resolved.path],
      effects: ["read"],
      reversible: true,
      payload: {
        ...input,
        target: resolved.path,
        workspaceRoot: resolved.workspaceRoot,
        ...(sensitiveReason ? { sensitiveReason } : {})
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }

  async execute(
    action: PreparedAction<ReadFilePayload>,
    context: ToolContext
  ): Promise<ToolResult<ReadFileData>> {
    if (context.signal.aborted) throw context.signal.reason;
    const maximum = Math.min(action.payload.maxBytes, context.maxOutputBytes ?? action.payload.maxBytes);
    const { data, truncated: byteTruncated } = await readBounded(action.payload.target, maximum);
    if (data.includes(0)) throw new CjError("TOOL_FAILED", `Binary file is not supported: ${action.payload.path}`);
    const decoded = data.toString("utf8");
    const lines = decoded.split(/\r?\n/);
    const startIndex = action.payload.startLine - 1;
    const selected = lines.slice(startIndex, startIndex + action.payload.maxLines);
    const lineTruncated = startIndex + selected.length < lines.length;
    const rawContent = selected.join("\n");
    const redacted = action.payload.allowSensitive
      ? { value: rawContent, redactions: 0 }
      : redactSecrets(rawContent);
    const relative = path.relative(action.payload.workspaceRoot, action.payload.target);
    return {
      success: true,
      message: context.language === "zh-CN"
        ? `已从 ${action.payload.path} 读取 ${selected.length} 行${byteTruncated || lineTruncated ? "（内容已截断）" : ""}`
        : `Read ${selected.length} lines from ${action.payload.path}${byteTruncated || lineTruncated ? " (truncated)" : ""}`,
      effects: [`Read file ${action.payload.target}`],
      data: {
        path: relative && !relative.startsWith("..") ? relative : action.payload.target,
        content: redacted.value,
        startLine: action.payload.startLine,
        endLine: action.payload.startLine + Math.max(0, selected.length - 1),
        truncated: byteTruncated || lineTruncated,
        redactions: redacted.redactions
      }
    };
  }
}
