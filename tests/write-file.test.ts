import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WriteFileTool } from "../src/tools/builtins/write-file.js";

const created: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cj-write-test-"));
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("WriteFileTool", () => {
  it("creates a new file as a medium-risk action", async () => {
    const root = await workspace();
    const tool = new WriteFileTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(
      tool.parse({ path: "created.txt", operation: "create", content: "hello" }),
      context
    );
    expect(action.riskLevel).toBe("medium");
    await tool.execute(action, context);
    await expect(readFile(path.join(root, "created.txt"), "utf8")).resolves.toBe("hello");
  });

  it("requires confirmation before overwriting and replaces atomically", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "existing.txt"), "old");
    const tool = new WriteFileTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(
      tool.parse({ path: "existing.txt", operation: "overwrite", content: "new" }),
      context
    );
    expect(action.riskLevel).toBe("high");
    expect(action.reversible).toBe(false);
    await tool.execute(action, context);
    await expect(readFile(path.join(root, "existing.txt"), "utf8")).resolves.toBe("new");
  });

  it("refuses execution when a file changes after preview", async () => {
    const root = await workspace();
    const file = path.join(root, "existing.txt");
    await writeFile(file, "old");
    const tool = new WriteFileTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(
      tool.parse({ path: "existing.txt", operation: "append", content: "tail" }),
      context
    );
    await writeFile(file, "changed-size");
    await expect(tool.execute(action, context)).rejects.toMatchObject({ code: "TOOL_FAILED" });
  });

  it("elevates writes outside the workspace", async () => {
    const root = await workspace();
    const outside = await workspace();
    const tool = new WriteFileTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(
      tool.parse({ path: path.join(outside, "new.txt"), operation: "create", content: "outside" }),
      context
    );
    expect(action.riskLevel).toBe("high");
  });
});
