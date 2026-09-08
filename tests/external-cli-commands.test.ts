import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config/store.js";
import { getAppPaths } from "../src/config/paths.js";
import { addConfigCommand } from "../src/cli/commands/config.js";
import { addToolsCommand } from "../src/cli/commands/tools.js";
import { ToolRegistry } from "../src/tools/registry.js";

const created: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
it("adds normalized roots idempotently, lists them and removes missing directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cj-cli-config-")); created.push(root);
  const directory = path.join(await realpath(root), "bin"); await mkdir(directory);
  const store = new ConfigStore(getAppPaths({ CJ_CONFIG_DIR: path.join(root, "config") }));
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const run = async (...args: string[]) => {
    const program = new Command(); addConfigCommand(program, store); await program.parseAsync(args, { from: "user" });
  };
  await run("config", "cli-dir", "add", `${directory}/.`);
  await run("config", "cli-dir", "add", directory);
  expect((await store.loadConfig()).externalCli.directories).toEqual([directory]);
  await run("config", "cli-dir", "list"); expect(output).toHaveBeenCalledWith(`${directory}\n`);
  await rm(directory, { recursive: true });
  await run("config", "cli-dir", "remove", directory);
  expect((await store.loadConfig()).externalCli.directories).toEqual([]);
});
it("inspection and empty refresh work without credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cj-cli-tools-")); created.push(root);
  const store = new ConfigStore(getAppPaths({ CJ_CONFIG_DIR: root }));
  const credential = vi.spyOn(store, "resolveApiKey");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  for (const args of [["tools", "list"], ["tools", "doctor"], ["tools", "refresh", "--force"]]) {
    const program = new Command(); addToolsCommand(program, new ToolRegistry(), store);
    await program.parseAsync(args, { from: "user" });
  }
  expect(credential).not.toHaveBeenCalled();
});

it("reports and disables Tavily web search without removing its credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cj-web-search-config-")); created.push(root);
  const store = new ConfigStore(getAppPaths({ CJ_CONFIG_DIR: root }));
  await store.saveConfig({ ...(await store.loadConfig()), webSearch: { enabled: true } });
  await store.saveAuth({ version: 1, providers: { tavily: { type: "env", variable: "TAVILY_API_KEY" } } });
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const run = async (...args: string[]) => {
    const program = new Command(); addConfigCommand(program, store); await program.parseAsync(args, { from: "user" });
  };
  await run("config", "web-search", "status");
  expect(output).toHaveBeenCalledWith("enabled\ttavily\tenv:TAVILY_API_KEY\n");
  await run("config", "web-search", "disable");
  expect((await store.loadConfig()).webSearch.enabled).toBe(false);
  expect((await store.loadAuth()).providers.tavily).toEqual({ type: "env", variable: "TAVILY_API_KEY" });
});
