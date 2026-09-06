import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MoveFilesTool } from "../src/tools/builtins/move-files.js";

const created: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cj-move-test-"));
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("MoveFilesTool", () => {
  it("moves a file to a free destination as medium risk", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "from.txt"), "data");
    const tool = new MoveFilesTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(
      tool.parse({ moves: [{ source: "from.txt", destination: "to.txt" }] }),
      context
    );
    expect(action.riskLevel).toBe("medium");
    await tool.execute(action, context);
    await expect(readFile(path.join(root, "to.txt"), "utf8")).resolves.toBe("data");
  });

  it("marks destination overwrite as high risk", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "from.txt"), "new");
    await writeFile(path.join(root, "to.txt"), "old");
    const tool = new MoveFilesTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(
      tool.parse({ moves: [{ source: "from.txt", destination: "to.txt" }], overwrite: true }),
      context
    );
    expect(action.riskLevel).toBe("high");
    expect(action.effects).toContain("delete");
    await tool.execute(action, context);
    await expect(readFile(path.join(root, "to.txt"), "utf8")).resolves.toBe("new");
  });

  it("rejects an existing destination unless overwrite is explicit", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "from.txt"), "new");
    await writeFile(path.join(root, "to.txt"), "old");
    const tool = new MoveFilesTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    await expect(
      tool.prepare(
        tool.parse({ moves: [{ source: "from.txt", destination: "to.txt" }] }),
        context
      )
    ).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });
  });
});
