#!/usr/bin/env node
import { refreshExternalTools } from "../tools/external-cli.js";
import { realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Command } from "commander";
import pc from "picocolors";
import { AgentRuntime } from "../agent/runtime.js";
import type { EventSink } from "../agent/events.js";
import type { AgentMessage } from "../providers/types.js";
import { addConfigCommand } from "./commands/config.js";
import { addToolsCommand } from "./commands/tools.js";
import { ConfigStore } from "../config/store.js";
import type { AppConfig } from "../config/schema.js";
import { createProvider } from "../providers/deepseek.js";
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
import { formatTaskHistory, formatTools, runInteractiveSession } from "./session/repl.js";
import { MemoryStore } from "../memory/store.js";
import { addMemoryCommand } from "./commands/memory.js";
import { resolveAllowedRoots } from "../policy/paths.js";
import { PolicyEngine } from "../policy/engine.js";
import { discoverLocalTools } from "../tools/extensions.js";
import { addCompletionCommand } from "./completion.js";
import { addSkillsCommand } from "./commands/skills.js";
import { discoverSkills, type SkillCatalog } from "../skills/catalog.js";
import { ReadSkillTool } from "../tools/builtins/read-skill.js";
import { AskQuestionTool } from "../tools/builtins/ask-question.js";
import { SearchWebTool } from "../tools/builtins/search-web.js";
import { createTerminalQuestion } from "./question.js";
import path from "node:path";

const CLI_VERSION = "1.0.0";
const program = new Command();
const store = new ConfigStore();
const audit = new AuditStore(store.paths.historyFile);
const memoryStore = new MemoryStore(store.paths.memoryFile);
const registry = new ToolRegistry()
  .register(new ListFilesTool())
  .register(new SearchFilesTool())
  .register(new ReadFileTool())
  .register(new WriteFileTool())
  .register(new MoveFilesTool())
  .register(new TrashFilesTool())
  .register(new RunCommandTool())
  .register(new GitTool())
  .register(new AskQuestionTool())
  .register(new SearchWebTool());

interface CliOptions {
  json?: boolean;
  verbose?: boolean;
  language?: string;
  timeout?: string;
  plain?: boolean;
  color?: boolean;
  dryRun?: boolean;
  taskEvents?: boolean;
  profile?: string;
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
  dryRun?: boolean;
  taskEvents?: boolean;
  messages?: AgentMessage[];
  isTimedOut?: () => boolean;
  onQuestionWaiting?: (waiting: boolean) => void;
  maxToolCalls?: number;
  onToolExecuted?: () => void;
  sessionId?: string;
}

const loadedPlugins = new Set<string>();

async function configureExtensions(config: AppConfig): Promise<void> {
  const requested = config.plugins.enabled.filter((name) => !loadedPlugins.has(name));
  if (!requested.length) return;
  const results = await discoverLocalTools(registry, store.paths.toolsDir, requested);
  for (const result of results) {
    if (result.ok && result.enabled && result.name && result.message === "Loaded") loadedPlugins.add(result.name);
  }
  const failures = results.filter((result) => result.enabled && !result.ok);
  const found = new Set(results.map((result) => result.name).filter((name): name is string => Boolean(name)));
  const missing = requested.filter((name) => !found.has(name));
  if (failures.length || missing.length) {
    throw new CjError("CONFIG_INVALID", `Unable to load enabled Tool extension(s): ${[...failures.map((item) => item.name ?? item.directory), ...missing].join(", ")}`);
  }
}

async function configureSkills(config: AppConfig, workspaceRoot: string): Promise<SkillCatalog> {
  const catalog = await discoverSkills({
    userDirectory: store.paths.skillsDir,
    workspaceDirectory: path.join(workspaceRoot, ".agents", "skills"),
    trustedWorkspaceDirectories: config.skills.trustedWorkspaceDirectories
  });
  registry.removeByOrigin("skill");
  if (catalog.skills.length) registry.register(new ReadSkillTool(), "skill");
  return catalog;
}

function selectProfile(config: AppConfig, name: string | undefined): AppConfig {
  if (!name || name === config.activeProfile) return config;
  const profile = config.profiles[name];
  if (!profile) throw new CjError("CONFIG_INVALID", `Unknown profile: ${name}`);
  return { ...config, activeProfile: name, provider: profile.provider, limits: profile.limits };
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
    promptHash: createHash("sha256").update(options.prompt).digest("hex"),
    ...(options.sessionId ? { sessionId: options.sessionId } : {})
  });
  await audit.taskStarted(auditContext);
  await audit.agentEvent(auditContext.taskId, { type: "task_status", taskId: auditContext.taskId, status: "queued" });
  let render: EventSink | undefined;

  try {
    await configureExtensions(options.config);
    const skillCatalog = await configureSkills(options.config, options.workspaceRoot);
    const allowedRoots = await resolveAllowedRoots(options.workspaceRoot, options.config.security.allowedRoots);
    const memoryFacts = options.config.memory.enabled ? await memoryStore.list() : [];
    const renderer = options.json
      ? jsonlRenderer
      : createHumanRenderer({
          verbose: options.verbose || options.taskEvents === true,
          language: options.language,
          plain: options.plain,
          noColor: options.noColor
        });
    render = renderer;
    const externalConfig = await store.loadConfig();
    if (externalConfig.externalCli.directories.length) {
      await renderer({ type: "status", message: options.language === "zh-CN" ? "正在检查外部 CLI 及其用法说明…" : "Checking external CLIs and documentation…" });
    }
    const externalDiagnostics = await refreshExternalTools({ registry, config: { ...options.config, externalCli: externalConfig.externalCli }, stateDir: store.paths.stateDir,
      provider: async () => createProvider(options.config, options.apiKey), signal: options.signal });
    if (externalDiagnostics.length) {
      const registered = externalDiagnostics.reduce((sum, item) => sum + item.tools.length, 0);
      const event = { type: "status" as const, message: options.language === "zh-CN"
        ? `外部 CLI：已注册 ${registered} 项能力；详细审核结果见 cj tools doctor。`
        : `External CLI: ${registered} capabilities registered; inspect cj tools doctor for review details.` };
      await renderer(event);
      await audit.agentEvent(auditContext.taskId, event);
    }
    const runtime = new AgentRuntime({
      provider: createProvider(options.config, options.apiKey),
      model: options.config.provider.model,
      registry,
      workspaceRoot: options.workspaceRoot,
      language: options.language,
      maxToolCalls: options.maxToolCalls ?? options.config.limits.maxToolCalls,
      modelTimeoutMs: options.config.limits.modelTimeoutMs,
      toolTimeoutMs: options.config.limits.toolTimeoutMs,
      maxOutputBytes: options.config.limits.maxOutputBytes,
      taskId: auditContext.taskId,
      emitLifecycle: true,
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      memoryFacts,
      skillCatalog,
      webSearch: {
        enabled: options.config.webSearch.enabled,
        resolveApiKey: () => store.resolveApiKey("tavily")
      },
      ...(options.onToolExecuted === undefined ? {} : { onToolExecuted: options.onToolExecuted }),
      signal: options.signal,
      ...(options.messages ? { messages: options.messages } : {}),
      interactive: options.interactive,
      confirm: createTerminalConfirmation(options.language),
      ...(options.interactive ? { askQuestion: createTerminalQuestion(options.language) } : {}),
      ...(options.onQuestionWaiting ? { onQuestionWaiting: options.onQuestionWaiting } : {}),
      policy: new PolicyEngine({ workspaceRoot: options.workspaceRoot, allowedRoots }),
      onEvent: async (event) => {
        if ((event.type !== "task_status" && event.type !== "task_step") || options.taskEvents) await renderer(event);
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
    const statusEvent = {
      type: "task_status",
      taskId: auditContext.taskId,
      status: normalized.code === "ABORTED" ? "cancelled" : "failed",
      detail: normalized.code
    } as const;
    if (options.taskEvents && render) await render(statusEvent);
    await audit.agentEvent(auditContext.taskId, statusEvent);
    await audit.taskFinished(auditContext.taskId, false, normalized.code);
    throw normalized;
  }
}

async function executeTaskWithController(
  options: Omit<ExecuteTaskOptions, "signal" | "isTimedOut" | "onQuestionWaiting"> & { controller: AbortController }
): Promise<string> {
  let timedOut = false;
  let remainingMs = options.timeoutMs;
  let startedAt = performance.now();
  let timeout: NodeJS.Timeout | undefined;
  let paused = false;
  const expire = () => {
    timedOut = true;
    options.controller.abort(new Error("Task timeout"));
  };
  const armTimeout = () => {
    if (timedOut || paused) return;
    if (remainingMs <= 0) {
      expire();
      return;
    }
    startedAt = performance.now();
    timeout = setTimeout(expire, remainingMs);
  };
  const setQuestionWaiting = (waiting: boolean) => {
    if (waiting === paused || timedOut) return;
    if (waiting) {
      remainingMs = Math.max(0, remainingMs - (performance.now() - startedAt));
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      paused = true;
      return;
    }
    paused = false;
    armTimeout();
  };
  armTimeout();
  try {
    return await executeTask({
      ...options,
      signal: options.controller.signal,
      isTimedOut: () => timedOut,
      onQuestionWaiting: setQuestionWaiting
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

program
  .name("cj")
  .description("A local AI assistant that completes natural-language tasks using built-in and external tools")
  .version(CLI_VERSION)
  .option("--json", "emit JSON Lines events")
  .option("--verbose", "show detailed Tool results")
  .option("--language <language>", "override display language (zh-CN or en)")
  .option("--timeout <duration>", "lower the task timeout, for example 30s or 2m")
  .option("--plain", "use plain terminal output")
  .option("--no-color", "disable terminal colors")
  .option("--dry-run", "preview prepared Tool actions without executing them")
  .option("--task-events", "emit task lifecycle events (including in JSONL mode)")
  .option("--profile <name>", "use a configured profile for this invocation without changing the default")
  .argument("[prompt...]", "natural-language task")
  .addHelpText("after", `
Examples:
  cj "List the largest files in this directory"
  cj chat
  cj config
  cj config cli-dir add /absolute/path/to/cli-tools
  cj tools doctor

External CLI capabilities are discovered and reviewed before each task.
Use cj <command> --help for command-specific usage.
`)
  .action(async (
    words: string[],
    options: CliOptions
  ) => {
    if (words.length === 0) {
      program.help();
      return;
    }

    const config = selectProfile(await store.loadConfig(), options.profile);
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
        dryRun: options.dryRun ?? false,
        taskEvents: options.taskEvents ?? false,
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

    const config = selectProfile(await store.loadConfig(), options.profile);
    const language = options.language ?? config.language;
    if (language !== "zh-CN" && language !== "en") {
      throw new CjError("CONFIG_INVALID", `Unsupported language: ${language}`);
    }
    const timeoutMs = resolveTimeout(config, options.timeout);
    const apiKey = await store.resolveApiKey(config.provider.id);
    const workspaceRoot = await realpath(process.cwd());
    const transcript: AgentMessage[] = [];
    const startedAt = new Date().toISOString();
    const sessionId = randomUUID();
    let turns = 0;
    let retryPrompt: string | undefined;
    let retryToolCalls = 0;
    const input = createReadlineSessionInput(process.stdin, process.stderr);
    const sessionColors = pc.createColors(pc.isColorSupported && !(options.plain || options.color === false));
    const write = (message: string): void => {
      process.stdout.write(`${message}\n`);
    };

    await runInteractiveSession({
      input,
      language,
      write,
      runPrompt: async (prompt, signal, retry = false) => {
        if (!retry || prompt !== retryPrompt) {
          retryPrompt = prompt;
          retryToolCalls = 0;
        }
        const remainingToolCalls = config.limits.maxToolCalls - retryToolCalls;
        if (remainingToolCalls < 1) {
          throw new CjError("LIMIT_EXCEEDED", `Maximum Tool call count (${config.limits.maxToolCalls}) already used by this task and its retries`);
        }
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
            dryRun: options.dryRun ?? false,
            taskEvents: options.taskEvents ?? false,
            maxToolCalls: remainingToolCalls,
            onToolExecuted: () => { retryToolCalls += 1; },
            sessionId,
            interactive: true,
            // The question UI owns stdin only while a model-requested
            // clarification is pending, then the chat readline loop resumes.
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
        sessionId,
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
      history: async () => formatTaskHistory(await audit.listTaskSummaries(50), language),
      last: async () => {
        const records = await audit.list(1);
        return records.length ? formatTaskHistory(await audit.listTaskSummaries(1), language) : (language === "zh-CN" ? "暂无历史记录。" : "No history.");
      },
      reportError: (error) => {
        process.stderr.write(`${sessionColors.red("Error")} [${error.code}] ${error.message}\n`);
      }
    });
  });

addConfigCommand(program, store);
addToolsCommand(program, registry, store);
addHistoryCommand(program, audit);
addMemoryCommand(program, store, memoryStore);
addSkillsCommand(program, store);
addCompletionCommand(program, store, registry);

program
  .command("version")
  .description("Show version and local diagnostic paths without reading credentials")
  .option("--diagnose", "also validate configuration and local store permissions")
  .action(async (options: { diagnose?: boolean }) => {
    process.stdout.write(`cj ${CLI_VERSION}\nnode ${process.version}\nplatform ${process.platform}/${process.arch}\n`);
    if (!options.diagnose) return;
    const config = await store.loadConfig();
    process.stdout.write(`config ${store.paths.configFile}\nhistory ${store.paths.historyFile}\nactive profile ${config.activeProfile}\n`);
    // loadAuth validates permission bits while keeping any credential value out
    // of the output. Memory is optional, so an absent file is valid.
    await store.loadAuth();
    await memoryStore.list();
    process.stdout.write(`${pc.green("✓")} local configuration stores are readable and protected\n`);
  });

program
  .command("doctor")
  .description("Validate configuration, credentials, and provider access")
  .option("--offline", "skip the provider connectivity check")
  .option("--profile <name>", "profile to check")
  .action(async (options: { offline?: boolean; profile?: string }) => {
    const config = selectProfile(await store.loadConfig(), options.profile);
    const apiKey = await store.resolveApiKey(config.provider.id);
    const zh = config.language === "zh-CN";
    process.stdout.write(`${pc.green("✓")} ${zh ? "配置和凭据可用" : "Configuration and credentials are available"}\n`);
    process.stdout.write(`  provider: ${config.provider.id}\n  model: ${config.provider.model}\n  baseURL: ${config.provider.baseURL}\n`);
    if (!options.offline) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Doctor timeout")), 15_000);
      try {
        const response = await createProvider(config, apiKey).complete(
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
      : normalized.code === "INTERACTION_REQUIRED"
        ? 4
      : normalized.code === "ABORTED"
          ? 130
          : normalized.code === "CONFIG_INVALID"
            ? 2
            : 1;
});
