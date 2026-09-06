import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createReadlineSessionInput, type SessionInput } from "../src/cli/session/input.js";
import { parseSessionInput } from "../src/cli/session/commands.js";
import { runInteractiveSession } from "../src/cli/session/repl.js";
import { CjError } from "../src/shared/errors.js";

class ScriptedInput implements SessionInput {
  readonly prompts: string[] = [];
  private interruptHandler?: () => void;
  private closed = false;

  constructor(private readonly values: Array<string | undefined>) {}

  next(prompt: string): Promise<string | undefined> {
    this.prompts.push(prompt);
    return Promise.resolve(this.values.shift());
  }

  onInterrupt(handler: () => void): () => void {
    this.interruptHandler = handler;
    return () => {
      this.interruptHandler = undefined;
    };
  }

  interrupt(): void {
    this.interruptHandler?.();
  }

  close(): void {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

const noopStatus = {
  startedAt: "2026-09-06T00:00:00.000Z",
  turns: 1,
  contextMessages: 3,
  provider: "fake",
  model: "fake-model",
  workspaceRoot: "/workspace"
};

describe("chat session", () => {
  it("keeps slash commands local and preserves multi-line prompts", () => {
    expect(parseSessionInput("/clear")).toEqual({ kind: "clear" });
    expect(parseSessionInput("/quit")).toEqual({ kind: "exit" });
    expect(parseSessionInput("/unknown")).toEqual({ kind: "unknown", name: "/unknown" });
    expect(parseSessionInput("/status\ninclude this too")).toEqual({
      kind: "prompt",
      prompt: "/status\ninclude this too"
    });
    expect(parseSessionInput("列出文件")).toEqual({ kind: "prompt", prompt: "列出文件" });
  });

  it("dispatches local commands without sending them to the model", async () => {
    const input = new ScriptedInput(["hello", "/status", "/tools", "/history", "/clear", "/exit"]);
    const writes: string[] = [];
    const prompts: string[] = [];
    let cleared = 0;

    await runInteractiveSession({
      input,
      language: "en",
      runPrompt: async (prompt) => {
        prompts.push(prompt);
      },
      clear: () => {
        cleared += 1;
      },
      status: () => noopStatus,
      tools: () => "Available Tools",
      history: async () => "No history.",
      write: (message) => writes.push(message),
      reportError: (error) => writes.push(error.message)
    });

    expect(prompts).toEqual(["hello"]);
    expect(cleared).toBe(1);
    expect(writes).toContain("Available Tools");
    expect(writes).toContain("No history.");
    expect(writes.some((message) => message.includes("Session status"))).toBe(true);
    expect(input.isClosed()).toBe(true);
  });

  it("cancels an active turn on the first interrupt and then allows exit", async () => {
    const input = new ScriptedInput(["long task", "/exit"]);
    const writes: string[] = [];
    let interrupted = false;

    await runInteractiveSession({
      input,
      language: "en",
      runPrompt: async (_prompt, signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => {
            interrupted = true;
            reject(new CjError("ABORTED", "Task aborted"));
          }, { once: true });
          setTimeout(() => input.interrupt(), 0);
        });
      },
      clear: () => undefined,
      status: () => noopStatus,
      tools: () => "Available Tools",
      history: async () => "No history.",
      write: (message) => writes.push(message),
      reportError: (error) => writes.push(`[${error.code}] ${error.message}`)
    });

    expect(interrupted).toBe(true);
    expect(writes).toContain("\nCancelling the current task…");
    expect(writes).toContain("Session closed.");
  });
});

describe("readline session input", () => {
  let input: PassThrough | undefined;
  let output: PassThrough | undefined;

  afterEach(() => {
    input?.destroy();
    output?.destroy();
    input = undefined;
    output = undefined;
  });

  it("joins lines arriving from one paste into a single prompt", async () => {
    input = new PassThrough();
    output = new PassThrough();
    const sessionInput = createReadlineSessionInput(input, output);
    const answer = sessionInput.next("cj> ");
    input.end("first line\nsecond line\n\n");

    await expect(answer).resolves.toBe("first line\nsecond line\n");
    sessionInput.close();
  });
});
