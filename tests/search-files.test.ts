import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SearchFilesTool } from "../src/tools/builtins/search-files.js";

const created: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cj-search-test-"));
  created.push(root);
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "small.txt"), "needle");
  await writeFile(path.join(root, "medium.log"), Buffer.alloc(100, "m"));
  await writeFile(path.join(root, "nested", "large.txt"), Buffer.alloc(1_000, "l"));
  await writeFile(path.join(root, "nested", "match.md"), "A Secret Phrase lives here");
  await writeFile(path.join(root, ".hidden.txt"), Buffer.alloc(2_000, "h"));
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SearchFilesTool", () => {
  it("filters by file size and sorts before applying the result limit", async () => {
    const root = await fixture();
    const tool = new SearchFilesTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(
      tool.parse({
        minSizeBytes: 50,
        types: ["file"],
        sortBy: "size",
        sortOrder: "desc",
        limit: 2
      }),
      context
    );
    const result = await tool.execute(action, context);

    expect(result.data?.matched).toBe(2);
    expect(result.data?.entries.map((entry) => [entry.path, entry.size])).toEqual([
      [path.join("nested", "large.txt"), 1_000],
      ["medium.log", 100]
    ]);
  });

  it("finds literal text without returning file contents", async () => {
    const root = await fixture();
    const tool = new SearchFilesTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(
      tool.parse({ contentContains: "secret phrase", extensions: ["md"] }),
      context
    );
    const result = await tool.execute(action, context);

    expect(result.data?.entries).toEqual([
      expect.objectContaining({ path: path.join("nested", "match.md"), contentMatched: true })
    ]);
    expect(JSON.stringify(result.data)).not.toContain("A Secret Phrase lives here");
  });

  it("filters names case-insensitively and ignores hidden entries by default", async () => {
    const root = await fixture();
    const tool = new SearchFilesTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(tool.parse({ nameContains: "LARGE" }), context);
    const result = await tool.execute(action, context);

    expect(result.data?.entries.map((entry) => entry.path)).toEqual([path.join("nested", "large.txt")]);
    expect(result.data?.entries.some((entry) => entry.path.includes("hidden"))).toBe(false);
  });

  it("rejects an inverted size range", () => {
    const tool = new SearchFilesTool();
    expect(() => tool.parse({ minSizeBytes: 10, maxSizeBytes: 5 })).toThrow(/minSizeBytes/);
  });
});
