import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { input, password, select } from "@inquirer/prompts";
import type { Command } from "commander";
import type { ConfigStore } from "../../config/store.js";
import { printableConfig } from "../../config/redact.js";
import { CjError } from "../../shared/errors.js";

async function resolveCliDirectory(input: string): Promise<string> {
  let candidate = path.resolve(input);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await realpath(candidate), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(candidate) === candidate) throw error;
      missing.unshift(path.basename(candidate));
      candidate = path.dirname(candidate);
    }
  }
}

export function addConfigCommand(program: Command, store: ConfigStore): void {
  const command = program.command("config").description("Manage model profiles, credentials, workspace access and tool sources");

  command.action(async () => {
    const current = await store.loadConfig();
    const currentAuth = await store.loadAuth();
    const zh = current.language === "zh-CN";
    const provider = await input({ message: "Provider ID", default: current.provider.id });
    const baseURL = await input({ message: zh ? "API 地址" : "Base URL", default: current.provider.baseURL });
    const model = await input({ message: zh ? "模型" : "Model", default: current.provider.model });
    const language = await select({
      message: zh ? "界面语言" : "Display language",
      default: current.language,
      choices: [
        { name: "中文", value: "zh-CN" as const },
        { name: "English", value: "en" as const }
      ]
    });
    const storage = await select({
      message: zh ? "API Key 保存方式" : "API Key storage",
      choices: [
        { name: zh ? "保存到仅当前用户可读的 auth.json" : "Save in owner-only auth.json", value: "api_key" as const },
        { name: zh ? "从环境变量读取" : "Read from an environment variable", value: "env" as const }
      ]
    });

    const credential = storage === "api_key"
      ? {
          type: "api_key" as const,
          key: await password({ message: "API Key", mask: "*", validate: (value) => value.length > 0 || (zh ? "必填" : "Required") })
        }
      : {
          type: "env" as const,
          variable: await input({
            message: zh ? "环境变量名" : "Environment variable",
            default: "DEEPSEEK_API_KEY",
            validate: (value) => /^[A-Z_][A-Z0-9_]*$/.test(value) || (zh ? "请使用大写环境变量名" : "Use an uppercase environment variable name")
          })
        };

    const providerConfig = { id: provider, baseURL, model, thinking: false, kind: provider === "deepseek" ? "deepseek" as const : "openai-compatible" as const };
    await store.saveConfig({
      ...current,
      provider: providerConfig,
      language
    });
    await store.saveAuth({
      ...currentAuth,
      providers: { ...currentAuth.providers, [provider]: credential }
    });
    process.stdout.write(zh ? "配置已保存。\n" : "Configuration saved.\n");
  });

  command
    .command("list")
    .description("Show configuration with credentials redacted")
    .action(async () => {
      process.stdout.write(`${JSON.stringify(printableConfig(await store.loadConfig(), await store.loadAuth()), null, 2)}\n`);
    });

  const profile = command.command("profile").description("Manage named provider profiles");
  profile.command("list").description("List configured profiles").action(async () => {
    const config = await store.loadConfig();
    for (const [name, value] of Object.entries(config.profiles).sort(([left], [right]) => left.localeCompare(right))) {
      process.stdout.write(`${name}${name === config.activeProfile ? " *" : ""}\t${value.provider.id}\t${value.provider.model}\t${value.provider.baseURL}\n`);
    }
  });

  profile.command("use").argument("<name>").description("Select the active profile").action(async (name: string) => {
    const config = await store.loadConfig();
    const selected = config.profiles[name];
    if (!selected) throw new CjError("CONFIG_INVALID", `Unknown profile: ${name}`);
    await store.saveConfig({ ...config, activeProfile: name, provider: selected.provider, limits: selected.limits });
    process.stdout.write(`Active profile: ${name}\n`);
  });

  profile
    .command("add")
    .argument("<name>")
    .description("Add or replace a profile. Credentials must be configured separately; API keys are never command arguments.")
    .requiredOption("--provider <id>", "provider identifier")
    .requiredOption("--base-url <url>", "OpenAI-compatible base URL")
    .requiredOption("--model <model>", "model identifier")
    .option("--kind <kind>", "deepseek or openai-compatible", "openai-compatible")
    .option("--thinking", "enable DeepSeek thinking")
    .option("--max-tool-calls <number>", "maximum tool calls")
    .option("--task-timeout <ms>", "overall task timeout in milliseconds")
    .action(async (name: string, options: {
      provider: string; baseUrl: string; model: string; kind: string; thinking?: boolean; maxToolCalls?: string; taskTimeout?: string;
    }) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new CjError("CONFIG_INVALID", "Invalid profile name");
      if (options.kind !== "deepseek" && options.kind !== "openai-compatible") {
        throw new CjError("CONFIG_INVALID", "kind must be deepseek or openai-compatible");
      }
      const config = await store.loadConfig();
      const base = config.profiles[name]?.limits ?? config.limits;
      const maxToolCalls = options.maxToolCalls === undefined ? base.maxToolCalls : Number(options.maxToolCalls);
      const taskTimeoutMs = options.taskTimeout === undefined ? base.taskTimeoutMs : Number(options.taskTimeout);
      if (!Number.isInteger(maxToolCalls) || !Number.isInteger(taskTimeoutMs)) {
        throw new CjError("CONFIG_INVALID", "Profile limits must be integers");
      }
      const limits = { ...base, maxToolCalls, taskTimeoutMs, modelTimeoutMs: Math.min(base.modelTimeoutMs, taskTimeoutMs) };
      const provider = {
        id: options.provider,
        baseURL: options.baseUrl,
        model: options.model,
        thinking: options.thinking ?? false,
        kind: options.kind as "deepseek" | "openai-compatible"
      };
      // Validate through the shared config schema before persisting.
      await store.saveConfig({
        ...config,
        profiles: { ...config.profiles, [name]: { provider, limits } },
        ...(name === config.activeProfile ? { provider, limits } : {})
      });
      process.stdout.write(`Profile saved: ${name}\n`);
    });

  profile.command("remove").argument("<name>").description("Remove a non-active profile").action(async (name: string) => {
    const config = await store.loadConfig();
    if (!config.profiles[name]) throw new CjError("CONFIG_INVALID", `Unknown profile: ${name}`);
    if (name === config.activeProfile) throw new CjError("CONFIG_INVALID", "Cannot remove the active profile; use another profile first");
    const { [name]: _removed, ...profiles } = config.profiles;
    await store.saveConfig({ ...config, profiles });
    process.stdout.write(`Profile removed: ${name}\n`);
  });

  command
    .command("roots")
    .description("Show or set workspace-relative directory authorization roots")
    .argument("[roots...]", "one or more relative roots")
    .action(async (roots: string[]) => {
      const config = await store.loadConfig();
      if (roots.length === 0) {
        process.stdout.write(`${config.security.allowedRoots.join("\n")}\n`);
        return;
      }
      if (roots.some((root) => root.startsWith("/") || root === ".." || root.startsWith("../") || root.startsWith("..\\"))) {
        throw new CjError("CONFIG_INVALID", "Authorization roots must be workspace-relative and cannot escape the workspace");
      }
      await store.saveConfig({ ...config, security: { allowedRoots: [...new Set(roots)] } });
      process.stdout.write("Authorization roots saved.\n");
    });

  const cliDir = command.command("cli-dir")
    .description("Manage directories for automatic external CLI discovery")
    .addHelpText("after", `
External CLIs are checked before each task. Only capabilities with sufficient
usage documentation are registered after local checks and model review.
Adding a directory allows bounded help probes of its executables.

Examples:
  cj config cli-dir add /absolute/path/to/cli-tools
  cj tools refresh
  cj tools doctor
`);
  cliDir.command("list").description("List configured external CLI directories").action(async () => {
    for (const directory of (await store.loadConfig()).externalCli.directories) process.stdout.write(`${directory}\n`);
  });
  cliDir.command("add")
    .description("Add a discovery directory and allow bounded CLI help probes")
    .argument("<path>", "existing directory containing executables or file symlinks")
    .addHelpText("after", "\nSaves the directory; discovery and model review run before the next task.\nUse cj tools refresh to review now. Adding a directory does not approve execution.\n")
    .action(async (directory: string) => {
    const resolved = await realpath(path.resolve(directory));
    if (!(await stat(resolved)).isDirectory()) throw new CjError("CONFIG_INVALID", "CLI root must be a directory");
    const config = await store.loadConfig();
    await store.saveConfig({ ...config, externalCli: { directories: [...new Set([...config.externalCli.directories, resolved])] } });
    process.stdout.write(`CLI directory added (bounded help probes authorized): ${resolved}\n`);
  });
  cliDir.command("remove")
    .description("Remove a discovery directory; leave its files in place")
    .argument("<path>", "configured directory to stop scanning")
    .action(async (directory: string) => {
    const resolved = await resolveCliDirectory(directory);
    const config = await store.loadConfig();
    await store.saveConfig({ ...config, externalCli: { directories: config.externalCli.directories.filter((item) => item !== resolved) } });
    process.stdout.write(`CLI directory removed: ${resolved}\n`);
  });

  const plugin = command.command("plugin").description("Enable or disable opt-in local Tool extensions");
  plugin.command("list").action(async () => {
    const config = await store.loadConfig();
    for (const name of config.plugins.enabled) process.stdout.write(`${name}\n`);
  });
  plugin.command("enable").argument("<name>").action(async (name: string) => {
    const config = await store.loadConfig();
    await store.saveConfig({ ...config, plugins: { enabled: [...new Set([...config.plugins.enabled, name])] } });
    process.stdout.write(`Enabled local Tool extension: ${name}\n`);
  });
  plugin.command("disable").argument("<name>").action(async (name: string) => {
    const config = await store.loadConfig();
    await store.saveConfig({ ...config, plugins: { enabled: config.plugins.enabled.filter((item) => item !== name) } });
    process.stdout.write(`Disabled local Tool extension: ${name}\n`);
  });

  const credential = command.command("credential").description("Manage non-secret credential references");
  credential
    .command("set-env")
    .argument("<provider>")
    .argument("<variable>")
    .description("Use an environment variable for a provider; command-line literal API keys are never accepted")
    .action(async (provider: string, variable: string) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(variable)) throw new CjError("CONFIG_INVALID", "Use an uppercase environment variable name");
      const auth = await store.loadAuth();
      await store.saveAuth({ ...auth, providers: { ...auth.providers, [provider]: { type: "env", variable } } });
      process.stdout.write(`Credential reference saved for ${provider}.\n`);
    });
  credential.command("remove").argument("<provider>").description("Remove a stored credential reference").action(async (provider: string) => {
    const auth = await store.loadAuth();
    if (!auth.providers[provider]) throw new CjError("CONFIG_INVALID", `No credentials configured for ${provider}`);
    const { [provider]: _removed, ...providers } = auth.providers;
    await store.saveAuth({ ...auth, providers });
    process.stdout.write(`Credential reference removed for ${provider}.\n`);
  });
}
