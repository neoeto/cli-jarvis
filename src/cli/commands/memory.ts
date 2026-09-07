import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";
import type { ConfigStore } from "../../config/store.js";
import type { MemoryStore } from "../../memory/store.js";
import { CjError } from "../../shared/errors.js";

export function addMemoryCommand(program: Command, configStore: ConfigStore, memoryStore: MemoryStore): void {
  const command = program.command("memory").description("Manage explicit local memory (disabled by default)");
  command.command("on").description("Enable memory for future tasks").action(async () => {
    const config = await configStore.loadConfig();
    await configStore.saveConfig({ ...config, memory: { enabled: true } });
    process.stdout.write("Local memory enabled. Only facts added with `cj memory add` are used.\n");
  });
  command.command("off").description("Disable memory without deleting it").action(async () => {
    const config = await configStore.loadConfig();
    await configStore.saveConfig({ ...config, memory: { enabled: false } });
    process.stdout.write("Local memory disabled. Stored facts were not deleted.\n");
  });
  command.command("list").description("List local facts").action(async () => {
    const facts = await memoryStore.list();
    for (const fact of facts) process.stdout.write(`${fact.id}\t${fact.createdAt}\t${fact.text}\n`);
  });
  command.command("add").argument("<text...>").description("Explicitly add one preference or fact").action(async (parts: string[]) => {
    const fact = await memoryStore.add(parts.join(" "));
    process.stdout.write(`Saved memory ${fact.id}\n`);
  });
  command.command("forget").argument("<id>").description("Remove one local fact").action(async (id: string) => {
    if (!(await memoryStore.forget(id))) throw new CjError("CONFIG_INVALID", `Unknown memory id: ${id}`);
    process.stdout.write("Memory removed.\n");
  });
  command.command("clear").description("Delete all local facts after confirmation").action(async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new CjError("CONFIRMATION_REQUIRED", "Clearing memory requires an interactive confirmation");
    }
    if (!(await confirm({ message: "Delete every local memory fact?", default: false }))) {
      throw new CjError("CONFIRMATION_REJECTED", "The user rejected clearing memory");
    }
    await memoryStore.clear();
    process.stdout.write("All local memory facts were removed.\n");
  });
}
