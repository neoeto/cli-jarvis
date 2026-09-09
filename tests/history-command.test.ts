import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { AuditStore } from "../src/audit/store.js";
import { addHistoryCommand } from "../src/cli/commands/history.js";

const created: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ store: AuditStore; sessionId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cj-history-command-"));
  created.push(root);
  const store = new AuditStore(path.join(root, "history.jsonl"));
  const sessionId = "session-history-test";
  for (const [index, title] of ["First chat title", "Second turn"].entries()) {
    const task = { ...store.createTaskContext({ cliVersion: "test", cwd: root, provider: "fake", model: "fake", promptHash: `${index}` }), sessionId };
    await store.taskStarted(task);
    await store.agentEvent(task.taskId, { type: "task_title", title, generated: true });
    await store.taskFinished(task.taskId, true);
  }
  const standalone = store.createTaskContext({ cliVersion: "test", cwd: root, provider: "fake", model: "fake", promptHash: "standalone" });
  await store.taskStarted(standalone);
  await store.agentEvent(standalone.taskId, { type: "task_title", title: "Standalone", generated: true });
  await store.taskFinished(standalone.taskId, true);
  return { store, sessionId };
}

async function run(store: AuditStore, args: string[]): Promise<string> {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const program = new Command().name("cj").exitOverride();
  addHistoryCommand(program, store);
  await program.parseAsync(["node", "cj", "history", ...args]);
  return output;
}

describe("history command summaries", () => {
  it("groups chats by default and exposes task/session drill-down", async () => {
    const { store, sessionId } = await fixture();
    const grouped = await run(store, []);
    expect(grouped.match(/chat:/g)).toHaveLength(1);
    expect(grouped.match(/task:/g)).toHaveLength(1);
    expect(grouped).toContain("First chat title");
    expect(grouped).toContain("turns:2");

    vi.restoreAllMocks();
    const tasks = await run(store, ["--tasks"]);
    expect(tasks.match(/task:/g)).toHaveLength(3);

    vi.restoreAllMocks();
    const session = await run(store, ["--session", sessionId.slice(0, 10)]);
    expect(session.match(/task:/g)).toHaveLength(2);
    expect(session).not.toContain("Standalone");
  });

  it("rejects raw-event and grouped-summary options together", async () => {
    const { store } = await fixture();
    await expect(run(store, ["--events", "--tasks"])).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
