import { refreshExternalTools } from "../../tools/external-cli.js";
import { createProvider } from "../../providers/deepseek.js";
import type { Command } from "commander";
import type { ToolRegistry } from "../../tools/registry.js";
import type { ConfigStore } from "../../config/store.js";
import { discoverLocalTools } from "../../tools/extensions.js";

export function addToolsCommand(program: Command, registry: ToolRegistry, store?: ConfigStore): void {
  const command = program.command("tools")
    .description("Inspect tools and review external CLI capabilities")
    .addHelpText("after", `
External CLIs are discovered in directories configured with cj config cli-dir.
Before each task, new or changed CLIs are reviewed automatically. Only documented,
approved capabilities are registered; execution still requires confirmation.

list, show and doctor use cached external CLI reviews without running help probes
or contacting a model. refresh collects help and uses the selected model as needed.

Examples:
  cj tools list
  cj tools show <name>
  cj tools doctor
  cj tools refresh --force
`);
  const external = async (refresh = false, force = false) => {
    if (!store) return [];
    let config = await store.loadConfig();
    const profileName = program.opts().profile as string | undefined;
    if (profileName) {
      const profile = config.profiles[profileName];
      if (!profile) throw new Error(`Unknown profile: ${profileName}`);
      config = { ...config, provider: profile.provider, limits: profile.limits, activeProfile: profileName };
    }
    return refreshExternalTools({ registry, config, stateDir: store.paths.stateDir, signal: AbortSignal.timeout(config.limits.taskTimeoutMs), force,
      ...(refresh ? { provider: async () => createProvider(config, await store.resolveApiKey(config.provider.id)) } : {}) });
  };
  command.command("refresh")
    .description("Collect help and review new or changed external CLIs with the selected model")
    .option("--force", "Recollect help and repeat review, including previous rejections")
    .addHelpText("after", "\nChecks configured CLI directories and caches review results. Documentation failures\nleave the affected capabilities unregistered. Use cj tools doctor for details.\n")
    .action(async (options: { force?: boolean }) => {
    for (const result of await external(true, options.force)) process.stdout.write(`${result.status}\t${result.entry}\t${result.message}\n`);
  });
  const loadExtensions = async (): Promise<void> => {
    if (!store) return;
    const config = await store.loadConfig();
    const diagnostics = await discoverLocalTools(registry, store.paths.toolsDir, config.plugins.enabled);
    const failed = diagnostics.filter((item) => item.enabled && !item.ok);
    if (failed.length) throw new Error(`Enabled Tool extension failed validation: ${failed.map((item) => item.name ?? item.directory).join(", ")}`);
  };
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
      process.stdout.write(
        `${JSON.stringify(
          {
            ...tool.definition.function,
            defaultRisk: tool.defaultRisk,
            possibleEffects: tool.possibleEffects
          },
          null,
          2
        )}\n`
      );
    });
  command
    .command("doctor")
    .description("Check SDK extensions and show external CLI review status and reasons")
    .action(async () => {
      if (!store) {
        process.stdout.write("No local Tool directory is configured.\n");
        return;
      }
      const config = await store.loadConfig();
      const diagnostics = await discoverLocalTools(registry, store.paths.toolsDir, config.plugins.enabled);
      const externalDiagnostics = await external();
      for (const result of externalDiagnostics) process.stdout.write(`${result.status}\t${result.entry}\t${result.message}\n`);
      if (diagnostics.length === 0 && externalDiagnostics.length === 0) {
        process.stdout.write("No SDK extensions or external CLI candidates found.\n");
        return;
      }
      for (const result of diagnostics) {
        process.stdout.write(`${result.ok ? "✓" : "✗"}\t${result.name ?? result.directory}\t${result.enabled ? "enabled" : "disabled"}\t${result.message}\n`);
      }
      if (diagnostics.some((result) => result.enabled && !result.ok)) process.exitCode = 1;
    });
}
