import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditStore } from "../src/audit/store.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AuditStore", () => {
  it("records redacted metadata without assistant content or confirmation targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-audit-test-"));
    created.push(root);
    const file = path.join(root, "history.jsonl");
    const store = new AuditStore(file);
    const context = store.createTaskContext({
      cliVersion: "0.1.0",
      cwd: root,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      promptHash: "hash"
    });
    await store.taskStarted(context);
    await store.agentEvent(context.taskId, {
      type: "tool_start",
      name: "run_command",
      riskLevel: "high",
      summary: "print sk-abcdefghijklmnopqrstuvwxyz"
    });
    await store.agentEvent(context.taskId, {
      type: "confirmation_requested",
      request: {
        actionId: "action",
        toolName: "run_command",
        summary: "run command",
        targets: ["/secret/path"],
        effects: ["process"]
      }
    });
    await store.agentEvent(context.taskId, { type: "assistant", content: "private full response" });
    await store.taskFinished(context.taskId, true);

    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(raw).not.toContain("/secret/path");
    expect(raw).not.toContain("private full response");
    expect(raw).toContain("[REDACTED]");
    expect(raw).toContain('"cliVersion":"0.1.0"');
    expect(await store.list()).toHaveLength(5);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("returns an empty history when the file does not exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-audit-test-"));
    created.push(root);
    await expect(new AuditStore(path.join(root, "missing.jsonl")).list()).resolves.toEqual([]);
  });
});
