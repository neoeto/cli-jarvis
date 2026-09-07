import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/store.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("MemoryStore", () => {
  it("stores only explicit facts in an owner-only local file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cj-memory-test-"));
    created.push(directory);
    const store = new MemoryStore(path.join(directory, "memory.json"));
    const fact = await store.add("Use concise replies.");
    expect(await store.list()).toEqual([expect.objectContaining({ id: fact.id, text: "Use concise replies." })]);
    if (process.platform !== "win32") expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    expect(await store.forget(fact.id)).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("rejects a memory file made readable by other users", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(path.join(os.tmpdir(), "cj-memory-test-"));
    created.push(directory);
    const store = new MemoryStore(path.join(directory, "memory.json"));
    await store.add("Never expose secrets.");
    await chmod(store.file, 0o644);
    await expect(store.list()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
