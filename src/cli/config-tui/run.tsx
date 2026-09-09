import React from "react";
import { render } from "ink";
import type { ConfigStore } from "../../config/store.js";
import { CjError } from "../../shared/errors.js";
import { createConfigDraft } from "./model.js";
import { ConfigTuiApp } from "./app.js";
import { normalizeExternalCommand, refreshExternalTools, resolveExternalCommand } from "../../tools/external-cli.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createProvider } from "../../providers/deepseek.js";

async function validateExternalCommand(value: string): Promise<{ command: string; entry: string }> {
  const command = normalizeExternalCommand(value);
  return { command, entry: await resolveExternalCommand(command) };
}

async function currentExternalEntries(commands: readonly string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(commands.map(async (command) => {
    try { return [command, await resolveExternalCommand(command)] as const; }
    catch { return [command, ""] as const; }
  }));
  return Object.fromEntries(entries);
}

export async function runConfigTui(store: ConfigStore): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdout.columns < 80 || process.stdout.rows < 24) {
    throw new CjError("CONFIG_INVALID", "cj config tui requires an interactive terminal of at least 80 columns by 24 rows");
  }
  const before = await store.loadConfig();
  const initial = createConfigDraft(before, await store.loadAuth());
  let addedCommands: string[] = [];
  const instance = render(<ConfigTuiApp
    initial={initial}
    externalEntries={await currentExternalEntries(before.externalCli.commands)}
    validateExternalCommand={validateExternalCommand}
    onApply={async (draft) => {
      addedCommands = draft.config.externalCli.commands.filter((command) => !before.externalCli.commands.includes(command));
      await store.saveSettings(draft.config, draft.auth);
    }}
  />, { exitOnCtrlC: false });
  await instance.waitUntilExit();

  if (!addedCommands.length) return;
  const config = await store.loadConfig();
  const diagnostics = await refreshExternalTools({
    registry: new ToolRegistry(),
    config,
    stateDir: store.paths.stateDir,
    signal: AbortSignal.timeout(config.limits.taskTimeoutMs),
    commands: addedCommands,
    provider: async () => createProvider(config, await store.resolveApiKey(config.provider.id))
  });
  for (const result of diagnostics) {
    process.stdout.write(`${result.status}\t${result.command}\t${result.entry}\t${result.message}\n`);
  }
  if (diagnostics.some((result) => result.status !== "approved" && result.status !== "partial")) process.exitCode = 1;
}
