#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Command } from "commander";
import pc from "picocolors";
import { AgentRuntime } from "../agent/runtime.js";
import type { AgentMessage } from "../providers/types.js";
import { addConfigCommand } from "./commands/config.js";
import { addToolsCommand } from "./commands/tools.js";
import { ConfigStore } from "../config/store.js";
import type { AppConfig } from "../config/schema.js";
import { createDeepSeekProvider } from "../providers/deepseek.js";
import { asCjError, CjError } from "../shared/errors.js";
import { ListFilesTool } from "../tools/builtins/list-files.js";
import { SearchFilesTool } from "../tools/builtins/search-files.js";
import { ReadFileTool } from "../tools/builtins/read-file.js";
import { WriteFileTool } from "../tools/builtins/write-file.js";
import { MoveFilesTool } from "../tools/builtins/move-files.js";
import { TrashFilesTool } from "../tools/builtins/trash-files.js";
import { RunCommandTool } from "../tools/builtins/run-command.js";
import { GitTool } from "../tools/builtins/git.js";
import { ToolRegistry } from "../tools/registry.js";
import { createHumanRenderer } from "./renderers/human.js";
import { jsonlRenderer } from "./renderers/jsonl.js";
import { createTerminalConfirmation } from "./confirmation.js";
import { AuditStore } from "../audit/store.js";
import { addHistoryCommand } from "./commands/history.js";
import { createReadlineSessionInput } from "./session/input.js";
import { formatHistory, formatTools, runInteractiveSession } from "./session/repl.js";

const CLI_VERSION = "0.1.0";
const program = new Command();
const store = new ConfigStore();
const audit = new AuditStore(store.paths.historyFile);
const registry = new ToolRegistry()
  .register(new ListFilesTool())
  .register(new SearchFilesTool())
  .register(new ReadFileTool())
  .register(new WriteFileTool())
  .register(new MoveFilesTool())
  .register(new TrashFilesTool())
  .register(new RunCommandTool())
  .register(new GitTool());

interface CliOptions {
  json?: boolean;
  verbose?: boolean;
  language?: string;
  timeout?: string;
  plain?: boolean;
  color?: boolean;
}

interface ExecuteTaskOptions {
  config: AppConfig;
  apiKey: string;
  prompt: string;
  workspaceRoot: string;
  language: "zh-CN" | "en";
  timeoutMs: number;
  signal: AbortSignal;
  interactive: boolean;
  json: boolean;
  verbose: boolean;
  plain: boolean;
  noColor: boolean;
  messages?: AgentMessage[];
  isTimedOut?: () => boolean;
}

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m)?$/.exec(value.trim());
  if (!match) throw new CjError("CONFIG_INVALID", `Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  return amount * multiplier;
}

function resolveTimeout(config: AppConfig, value: string | undefined): number {
  const requestedTimeout = value ? parseDuration(value) : config.limits.taskTimeoutMs;
  if (requestedTimeout < 1_000 || requestedTimeout > config.limits.taskTimeoutMs) {
    throw new CjError(
      "CONFIG_INVALID",
      `Timeout must be between 1s and ${config.limits.taskTimeoutMs}ms`
    );
  }
  return requestedTimeout;
}

async function executeTask(options: ExecuteTaskOptions): Promise<string> {
  const auditContext = audit.createTaskContext({
    cliVersion: CLI_VERSION,
    cwd: options.workspaceRoot,
    provider: options.config.provider.id,
    model: options.config.provider.model,
    promptHash: createHash("sha256").update(options.prompt).digest("hex")
  });
  await audit.taskStarted(auditContext);

  try {
    const renderer = options.json
      ? jsonlRenderer
      : createHumanRenderer({
          verbose: options.verbose,
          language: options.language,
          plain: options.plain,
          noColor: options.noColor
        });
    const runtime = new AgentRuntime({
      provider: createDeepSeekProvider(options.config, options.apiKey),
      model: options.config.provider.model,
      registry,
      workspaceRoot: options.workspaceRoot,
      language: options.language,
      maxToolCalls: options.config.limits.maxToolCalls,
      signal: options.signal,
      ...(options.messages ? { messages: options.messages } : {}),
      interactive: options.interactive,
      confirm: createTerminalConfirmation(options.language),
      onEvent: async (event) => {
        await renderer(event);
        await audit.agentEvent(auditContext.taskId, event);
      }
    });
    const result = await runtime.run(options.prompt);
    await audit.taskFinished(auditContext.taskId, true);
    return result;
  } catch (error) {
    const normalized = options.isTimedOut?.()
      ? new CjError("LIMIT_EXCEEDED", `Task exceeded timeout of ${options.timeoutMs}ms`, { cause: error })
      : asCjError(error);
    await audit.taskFinished(auditContext.taskId, false, normalized.code);
    throw normalized;
  }
}

async function executeTaskWithController(
  options: Omit<ExecuteTaskOptions, "signal" | "isTimedOut"> & { controller: AbortController }
): Promise<string> {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    options.controller.abort(new Error("Task timeout"));
  }, options.timeoutMs);
  try {
    return await executeTask({
      ...options,
      signal: options.controller.signal,
      isTimedOut: () => timedOut
    });
  } finally {
    clearTimeout(timeout);
  }
}

program
  .name("cj")
  .description("A local, tool-using personal AI assistant")
  .version(CLI_VERSION)
  .option("--json", "emit JSON Lines events")
  .option("--verbose", "show detailed Tool results")
  .option("--language <language>", "override display language (zh-CN or en)")
  .option("--timeout <duration>", "lower the task timeout, for example 30s or 2m")
  .option("--plain", "use plain terminal output")
  .option("--no-color", "disable terminal colors")
  .argument("[prompt...]", "natural-language task")
  .action(async (
    words: string[],
    options: CliOptions
  ) => {
    if (words.length === 0) {
      program.help();
      return;
    }

    const config = await store.loadConfig();
    const language = options.language ?? config.language;
    if (language !== "zh-CN" && language !== "en") {
      throw new CjError("CONFIG_INVALID", `Unsupported language: ${language}`);
    }
    const requestedTimeout = resolveTimeout(config, options.timeout);
    const apiKey = await store.resolveApiKey(config.provider.id);
    const workspaceRoot = await realpath(process.cwd());
    const prompt = words.join(" ");
    const controller = new AbortController();
    const onSigint = (): void => controller.abort(new Error("Interrupted"));
    process.once("SIGINT", onSigint);

    try {
      await executeTaskWithController({
        config,
        apiKey,
        prompt,
        workspaceRoot,
        language,
        timeoutMs: requestedTimeout,
        controller,
        json: options.json ?? false,
        verbose: options.verbose ?? false,
        plain: options.plain ?? false,
        noColor: options.color === false,
        interactive: !options.json && Boolean(
          process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY
        )
      });
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  });

program
  .command("chat")
  .description("Start an interactive multi-turn chat session")
  .action(async (_options: unknown, command: Command) => {
    const options = command.optsWithGlobals() as CliOptions;
    if (options.json || !process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
      throw new CjError("CONFIG_INVALID", "cj chat requires an interactive TTY");
    }

    const config = await store.loadConfig();
    const language = options.language ?? config.language;
    if (language !== "zh-CN" && language !== "en") {
      throw new CjError("CONFIG_INVALID", `Unsupported language: ${language}`);
    }
    const timeoutMs = resolveTimeout(config, options.timeout);
    const apiKey = await store.resolveApiKey(config.provider.id);
    const workspaceRoot = await realpath(process.cwd());
    const transcript: AgentMessage[] = [];
    const startedAt = new Date().toISOString();
    let turns = 0;
    const input = createReadlineSessionInput(process.stdin, process.stderr);
    const sessionColors = pc.createColors(pc.isColorSupported && !(options.plain || options.color === false));
    const write = (message: string): void => {
      process.stdout.write(`${message}\n`);
    };

    await runInteractiveSession({
      input,
      language,
      write,
      runPrompt: async (prompt, signal) => {
        const draft = transcript.slice();
        const controller = new AbortController();
        const forwardAbort = (): void => controller.abort(signal.reason);
        if (signal.aborted) forwardAbort();
        else signal.addEventListener("abort", forwardAbort, { once: true });
        try {
          await executeTaskWithController({
            config,
            apiKey,
            prompt,
            workspaceRoot,
            language,
            timeoutMs,
            controller,
            json: false,
            verbose: options.verbose ?? false,
            plain: options.plain ?? false,
            noColor: options.color === false,
            interactive: true,
            messages: draft
          });
          transcript.splice(0, transcript.length, ...draft);
          turns += 1;
        } finally {
          signal.removeEventListener("abort", forwardAbort);
        }
      },
      clear: () => {
        transcript.length = 0;
      },
      status: () => ({
        startedAt,
        turns,
        contextMessages: transcript.length,
        provider: config.provider.id,
        model: config.provider.model,
        workspaceRoot
      }),
      tools: () => formatTools(
        registry.entries().map((tool) => ({
          name: tool.definition.function.name,
          risk: tool.defaultRisk,
          description: tool.definition.function.description
        })),
        language
      ),
      history: async () => formatHistory(await audit.list(50), language),
      reportError: (error) => {
        process.stderr.write(`${sessionColors.red("Error")} [${error.code}] ${error.message}\n`);
      }
    });
  });

addConfigCommand(program, store);
addToolsCommand(program, registry);
addHistoryCommand(program, audit);

program
  .command("doctor")
  .description("Validate configuration, credentials, and provider access")
  .option("--offline", "skip the provider connectivity check")
  .action(async (options: { offline?: boolean }) => {
    const config = await store.loadConfig();
    const apiKey = await store.resolveApiKey(config.provider.id);
    const zh = config.language === "zh-CN";
    process.stdout.write(`${pc.green("✓")} ${zh ? "配置和凭据可用" : "Configuration and credentials are available"}\n`);
    process.stdout.write(`  provider: ${config.provider.id}\n  model: ${config.provider.model}\n  baseURL: ${config.provider.baseURL}\n`);
    if (!options.offline) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Doctor timeout")), 15_000);
      try {
        const response = await createDeepSeekProvider(config, apiKey).complete(
          {
            model: config.provider.model,
            messages: [{ role: "user", content: "Reply with exactly OK." }],
            tools: [],
            toolChoice: "none"
          },
          controller.signal
        );
        if (response.kind !== "message") throw new CjError("MODEL_RESPONSE_INVALID", "Provider returned a Tool call during doctor check");
        process.stdout.write(`${pc.green("✓")} ${zh ? "模型服务连接成功" : "Provider connection succeeded"}\n`);
      } finally {
        clearTimeout(timeout);
      }
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const normalized = asCjError(error);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ version: 1, type: "error", code: normalized.code, message: normalized.message })}\n`);
  } else {
    process.stderr.write(`${pc.red("Error")} [${normalized.code}] ${normalized.message}\n`);
  }
  if (normalized.cause instanceof Error && process.env.CJ_DEBUG === "1") {
    process.stderr.write(`${normalized.cause.stack ?? normalized.cause.message}\n`);
  }
  process.exitCode =
    normalized.code === "AUTH_MISSING" || normalized.code === "PROVIDER_UNAVAILABLE"
      ? 3
      : normalized.code === "CONFIRMATION_REQUIRED" || normalized.code === "CONFIRMATION_REJECTED"
        ? 4
      : normalized.code === "ABORTED"
          ? 130
          : normalized.code === "CONFIG_INVALID"
            ? 2
            : 1;
});
