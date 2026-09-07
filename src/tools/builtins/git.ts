import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { resolveDestinationPath, resolveExistingPath } from "../../policy/paths.js";
import { redactSecrets } from "../../policy/sensitive-data.js";
import { minimalProcessEnvironment, runProcess } from "../../process/run.js";
import { CjError } from "../../shared/errors.js";
import type { PreparedAction, RiskLevel, Tool, ToolContext, ToolResult } from "../types.js";

const inputSchema = z
  .object({
    action: z.enum(["status", "diff", "log", "add", "commit"]),
    cwd: z.string().default("."),
    paths: z.array(z.string().min(1)).max(100).default([]),
    staged: z.boolean().default(false),
    maxCount: z.number().int().min(1).max(50).default(10),
    message: z.string().min(1).max(10_000).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "add" && value.paths.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "paths are required for git add" });
    }
    if (value.action === "commit" && !value.message) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "message is required for git commit" });
    }
  });

type GitInput = z.infer<typeof inputSchema>;

interface GitPayload {
  action: GitInput["action"];
  args: string[];
  cwd: string;
}

interface GitData {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  redactions: number;
}

function argsFor(input: GitInput, paths: string[]): string[] {
  switch (input.action) {
    case "status":
      return ["status", "--short", "--branch"];
    case "diff":
      return ["diff", ...(input.staged ? ["--cached"] : []), ...(paths.length ? ["--", ...paths] : [])];
    case "log":
      return ["log", "--oneline", "--decorate", `--max-count=${input.maxCount}`];
    case "add":
      return ["add", "--", ...paths];
    case "commit":
      return ["commit", "-m", input.message!];
  }
}

function riskFor(action: GitInput["action"], external: boolean): RiskLevel {
  if (external || action === "commit") return "high";
  if (action === "add") return "medium";
  return "low";
}

export class GitTool implements Tool<GitInput, GitPayload, GitData> {
  readonly defaultRisk = "low" as const;
  readonly possibleEffects = ["git", "read", "write", "process"] as const;
  readonly definition = {
    type: "function" as const,
    function: {
      name: "git",
      description:
        "Perform structured Git status, diff, log, add, or commit operations. Commit requires confirmation because hooks may execute code. This Tool never pushes.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["status", "diff", "log", "add", "commit"] },
          cwd: { type: "string", default: "." },
          paths: { type: "array", maxItems: 100, items: { type: "string", minLength: 1 }, default: [] },
          staged: { type: "boolean", default: false, description: "Show staged changes for diff" },
          maxCount: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          message: { type: "string", minLength: 1, maxLength: 10000, description: "Required for commit" }
        }
      }
    }
  };

  parse(input: unknown): GitInput {
    return inputSchema.parse(input);
  }

  async prepare(input: GitInput, context: ToolContext): Promise<PreparedAction<GitPayload>> {
    const cwd = await resolveExistingPath(context.workspaceRoot, input.cwd);
    const check = await runProcess({
      command: "git",
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd: cwd.path,
      env: minimalProcessEnvironment({ GIT_TERMINAL_PROMPT: "0" }),
      timeoutMs: 5_000,
      signal: context.signal,
      maxOutputBytes: 8_192
    });
    if (check.exitCode !== 0 || check.stdout.trim() !== "true") {
      throw new CjError("TOOL_INPUT_INVALID", `Not a Git worktree: ${input.cwd}`);
    }
    const validatedPaths: string[] = [];
    for (const requested of input.paths) {
      // Git can stage a deletion, so the leaf may no longer exist. Resolving the
      // real parent still prevents `..` and parent-symlink escapes.
      const resolved = await resolveDestinationPath(cwd.path, requested);
      if (resolved.external) throw new CjError("PATH_NOT_AUTHORIZED", `Git path is outside the repository: ${requested}`);
      validatedPaths.push(path.relative(cwd.path, resolved.path));
    }
    const args = argsFor(input, validatedPaths);
    const riskLevel = riskFor(input.action, cwd.external);
    return {
      id: randomUUID(),
      toolName: "git",
      riskLevel,
      summary: context.language === "zh-CN"
        ? `在 ${cwd.path} 运行 git ${args.map((part) => JSON.stringify(part)).join(" ")}`
        : `Run git ${args.map((part) => JSON.stringify(part)).join(" ")} in ${cwd.path}`,
      targets: [cwd.path, ...validatedPaths.map((item) => path.join(cwd.path, item))],
      effects: input.action === "add" || input.action === "commit" ? ["git", "write", "process"] : ["git", "read", "process"],
      reversible: input.action !== "commit",
      payload: { action: input.action, args, cwd: cwd.path },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }

  async execute(action: PreparedAction<GitPayload>, context: ToolContext): Promise<ToolResult<GitData>> {
    const result = await runProcess({
      command: "git",
      args: action.payload.args,
      cwd: action.payload.cwd,
      env: minimalProcessEnvironment({ GIT_TERMINAL_PROMPT: "0" }),
      timeoutMs: context.toolTimeoutMs ?? 60_000,
      signal: context.signal,
      ...(context.maxOutputBytes === undefined ? {} : { maxOutputBytes: context.maxOutputBytes })
    });
    const stdout = redactSecrets(result.stdout);
    const stderr = redactSecrets(result.stderr);
    return {
      success: result.exitCode === 0 && !result.timedOut,
      message: context.language === "zh-CN"
        ? `git ${action.payload.action} 退出码：${result.exitCode ?? "未知"}`
        : `git ${action.payload.action} exited with code ${result.exitCode ?? "unknown"}`,
      effects: [`Ran git ${action.payload.action} in ${action.payload.cwd}`],
      data: {
        exitCode: result.exitCode,
        stdout: stdout.value,
        stderr: stderr.value,
        truncated: result.truncated,
        redactions: stdout.redactions + stderr.redactions
      },
      ...(action.recovery === undefined ? {} : { recovery: action.recovery })
    };
  }
}
