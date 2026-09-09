import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";

const { createProviderMock } = vi.hoisted(() => ({ createProviderMock: vi.fn() }));
vi.mock("../src/providers/deepseek.js", () => ({ createProvider: createProviderMock }));

import { ConfigStore } from "../src/config/store.js";
import { getAppPaths } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { addToolsCommand } from "../src/cli/commands/tools.js";
import { ToolRegistry } from "../src/tools/registry.js";

const created: string[] = [];
const originalPath = process.env.PATH;
const help = "Greet a person by name.\nUsage: greet --name NAME\nOptions:\n  --name NAME  Required person name to greet.\n";
const approvedReview = {
  capabilities: [{ command: [], description: "Greet a person using the supplied name.", example: "Usage: greet --name NAME", evidence: "Greet a person by name.", parameters: [{ name: "name", description: "Person name", type: "string", flag: "--name", required: true, choices: [], evidence: "--name NAME  Required person name to greet." }] }],
  rejected: []
};

afterEach(async () => {
  process.env.PATH = originalPath;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cj-cli-tools-")); created.push(root);
  const bin = path.join(root, "bin"); await mkdir(bin);
  const entry = path.join(bin, "greet");
  await writeFile(entry, `#!${process.execPath}\nconsole.log(${JSON.stringify(help)});\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  const store = new ConfigStore(getAppPaths({ CJ_CONFIG_DIR: path.join(root, "config") }));
  await store.saveAuth({ version: 1, providers: { deepseek: { type: "api_key", key: "test-key" } } });
  const complete = vi.fn(async () => ({ kind: "message" as const, content: JSON.stringify(approvedReview) }));
  createProviderMock.mockReturnValue({ id: "fake", complete });
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const run = async (...args: string[]) => {
    const program = new Command().option("--profile <name>");
    addToolsCommand(program, new ToolRegistry(), store);
    await program.parseAsync(args, { from: "user" });
  };
  return { root, bin, entry, store, complete, output, run };
}

it("registers a PATH command immediately and reuses its cached approval", async () => {
  const f = await fixture();
  await f.run("tools", "register", "greet");
  expect((await f.store.loadConfig()).externalCli.commands).toEqual(["greet"]);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.output).toHaveBeenLastCalledWith(expect.stringContaining(`approved\tgreet\t${f.entry}`));
  await f.run("tools", "register", "greet");
  expect(f.complete).toHaveBeenCalledTimes(1);
});

it("does not save missing commands and rejects paths or arguments", async () => {
  const f = await fixture();
  await expect(f.run("tools", "register", "missing")).rejects.toThrow("not an executable available on PATH");
  await expect(f.run("tools", "register", "./greet")).rejects.toThrow("without arguments or path separators");
  await expect(f.run("tools", "register", "greet --name Neo")).rejects.toThrow("without arguments or path separators");
  expect((await f.store.loadConfig()).externalCli.commands).toEqual([]);
});

it("lists cached registrations offline and unregisters them", async () => {
  const f = await fixture();
  await f.store.saveConfig({ ...(await f.store.loadConfig()), externalCli: { commands: ["greet"] } });
  await f.run("tools", "registrations");
  expect(f.output).toHaveBeenLastCalledWith(expect.stringContaining(`greet\t${f.entry}\tpending`));
  await f.run("tools", "unregister", "greet");
  expect((await f.store.loadConfig()).externalCli.commands).toEqual([]);
  await expect(f.run("tools", "unregister", "greet")).rejects.toThrow("not registered");
});

it("keeps a rejected registration for later refresh and uses a selected profile for review", async () => {
  const f = await fixture();
  const config = await f.store.loadConfig();
  await f.store.saveConfig({
    ...config,
    profiles: { ...config.profiles, work: { provider: { ...config.provider, id: "work" }, limits: config.limits } }
  });
  await f.store.saveAuth({ version: 1, providers: { deepseek: { type: "api_key", key: "test-key" }, work: { type: "api_key", key: "test-key" } } });
  f.complete.mockResolvedValueOnce({ kind: "message", content: JSON.stringify({ capabilities: [], rejected: [{ command: [], reason: "Insufficient documentation" }] }) });
  await f.run("--profile", "work", "tools", "register", "greet");
  expect((await f.store.loadConfig()).externalCli.commands).toEqual(["greet"]);
  expect(createProviderMock.mock.calls[0]?.[0]).toMatchObject({ provider: { id: "work" } });
  expect(process.exitCode).toBe(1);
});

it("inspects empty registrations without resolving credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cj-cli-tools-empty-")); created.push(root);
  const store = new ConfigStore(getAppPaths({ CJ_CONFIG_DIR: root }));
  const credential = vi.spyOn(store, "resolveApiKey");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  for (const args of [["tools", "list"], ["tools", "doctor"], ["tools", "refresh", "--force"], ["tools", "registrations"]]) {
    const program = new Command(); addToolsCommand(program, new ToolRegistry(), store);
    await program.parseAsync(args, { from: "user" });
  }
  expect(credential).not.toHaveBeenCalled();
  expect(output).toHaveBeenCalled();
});
