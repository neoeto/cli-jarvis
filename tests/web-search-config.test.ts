import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const { inputMock, passwordMock, selectMock } = vi.hoisted(() => ({
  inputMock: vi.fn(),
  passwordMock: vi.fn(),
  selectMock: vi.fn()
}));
vi.mock("@inquirer/prompts", () => ({ input: inputMock, password: passwordMock, select: selectMock }));

import { addConfigCommand } from "../src/cli/commands/config.js";
import { ConfigStore } from "../src/config/store.js";
import { getAppPaths } from "../src/config/paths.js";

const created: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("web-search configuration", () => {
  it("configures an environment credential and enables Tavily atomically", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cj-web-search-setup-"));
    created.push(directory);
    const store = new ConfigStore(getAppPaths({ CJ_CONFIG_DIR: directory }));
    selectMock.mockResolvedValue("env");
    inputMock.mockResolvedValue("TAVILY_API_KEY");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = new Command();
    addConfigCommand(program, store);

    await program.parseAsync(["config", "web-search", "configure"], { from: "user" });

    expect((await store.loadConfig()).webSearch).toEqual({ enabled: true });
    expect((await store.loadAuth()).providers.tavily).toEqual({ type: "env", variable: "TAVILY_API_KEY" });
    expect(passwordMock).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith("Tavily 网络搜索已启用。每次搜索都需要确认。\n");
  });
});
