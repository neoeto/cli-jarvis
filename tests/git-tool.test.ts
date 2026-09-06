import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitTool } from "../src/tools/builtins/git.js";

const execFileAsync = promisify(execFile);
const created: string[] = [];

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cj-git-test-"));
  created.push(root);
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "CJ Test"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "cj@example.invalid"], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("GitTool", () => {
  it("runs status as a low-risk structured operation", async () => {
    const root = await repository();
    await writeFile(path.join(root, "file.txt"), "content");
    const tool = new GitTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(tool.parse({ action: "status" }), context);
    expect(action.riskLevel).toBe("low");
    const result = await tool.execute(action, context);
    expect(result.success).toBe(true);
    expect(result.data?.stdout).toContain("file.txt");
  });

  it("marks add as medium and commit as high risk", async () => {
    const root = await repository();
    await writeFile(path.join(root, "file.txt"), "content");
    const tool = new GitTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const add = await tool.prepare(tool.parse({ action: "add", paths: ["file.txt"] }), context);
    expect(add.riskLevel).toBe("medium");
    await tool.execute(add, context);
    const commit = await tool.prepare(tool.parse({ action: "commit", message: "test commit" }), context);
    expect(commit.riskLevel).toBe("high");
    expect(commit.reversible).toBe(false);
  });

  it("can stage a deleted path without weakening parent path checks", async () => {
    const root = await repository();
    const file = path.join(root, "deleted.txt");
    await writeFile(file, "content");
    await execFileAsync("git", ["add", "deleted.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "seed"], { cwd: root });
    await unlink(file);

    const tool = new GitTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(tool.parse({ action: "add", paths: ["deleted.txt"] }), context);
    const result = await tool.execute(action, context);

    expect(result.success).toBe(true);
    const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-status"], { cwd: root });
    expect(stdout).toContain("D\tdeleted.txt");
  });

  it("rejects a non-repository working directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-not-git-test-"));
    created.push(root);
    const tool = new GitTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    await expect(tool.prepare(tool.parse({ action: "status" }), context)).rejects.toMatchObject({
      code: "TOOL_INPUT_INVALID"
    });
  });
});
