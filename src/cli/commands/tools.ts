import type { Command } from "commander";
import type { ToolRegistry } from "../../tools/registry.js";

export function addToolsCommand(program: Command, registry: ToolRegistry): void {
  const command = program.command("tools").description("Inspect registered Tools");
  command
    .command("list")
    .description("List registered Tools")
    .action(() => {
      for (const tool of registry.entries()) {
        process.stdout.write(`${tool.definition.function.name}\t${tool.defaultRisk}\t${tool.definition.function.description}\n`);
      }
    });
  command
    .command("show")
    .argument("<name>")
    .description("Show one Tool definition")
    .action((name: string) => {
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
}
