import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadFileTool } from "../src/tools/builtins/read-file.js";

const created: string[] = [];

async function temporaryDirectory(prefix = "cj-read-test-"): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ReadFileTool", () => {
  it("reads a bounded line range and redacts recognized secrets", async () => {
    const root = await temporaryDirectory();
    await writeFile(
      path.join(root, "notes.txt"),
      "first\napi_key=super-secret-value\nthird\nfourth\n"
    );
    const tool = new ReadFileTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(
      tool.parse({ path: "notes.txt", startLine: 2, maxLines: 2 }),
      context
    );
    const result = await tool.execute(action, context);

    expect(result.data).toMatchObject({
      path: "notes.txt",
      content: "api_key=[REDACTED]\nthird",
      startLine: 2,
      endLine: 3,
      truncated: true,
      redactions: 1
    });
  });

  it("blocks a recognized credential file unless sensitive access is requested", async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, ".env"), "TOKEN=secret-value");
    const tool = new ReadFileTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    await expect(tool.prepare(tool.parse({ path: ".env" }), context)).rejects.toMatchObject({
      code: "SENSITIVE_DATA_BLOCKED"
    });
    const action = await tool.prepare(tool.parse({ path: ".env", allowSensitive: true }), context);
    expect(action.riskLevel).toBe("high");
    expect(action.summary).toContain("unredacted");
  });

  it("requires confirmation for a file reached through an external symlink", async () => {
    const root = await temporaryDirectory("cj-read-root-");
    const outside = await temporaryDirectory("cj-read-outside-");
    await writeFile(path.join(outside, "outside.txt"), "outside");
    await symlink(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    const tool = new ReadFileTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(tool.parse({ path: path.join("link", "outside.txt") }), context);
    expect(action.riskLevel).toBe("high");
  });

  it("rejects binary content", async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, "binary.bin"), Buffer.from([1, 0, 2]));
    const tool = new ReadFileTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(tool.parse({ path: "binary.bin" }), context);
    await expect(tool.execute(action, context)).rejects.toMatchObject({ code: "TOOL_FAILED" });
  });
});
