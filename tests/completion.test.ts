import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addCompletionCommand, renderCompletion } from "../src/cli/completion.js";
import { ConfigStore } from "../src/config/store.js";
import { getAppPaths } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { ToolRegistry } from "../src/tools/registry.js";

const created: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("shell completion", () => {
  it("renders a runnable generator for every supported shell", () => {
    expect(renderCompletion("bash")).toContain("complete -F _cj_completion cj");
    expect(renderCompletion("zsh")).toContain("compdef _cj_completion cj");
    expect(renderCompletion("fish")).toContain("complete -c cj");
    expect(renderCompletion("powershell")).toContain("Register-ArgumentCompleter");
    for (const shell of ["bash", "zsh", "fish", "powershell"]) {
      expect(renderCompletion(shell as "bash" | "zsh" | "fish" | "powershell")).toContain("__complete");
    }
  });

  it("generates from the command tree and provides profile candidates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-completion-"));
    created.push(root);
    const store = new ConfigStore(getAppPaths({ CJ_CONFIG_DIR: root }));
    await store.saveConfig({
      ...defaultConfig,
      externalCli: { commands: ["greet", "kubectl"] },
      profiles: {
        ...defaultConfig.profiles,
        work: defaultConfig.profiles.default
      }
    });
    const program = new Command().name("cj").option("--profile <name>");
    program.command("chat").description("chat");
    const tools = program.command("tools");
    tools.command("show <name>").description("show");
    tools.command("unregister <command>").description("unregister");
    addCompletionCommand(program, store, new ToolRegistry());
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await program.parseAsync(["__complete", "bash", "--", "cj", "c"], { from: "user" });
    expect(output).toHaveBeenLastCalledWith("chat\ncompletion\n");
    await program.parseAsync(["__complete", "bash", "--", "cj", "--profile", ""], { from: "user" });
    expect(output).toHaveBeenLastCalledWith("default\nwork\n");
    await program.parseAsync(["__complete", "bash", "--", "cj", "--profile=wo"], { from: "user" });
    expect(output).toHaveBeenLastCalledWith("--profile=work\n");
    await program.parseAsync(["__complete", "bash", "--", "cj", "tools", "unregister", "k"], { from: "user" });
    expect(output).toHaveBeenLastCalledWith("kubectl\n");
    await program.parseAsync(["__complete", "bash", "--", "cj", ""], { from: "user" });
    expect(output.mock.lastCall?.[0]).toContain("--help\n");
  });

  it("does not expose the internal query command in generated help", async () => {
    const store = new ConfigStore(getAppPaths({ CJ_CONFIG_DIR: "/tmp/cj-completion-help" }));
    const program = new Command().name("cj");
    addCompletionCommand(program, store, new ToolRegistry());
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await program.parseAsync(["completion", "bash"], { from: "user" });
    expect(output.mock.calls[0]?.[0]).toContain("__complete");
    expect(program.helpInformation()).not.toContain("__complete");
  });
});
