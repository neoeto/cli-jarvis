import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { minimalProcessEnvironment, platformShellInvocation, runProcess } from "../src/process/run.js";
import { RunCommandTool } from "../src/tools/builtins/run-command.js";

const created: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cj-command-test-"));
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("process execution", () => {
  it("builds a minimal environment without provider credentials", () => {
    const env = minimalProcessEnvironment({ EXPLICIT_VALUE: "yes" });
    expect(env.EXPLICIT_VALUE).toBe("yes");
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("captures bounded process output", async () => {
    const root = await workspace();
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(1000))"],
      cwd: root,
      env: minimalProcessEnvironment(),
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      maxOutputBytes: 100
    });
    expect(result).toMatchObject({ exitCode: 0, truncated: true });
    expect(Buffer.byteLength(result.stdout)).toBe(100);
  });

  it("terminates a process at its timeout", async () => {
    const root = await workspace();
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      env: minimalProcessEnvironment(),
      timeoutMs: 100,
      signal: new AbortController().signal
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("selects a platform-native shell invocation", () => {
    const invocation = platformShellInvocation("echo hello");
    expect(invocation.args.at(-1)).toBe("echo hello");
    expect(invocation.executable.length).toBeGreaterThan(0);
  });
});

describe("RunCommandTool", () => {
  it("is always high risk and redacts command output", async () => {
    const root = await workspace();
    const tool = new RunCommandTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const action = await tool.prepare(
      tool.parse({
        command: process.execPath,
        args: ["-e", "console.log('sk-abcdefghijklmnopqrstuvwxyz')"]
      }),
      context
    );
    expect(action.riskLevel).toBe("high");
    expect(action.summary).toContain(process.execPath);
    expect(action.summary).toContain("[REDACTED]");
    expect(action.summary).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    const result = await tool.execute(action, context);
    expect(result.success).toBe(true);
    expect(result.data?.stdout).toContain("[REDACTED]");
    expect(result.data?.stdout).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("rejects recognized privilege elevation", async () => {
    const root = await workspace();
    const tool = new RunCommandTool();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    await expect(tool.prepare(tool.parse({ command: "sudo", args: ["echo", "no"] }), context)).rejects.toMatchObject({
      code: "TOOL_INPUT_INVALID"
    });
  });
});
