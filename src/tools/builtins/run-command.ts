import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveExistingPath } from "../../policy/paths.js";
import { redactSecrets } from "../../policy/sensitive-data.js";
import { minimalProcessEnvironment, platformShellInvocation, runProcess } from "../../process/run.js";
import { CjError } from "../../shared/errors.js";
import type { PreparedAction, Tool, ToolContext, ToolResult } from "../types.js";

const inputSchema = z
  .object({
    command: z.string().min(1).max(16_384),
    args: z.array(z.string().max(8_192)).max(200).default([]),
    cwd: z.string().default("."),
    shell: z.boolean().default(false),
    timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
    environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4_096)).default({}),
    allowSensitiveOutput: z.boolean().default(false)
  })
  .strict()
  .refine((value) => !value.shell || value.args.length === 0, {
    message: "args must be empty in shell mode; put the complete command in command"
  });

type RunCommandInput = z.infer<typeof inputSchema>;

interface RunCommandPayload extends RunCommandInput {
  executable: string;
  executableArgs: string[];
  resolvedCwd: string;
}

interface RunCommandData {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  redactions: number;
}

function commandDisplay(executable: string, args: string[]): string {
  const rendered = [executable, ...args].map((part) => JSON.stringify(part)).join(" ");
  return redactSecrets(rendered).value;
}

function rejectPrivilegeElevation(command: string, args: string[], shell: boolean): void {
  const base = command.trim().toLowerCase();
  if (!shell && ["sudo", "doas", "pkexec", "runas"].includes(base)) {
    throw new CjError("TOOL_INPUT_INVALID", "Automatic privilege elevation is not allowed");
  }
  const text = shell ? command : [command, ...args].join(" ");
  if (/\b(?:sudo|doas|pkexec|runas)\b/i.test(text) || /-Verb\s+RunAs/i.test(text)) {
    throw new CjError("TOOL_INPUT_INVALID", "Automatic privilege elevation is not allowed");
  }
}

export class RunCommandTool implements Tool<RunCommandInput, RunCommandPayload, RunCommandData> {
  readonly defaultRisk = "high" as const;
  readonly possibleEffects = ["process", "read", "write", "delete", "network"] as const;
  readonly definition = {
    type: "function" as const,
    function: {
      name: "run_command",
      description:
        "Run an arbitrary process. Prefer dedicated Tools. This always requires confirmation. By default command is an executable and args is a structured array; set shell=true only for pipes or redirection.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: { type: "string", minLength: 1, maxLength: 16384 },
          args: { type: "array", maxItems: 200, items: { type: "string", maxLength: 8192 }, default: [] },
          cwd: { type: "string", default: "." },
          shell: { type: "boolean", default: false },
          timeoutMs: { type: "integer", minimum: 100, maximum: 120000, default: 30000 },
          environment: {
            type: "object",
            additionalProperties: { type: "string", maxLength: 4096 },
            default: {},
            description: "Explicit extra environment values; inherited credentials are never passed"
          },
          allowSensitiveOutput: { type: "boolean", default: false }
        }
      }
    }
  };

  parse(input: unknown): RunCommandInput {
    return inputSchema.parse(input);
  }

  async prepare(input: RunCommandInput, context: ToolContext): Promise<PreparedAction<RunCommandPayload>> {
    rejectPrivilegeElevation(input.command, input.args, input.shell);
    const cwd = await resolveExistingPath(context.workspaceRoot, input.cwd);
    const invocation = input.shell
      ? platformShellInvocation(input.command)
      : { executable: input.command, args: input.args };
    const display = commandDisplay(invocation.executable, invocation.args);
    const environmentNames = Object.keys(input.environment).sort();
    return {
      id: randomUUID(),
      toolName: "run_command",
      riskLevel: "high",
      summary: context.language === "zh-CN"
        ? `在 ${cwd.path} 运行 ${display}${environmentNames.length ? `；环境变量名：${environmentNames.join(", ")}` : ""}${input.allowSensitiveOutput ? "；返回未脱敏输出" : ""}`
        : `Run ${display} in ${cwd.path}${environmentNames.length ? `; environment names: ${environmentNames.join(", ")}` : ""}${input.allowSensitiveOutput ? "; return unredacted output" : ""}`,
      targets: [cwd.path],
      effects: ["process", "read", "write", "delete", "network"],
      reversible: false,
      payload: {
        ...input,
        executable: invocation.executable,
        executableArgs: invocation.args,
        resolvedCwd: cwd.path
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }

  async execute(
    action: PreparedAction<RunCommandPayload>,
    context: ToolContext
  ): Promise<ToolResult<RunCommandData>> {
    const result = await runProcess({
      command: action.payload.executable,
      args: action.payload.executableArgs,
      cwd: action.payload.resolvedCwd,
      env: minimalProcessEnvironment(action.payload.environment),
      timeoutMs: action.payload.timeoutMs,
      signal: context.signal
    });
    const stdout = action.payload.allowSensitiveOutput
      ? { value: result.stdout, redactions: 0 }
      : redactSecrets(result.stdout);
    const stderr = action.payload.allowSensitiveOutput
      ? { value: result.stderr, redactions: 0 }
      : redactSecrets(result.stderr);
    const redactions = stdout.redactions + stderr.redactions;
    return {
      success: result.exitCode === 0 && !result.timedOut,
      message: context.language === "zh-CN"
        ? result.timedOut
          ? `命令在 ${action.payload.timeoutMs}ms 后超时`
          : `命令退出码：${result.exitCode ?? "未知"}`
        : result.timedOut
          ? `Command timed out after ${action.payload.timeoutMs}ms`
          : `Command exited with code ${result.exitCode ?? "unknown"}`,
      effects: [`Ran ${commandDisplay(action.payload.executable, action.payload.executableArgs)}`],
      data: {
        ...result,
        stdout: stdout.value,
        stderr: stderr.value,
        redactions
      }
    };
  }
}
