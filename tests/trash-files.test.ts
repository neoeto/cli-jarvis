import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { trashMock } = vi.hoisted(() => ({
  trashMock: vi.fn(async (_paths: string[]) => undefined)
}));
vi.mock("trash", () => ({ default: trashMock }));

import { TrashFilesTool } from "../src/tools/builtins/trash-files.js";

const created: string[] = [];

afterEach(async () => {
  trashMock.mockClear();
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("TrashFilesTool", () => {
  it("declares regular workspace files as reversible medium risk", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-trash-test-"));
    created.push(root);
    const file = path.join(root, "file.txt");
    await writeFile(file, "data");
    const tool = new TrashFilesTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(tool.parse({ paths: ["file.txt"] }), context);
    expect(action).toMatchObject({ riskLevel: "medium", reversible: true });
    await tool.execute(action, context);
    expect(trashMock).toHaveBeenCalledWith([await realpath(file)]);
  });

  it("elevates directories to high risk", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-trash-test-"));
    created.push(root);
    await mkdir(path.join(root, "directory"));
    const tool = new TrashFilesTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(tool.parse({ paths: ["directory"] }), context);
    expect(action.riskLevel).toBe("high");
  });
});
