import { describe, expect, it } from "vitest";
import { cleanTaskTitle, createTaskTitle, fallbackTaskTitle } from "../src/agent/title.js";
import type { ModelProvider } from "../src/providers/types.js";

describe("task titles", () => {
  it("normalizes generated titles to one bounded line", async () => {
    const provider: ModelProvider = { id: "fake", async complete() { return { kind: "message", content: `  First\n\u0000 second ${"x".repeat(80)}  ` }; } };
    const result = await createTaskTitle({ provider, model: "fake", prompt: "prompt", language: "en", signal: new AbortController().signal, timeoutMs: 100 });
    expect(result.generated).toBe(true);
    expect(result.title).toBe(cleanTaskTitle(result.title));
    expect(result.title.length).toBe(60);
    expect(result.title).not.toContain("\n");
    expect(cleanTaskTitle(`${"x".repeat(59)}😀extra`)).toBe(`${"x".repeat(59)}😀`);
  });

  it("falls back to a redacted prompt excerpt on failure or empty output", async () => {
    const provider: ModelProvider = { id: "fake", async complete() { throw new Error("offline"); } };
    const prompt = "Use sk-abcdefghijklmnopqrstuvwxyz to inspect the project";
    await expect(createTaskTitle({ provider, model: "fake", prompt, language: "en", signal: new AbortController().signal, timeoutMs: 100 })).resolves.toEqual({
      title: fallbackTaskTitle(prompt, "en"), generated: false
    });
    expect(fallbackTaskTitle(prompt, "en")).toContain("[REDACTED]");
    expect(fallbackTaskTitle("\n", "zh-CN")).toBe("未命名任务");
  });
});
