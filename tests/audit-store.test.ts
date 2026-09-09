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

  it("records clarification metadata without the user's answer", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cj-audit-test-"));
    created.push(directory);
    const store = new AuditStore(path.join(directory, "history.jsonl"));
    const task = store.createTaskContext({ cliVersion: "test", cwd: directory, provider: "fake", model: "fake", promptHash: "hash" });
    await store.taskStarted(task);
    await store.agentEvent(task.taskId, {
      type: "question_requested",
      request: { question: "What is the secret?", options: [{ label: "A" }], multiple: false }
    });
    await store.agentEvent(task.taskId, { type: "question_resolved", selectedCount: 1, hasCustomInput: true });
    const text = await readFile(store.file, "utf8");
    expect(text).not.toContain("What is the secret?");
    expect(text).toContain("questionLength");
    expect(text).toContain("hasCustomInput");
  });

  it("returns an empty history when the file does not exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-audit-test-"));
    created.push(root);
    await expect(new AuditStore(path.join(root, "missing.jsonl")).list()).resolves.toEqual([]);
  });

  it("exports one task when given an unambiguous task ID prefix", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-audit-test-"));
    created.push(root);
    const store = new AuditStore(path.join(root, "history.jsonl"));
    const first = store.createTaskContext({ cliVersion: "test", cwd: root, provider: "fake", model: "fake", promptHash: "first" });
    const second = store.createTaskContext({ cliVersion: "test", cwd: root, provider: "fake", model: "fake", promptHash: "second" });
    await store.taskStarted(first);
    await store.taskFinished(first.taskId, true);
    await store.taskStarted(second);

    const output = path.join(root, "one-task.jsonl");
    await expect(store.exportTo(output, { task: first.taskId.slice(0, 12) })).resolves.toEqual({ count: 2, taskId: first.taskId });
    const records = (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { taskId: string });
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.taskId === first.taskId)).toBe(true);
  });

  it("refuses an ambiguous task ID prefix", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-audit-test-"));
    created.push(root);
    const store = new AuditStore(path.join(root, "history.jsonl"));
    const first = { ...store.createTaskContext({ cliVersion: "test", cwd: root, provider: "fake", model: "fake", promptHash: "first" }), taskId: "shared-first" };
    const second = { ...store.createTaskContext({ cliVersion: "test", cwd: root, provider: "fake", model: "fake", promptHash: "second" }), taskId: "shared-second" };
    await store.taskStarted(first);
    await store.taskStarted(second);
    await expect(store.recordsForTask("shared")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("exports every record in one chat session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-audit-test-"));
    created.push(root);
    const store = new AuditStore(path.join(root, "history.jsonl"));
    const sessionId = "chat-session-1";
    const first = { ...store.createTaskContext({ cliVersion: "test", cwd: root, provider: "fake", model: "fake", promptHash: "first" }), sessionId };
    const second = { ...store.createTaskContext({ cliVersion: "test", cwd: root, provider: "fake", model: "fake", promptHash: "second" }), sessionId };
    await store.taskStarted(first);
    await store.taskFinished(first.taskId, true);
    await store.taskStarted(second);

    const output = path.join(root, "session.jsonl");
    await expect(store.exportTo(output, { session: "chat-session" })).resolves.toEqual({ count: 3, sessionId });
    const records = (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sessionId?: string });
    expect(records.every((record) => record.sessionId === sessionId)).toBe(true);
  });

  it("groups noisy streaming events into one task summary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-audit-test-"));
    created.push(root);
    const store = new AuditStore(path.join(root, "history.jsonl"));
    const first = store.createTaskContext({ cliVersion: "test", cwd: root, provider: "fake", model: "fake", promptHash: "first" });
    const second = store.createTaskContext({ cliVersion: "test", cwd: root, provider: "fake", model: "fake", promptHash: "second" });
    await store.taskStarted(first);
    await store.agentEvent(first.taskId, { type: "tool_start", name: "list_files", summary: "list", riskLevel: "low" });
    await store.agentEvent(first.taskId, { type: "assistant_delta", content: "one" });
    await store.agentEvent(first.taskId, { type: "assistant_delta", content: "two" });
    await store.taskFinished(first.taskId, true);
    await store.taskStarted(second);
    await store.taskFinished(second.taskId, false, "TOOL_FAILED");

    const summaries = await store.listTaskSummaries();
    expect(summaries).toEqual([
      expect.objectContaining({ taskId: first.taskId, status: "completed", toolCalls: 1, eventCount: 5 }),
      expect.objectContaining({ taskId: second.taskId, status: "failed", errorCode: "TOOL_FAILED", eventCount: 2 })
    ]);
    await expect(store.listTaskSummaries(1)).resolves.toEqual([
      expect.objectContaining({ taskId: second.taskId })
    ]);
  });

  it("aggregates request usage and groups chat turns under the first title", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-audit-test-"));
    created.push(root);
    const store = new AuditStore(path.join(root, "history.jsonl"));
    const sessionId = "session-grouped";
    const first = { ...store.createTaskContext({ cliVersion: "test", cwd: root, provider: "fake", model: "fake", promptHash: "first" }), sessionId };
    const second = { ...store.createTaskContext({ cliVersion: "test", cwd: root, provider: "fake", model: "fake", promptHash: "second" }), sessionId };
    await store.taskStarted(first);
    await store.agentEvent(first.taskId, { type: "task_title", title: "First topic", generated: true });
    await store.agentEvent(first.taskId, { type: "model_usage", requestId: "one", model: "fake", purpose: "title", success: true, usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5, cachedInputTokens: 3, uncachedInputTokens: 1, reasoningTokens: 1 } });
    await store.taskFinished(first.taskId, true);
    await store.taskStarted(second);
    await store.agentEvent(second.taskId, { type: "task_title", title: "Later turn", generated: true });
    await store.agentEvent(second.taskId, { type: "model_usage", requestId: "two", model: "fake", purpose: "agent", success: false });
    await store.agentEvent(second.taskId, { type: "model_usage", requestId: "three", model: "fake", purpose: "agent", success: true, usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 } });
    await store.taskFinished(second.taskId, false, "ABORTED");

    expect(await store.listHistorySummaries()).toEqual([
      expect.objectContaining({
        kind: "chat", sessionId, title: "First topic", turns: 2, cancelledTurns: 1,
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cachedInputTokens: 3, uncachedInputTokens: 1, reasoningTokens: 1 },
        usageRequests: 3, unknownUsageRequests: 1, cacheReportedRequests: 1, reasoningReportedRequests: 1
      })
    ]);
  });

  it("exports an escaped standalone HTML report", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-audit-test-"));
    created.push(root);
    const store = new AuditStore(path.join(root, "history.jsonl"));
    const context = store.createTaskContext({ cliVersion: "test", cwd: root, provider: "fake", model: "fake", promptHash: "html" });
    await store.taskStarted(context);
    await store.agentEvent(context.taskId, { type: "status", message: "<script>alert('unsafe')</script>" });
    await store.agentEvent(context.taskId, { type: "assistant_delta", content: "one" });
    await store.agentEvent(context.taskId, { type: "assistant_delta", content: "two" });
    await store.taskFinished(context.taskId, true);

    const output = path.join(root, "one-task.html");
    await expect(store.exportTo(output, { task: context.taskId }, "html")).resolves.toEqual({ count: 5, taskId: context.taskId });
    const html = await readFile(output, "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("任务摘要");
    expect(html).toContain("Chat 会话摘要");
    expect(html).toContain(context.taskId);
    expect(html).toContain("合并 2 个片段");
    expect(html).toContain("&lt;script&gt;alert(&#39;unsafe&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('unsafe')</script>");
  });
});
