import React from "react";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { render } from "ink";
import type { ConfigStore } from "../../config/store.js";
import { CjError } from "../../shared/errors.js";
import { createConfigDraft } from "./model.js";
import { ConfigTuiApp } from "./app.js";

async function validateExternalDirectory(value: string): Promise<string> {
  const resolved = await realpath(path.resolve(value.trim()));
  if (!(await stat(resolved)).isDirectory()) throw new CjError("CONFIG_INVALID", "CLI root must be a directory");
  return resolved;
}

export async function runConfigTui(store: ConfigStore): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdout.columns < 80 || process.stdout.rows < 24) {
    throw new CjError("CONFIG_INVALID", "cj config tui requires an interactive terminal of at least 80 columns by 24 rows");
  }
  const initial = createConfigDraft(await store.loadConfig(), await store.loadAuth());
  const instance = render(<ConfigTuiApp
    initial={initial}
    validateExternalDirectory={validateExternalDirectory}
    onApply={async (draft) => store.saveSettings(draft.config, draft.auth)}
  />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
}
