import type { Command } from "commander";
import type { ToolRegistry } from "../../tools/registry.js";
import type { ConfigStore } from "../../config/store.js";
import { discoverLocalTools } from "../../tools/extensions.js";

export function addToolsCommand(program: Command, registry: ToolRegistry, store?: ConfigStore): void {
  const command = program.command("tools").description("Inspect registered Tools");
  const loadExtensions = async (): Promise<void> => {
    if (!store) return;
    const config = await store.loadConfig();
    const diagnostics = await discoverLocalTools(registry, store.paths.toolsDir, config.plugins.enabled);
    const failed = diagnostics.filter((item) => item.enabled && !item.ok);
    if (failed.length) throw new Error(`Enabled Tool extension failed validation: ${failed.map((item) => item.name ?? item.directory).join(", ")}`);
  };
  command
    .command("list")
    .description("List registered Tools")
    .action(async () => {
      await loadExtensions();
      for (const tool of registry.entries()) {
        process.stdout.write(`${tool.definition.function.name}\t${tool.defaultRisk}\t${registry.origin(tool.definition.function.name) ?? "builtin"}\t${tool.definition.function.description}\n`);
      }
    });
  command
    .command("show")
    .argument("<name>")
    .description("Show one Tool definition")
    .action(async (name: string) => {
      await loadExtensions();
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
    .description("Validate discovered local Tool manifests and enabled modules")
    .action(async () => {
      if (!store) {
        process.stdout.write("No local Tool directory is configured.\n");
        return;
      }
      const config = await store.loadConfig();
      const diagnostics = await discoverLocalTools(registry, store.paths.toolsDir, config.plugins.enabled);
      if (diagnostics.length === 0) {
        process.stdout.write("No local Tool manifests found.\n");
        return;
      }
      for (const result of diagnostics) {
        process.stdout.write(`${result.ok ? "✓" : "✗"}\t${result.name ?? result.directory}\t${result.enabled ? "enabled" : "disabled"}\t${result.message}\n`);
      }
      if (diagnostics.some((result) => result.enabled && !result.ok)) process.exitCode = 1;
    });
}
