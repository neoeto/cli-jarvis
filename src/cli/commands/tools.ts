import { normalizeExternalCommand, refreshExternalTools, resolveExternalCommand } from "../../tools/external-cli.js";
import { createProvider } from "../../providers/deepseek.js";
import type { Command } from "commander";
import type { ToolRegistry } from "../../tools/registry.js";
import type { ConfigStore } from "../../config/store.js";
import { discoverLocalTools } from "../../tools/extensions.js";
import { CjError } from "../../shared/errors.js";

export function addToolsCommand(program: Command, registry: ToolRegistry, store?: ConfigStore): void {
  const command = program.command("tools")
    .description("Inspect tools and manage PATH-registered external CLI capabilities")
    .addHelpText("after", `
Register one existing executable from PATH at a time. CJ collects bounded help
and reviews documented capabilities before exposing them as Tools. Every external
Tool remains high risk and requires confirmation at execution time.

list, show, registrations and doctor use cached reviews without running help
probes or contacting a model. register and refresh collect help and use the
selected model as needed.

Examples:
  cj tools register kubectl
  cj tools registrations
  cj tools unregister kubectl
  cj tools refresh --force
`);

  const external = async (refresh = false, force = false, commands?: readonly string[]) => {
    if (!store) return [];
    let config = await store.loadConfig();
    const profileName = program.opts().profile as string | undefined;
    if (profileName) {
      const profile = config.profiles[profileName];
      if (!profile) throw new CjError("CONFIG_INVALID", `Unknown profile: ${profileName}`);
      config = { ...config, provider: profile.provider, limits: profile.limits, activeProfile: profileName };
    }
    return refreshExternalTools({
      registry,
      config,
      stateDir: store.paths.stateDir,
      signal: AbortSignal.timeout(config.limits.taskTimeoutMs),
      force,
      ...(commands ? { commands } : {}),
      ...(refresh ? { provider: async () => createProvider(config, await store.resolveApiKey(config.provider.id)) } : {})
    });
  };

  const loadExtensions = async (): Promise<void> => {
    if (!store) return;
    const config = await store.loadConfig();
    const diagnostics = await discoverLocalTools(registry, store.paths.toolsDir, config.plugins.enabled);
    const failed = diagnostics.filter((item) => item.enabled && !item.ok);
    if (failed.length) throw new Error(`Enabled Tool extension failed validation: ${failed.map((item) => item.name ?? item.directory).join(", ")}`);
  };

  command.command("register")
    .description("Register one executable currently available on PATH and review it now")
    .argument("<command>", "one executable name, without a path or arguments")
    .action(async (value: string) => {
      if (!store) throw new CjError("CONFIG_INVALID", "Local configuration is unavailable");
      const registered = normalizeExternalCommand(value);
      // Do not persist names that cannot be resolved by this CJ process.
      await resolveExternalCommand(registered);
      const config = await store.loadConfig();
      if (!config.externalCli.commands.includes(registered)) {
        await store.saveConfig({ ...config, externalCli: { commands: [...config.externalCli.commands, registered] } });
      }
      const [result] = await external(true, false, [registered]);
      if (!result) throw new CjError("TOOL_FAILED", `Registered command was not available for review: ${registered}`);
      process.stdout.write(`${result.status}\t${result.command}\t${result.entry}\t${result.message}\n`);
      if (result.status !== "approved" && result.status !== "partial") process.exitCode = 1;
    });

  command.command("unregister")
    .description("Remove one PATH command registration without changing the executable")
    .argument("<command>", "registered command name")
    .action(async (value: string) => {
      if (!store) throw new CjError("CONFIG_INVALID", "Local configuration is unavailable");
      const registered = normalizeExternalCommand(value);
      const config = await store.loadConfig();
      if (!config.externalCli.commands.includes(registered)) {
        throw new CjError("CONFIG_INVALID", `Command is not registered: ${registered}`);
      }
      await store.saveConfig({ ...config, externalCli: { commands: config.externalCli.commands.filter((item) => item !== registered) } });
      registry.removeExternalTools();
      process.stdout.write(`Unregistered PATH CLI: ${registered}\n`);
    });

  command.command("registrations")
    .description("List registered PATH commands with their current resolution and cached review status")
    .action(async () => {
      for (const result of await external()) {
        process.stdout.write(`${result.command}\t${result.entry}\t${result.status}\t${result.message}\n`);
      }
    });

  command.command("refresh")
    .description("Collect help and review registered PATH CLIs with the selected model")
    .option("--force", "Recollect help and repeat review, including previous rejections")
    .addHelpText("after", "\nChecks every registered command using the current PATH. Documentation failures leave\nthe affected capabilities unavailable. Use cj tools doctor for details.\n")
    .action(async (options: { force?: boolean }) => {
      for (const result of await external(true, options.force)) {
        process.stdout.write(`${result.status}\t${result.command}\t${result.entry}\t${result.message}\n`);
      }
    });

  command
    .command("list")
    .description("List built-in, enabled SDK and cached approved external tools")
    .action(async () => {
      await loadExtensions();
      await external();
      for (const tool of registry.entries()) {
        process.stdout.write(`${tool.definition.function.name}\t${tool.defaultRisk}\t${registry.origin(tool.definition.function.name) ?? "builtin"}\t${tool.definition.function.description}\n`);
      }
    });

  command
    .command("show")
    .argument("<name>", "registered tool name from cj tools list")
    .description("Show a tool capability, parameter schema and execution risk")
    .action(async (name: string) => {
      await loadExtensions();
      await external();
      const tool = registry.get(name);
      process.stdout.write(`${JSON.stringify({ ...tool.definition.function, defaultRisk: tool.defaultRisk, possibleEffects: tool.possibleEffects }, null, 2)}\n`);
    });

  command
    .command("doctor")
    .description("Check SDK extensions and show PATH CLI review status and reasons")
    .action(async () => {
      if (!store) {
        process.stdout.write("No local Tool directory is configured.\n");
        return;
      }
      const config = await store.loadConfig();
      const diagnostics = await discoverLocalTools(registry, store.paths.toolsDir, config.plugins.enabled);
      const externalDiagnostics = await external();
      for (const result of externalDiagnostics) process.stdout.write(`${result.status}\t${result.command}\t${result.entry}\t${result.message}\n`);
      if (diagnostics.length === 0 && externalDiagnostics.length === 0) {
        process.stdout.write("No SDK extensions or registered PATH CLIs found.\n");
        return;
      }
      for (const result of diagnostics) {
        process.stdout.write(`${result.ok ? "✓" : "✗"}\t${result.name ?? result.directory}\t${result.enabled ? "enabled" : "disabled"}\t${result.message}\n`);
      }
      if (diagnostics.some((result) => result.enabled && !result.ok)) process.exitCode = 1;
    });
}
