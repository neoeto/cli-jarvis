import React from "react";
import { render } from "ink";
import type { ConfigStore } from "../../config/store.js";
import { CjError } from "../../shared/errors.js";
import { createConfigDraft } from "./model.js";
import { ConfigTuiApp } from "./app.js";
import { externalRegistrationLabel, normalizeExternalRegistration, refreshExternalTools, resolveExternalCommand, sameExternalRegistration } from "../../tools/external-cli.js";
import type { ExternalCliRegistration } from "../../config/schema.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createProvider } from "../../providers/deepseek.js";

async function validateExternalCommand(value: string): Promise<{ registration: ExternalCliRegistration; entry: string }> {
  const registration = normalizeExternalRegistration(value.trim().split(/\s+/).filter(Boolean));
  return { registration, entry: await resolveExternalCommand(registration.command) };
}

async function currentExternalEntries(registrations: readonly ExternalCliRegistration[]): Promise<Record<string, string>> {
  const entries = await Promise.all(registrations.map(async (registration) => {
    const label = externalRegistrationLabel(registration);
    try { return [label, await resolveExternalCommand(registration.command)] as const; }
    catch { return [label, ""] as const; }
  }));
  return Object.fromEntries(entries);
}

export async function runConfigTui(store: ConfigStore): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdout.columns < 80 || process.stdout.rows < 24) {
    throw new CjError("CONFIG_INVALID", "cj config tui requires an interactive terminal of at least 80 columns by 24 rows");
  }
  const before = await store.loadConfig();
  const initial = createConfigDraft(before, await store.loadAuth());
  let addedRegistrations: ExternalCliRegistration[] = [];
  const instance = render(<ConfigTuiApp
    initial={initial}
    externalEntries={await currentExternalEntries(before.externalCli.registrations)}
    validateExternalCommand={validateExternalCommand}
    onApply={async (draft) => {
      addedRegistrations = draft.config.externalCli.registrations.filter((registration) => !before.externalCli.registrations.some((item) => sameExternalRegistration(item, registration)));
      await store.saveSettings(draft.config, draft.auth);
    }}
  />, { exitOnCtrlC: false });
  await instance.waitUntilExit();

  if (!addedRegistrations.length) return;
  const config = await store.loadConfig();
  const diagnostics = await refreshExternalTools({
    registry: new ToolRegistry(),
    config,
    stateDir: store.paths.stateDir,
    signal: AbortSignal.timeout(config.limits.taskTimeoutMs),
    registrations: addedRegistrations,
    provider: async () => createProvider(config, await store.resolveApiKey(config.provider.id))
  });
  for (const result of diagnostics) {
    process.stdout.write(`${result.status}\t${result.command}\t${result.entry}\t${result.message}\n`);
  }
  if (diagnostics.some((result) => result.status !== "approved" && result.status !== "partial")) process.exitCode = 1;
}
