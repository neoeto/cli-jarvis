import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ListFilesTool } from "../src/tools/builtins/list-files.js";

const created: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ListFilesTool", () => {
  it("lists workspace entries recursively without hidden files", async () => {
    const root = await temporaryDirectory("cj-files-test-");
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "visible.txt"), "hello");
    await writeFile(path.join(root, ".hidden"), "secret");
    await writeFile(path.join(root, "nested", "child.txt"), "world");

    const controller = new AbortController();
    const tool = new ListFilesTool();
    const context = { workspaceRoot: root, signal: controller.signal };
    const input = tool.parse({ path: ".", recursive: true });
    const action = await tool.prepare(input, context);
    const result = await tool.execute(action, context);

    expect(result.success).toBe(true);
    expect(result.data?.entries.map((entry) => entry.path)).toEqual([
      "nested",
      path.join("nested", "child.txt"),
      "visible.txt"
    ]);
  });

  it("elevates a symlink that escapes the workspace to high risk", async () => {
    const root = await temporaryDirectory("cj-root-test-");
    const outside = await temporaryDirectory("cj-outside-test-");
    await symlink(outside, path.join(root, "outside"), process.platform === "win32" ? "junction" : "dir");
    const tool = new ListFilesTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    const action = await tool.prepare(tool.parse({ path: "outside" }), context);
    expect(action.riskLevel).toBe("high");
    expect(action.targets).toEqual([await realpath(outside)]);
  });
});
