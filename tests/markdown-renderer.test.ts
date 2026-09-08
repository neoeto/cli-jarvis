import displayWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHumanRenderer } from "../src/cli/renderers/human.js";
import { renderMarkdown } from "../src/cli/renderers/markdown.js";

afterEach(() => vi.restoreAllMocks());

describe("terminal Markdown renderer", () => {
  it("separates tool-call text and reasoning from the complete answer", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const renderer = createHumanRenderer({ verbose: false, language: "zh-CN", noColor: true });
    await renderer({ type: "assistant_delta", content: "先检查文件。\n\n" });
    expect(stdout).not.toHaveBeenCalled();
    await renderer({ type: "assistant_progress", content: "先检查文件。" });
    await renderer({ type: "reasoning", content: "内部推理内容" });
    await renderer({ type: "tool_result", name: "list_files", success: true, message: "已检查", durationMs: 1 });
    await renderer({ type: "assistant_delta", content: "最终" });
    await renderer({ type: "assistant", content: "最终回答。", streamed: true });
    const answer = stdout.mock.calls.map(([value]) => String(value)).join("");
    const processLog = stderr.mock.calls.map(([value]) => String(value)).join("");
    expect(answer).toContain("最终回答。");
    expect(answer).not.toContain("先检查");
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(processLog).toContain("  [决策] 先检查文件。");
    expect(processLog).toContain("  [完成] ✓ 已检查");
    expect(processLog).not.toContain("内部推理内容");
  });

  it("labels verbose reasoning separately, including continuation lines", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const renderer = createHumanRenderer({ verbose: true, language: "en", plain: true });
    await renderer({ type: "reasoning", content: "First thought\nsecond thought" });
    expect(stderr).toHaveBeenCalledWith("  [Reasoning] First thought\n    │ second thought\n");
  });

  it("adds an answer heading in a terminal and keeps redirected stdout clean", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    try {
      const renderer = createHumanRenderer({ verbose: false, language: "zh-CN", noColor: true });
      await renderer({ type: "assistant", content: "回答内容" });
      expect(stdout).toHaveBeenLastCalledWith("\n━━ 回答 ━━\n\n回答内容\n\n");
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
      await renderer({ type: "assistant", content: "回答内容" });
      expect(stdout).toHaveBeenLastCalledWith("回答内容\n");
    } finally {
      if (original) Object.defineProperty(process.stdout, "isTTY", original);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });

  it("formats common Markdown blocks for a terminal", () => {
    const rendered = renderMarkdown(`# 状态

当前代码在 **main** 分支，命令是 \`npm test\`。

- 第一项
- 第二项

> 这是引用

\`\`\`ts
const ok = true;
\`\`\`

| 项目 | 状态 |
| --- | --- |
| 测试 | 通过 |`);

    expect(rendered).toContain("状态");
    expect(rendered).toContain("main");
    expect(rendered).toContain("• 第一项");
    expect(rendered).toContain("│ 这是引用");
    expect(rendered).toContain("╭─ ts");
    expect(rendered).toContain("const ok = true;");
    expect(rendered).toContain("┌");
    expect(rendered).not.toContain("**main**");
    expect(rendered).not.toContain("```ts");
  });

  it("removes terminal control sequences from model text", () => {
    const rendered = renderMarkdown("safe \u001b]0;malicious title\u0007 text");
    expect(rendered).toBe("safe  text");
    expect(rendered).not.toContain("\u001b");
  });

  it("renders a streamed assistant response only after it is complete", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const renderer = createHumanRenderer({ verbose: false, language: "zh-CN" });
      await renderer({ type: "assistant_delta", content: "当前代码在 **main**" });
      await renderer({ type: "assistant", content: "当前代码在 **main** 分支。", streamed: true });
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]?.[0])).not.toContain("**main**");
      expect(String(write.mock.calls[0]?.[0])).toContain("main");
    } finally {
      write.mockRestore();
    }
  });

  it("supports explicitly plain human output", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const renderer = createHumanRenderer({ verbose: false, language: "en", plain: true });
      await renderer({ type: "assistant", content: "**plain**" });
      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("plain");
      expect(output).not.toContain("\u001b[");
    } finally {
      write.mockRestore();
    }
  });

  it.each([
    ["zh-CN", 60, 58],
    ["en", 100, 98],
    ["zh-CN", 120, 100]
  ] as const)("aligns every confirmation border in %s at %i columns", async (language, columns, expectedWidth) => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const original = Object.getOwnPropertyDescriptor(process.stderr, "columns");
    Object.defineProperty(process.stderr, "columns", { configurable: true, value: columns });
    try {
      const renderer = createHumanRenderer({ verbose: false, language, noColor: true });
      await renderer({
        type: "confirmation_requested",
        request: {
          actionId: "internal-action-id",
          toolName: "run_command",
          summary: "在工作区运行 npm test，检查 café 和 e\u0301。".repeat(4) + "\n下一行 👩‍💻",
          targets: ["/workspace/项目/café/e\u0301/👩‍💻"],
          effects: ["process", "write"],
          reversible: false
        }
      });
      const serialized = write.mock.calls.map(([value]) => String(value)).join("");
      expect(serialized).toContain("┏");
      expect(serialized).toContain("┃");
      expect(serialized).toContain("┗");
      expect(serialized).toContain(language === "zh-CN" ? "! 需要确认" : "! Confirmation required");
      expect(serialized).not.toContain("⚠");
      expect(serialized).toContain(language === "zh-CN" ? "操作:" : "operation:");
      expect(serialized).toContain(language === "zh-CN" ? "目标:" : "target:");
      for (const line of serialized.trimEnd().split("\n")) {
        expect(displayWidth(line)).toBe(expectedWidth);
      }
      const [top, firstContent, ...rest] = serialized.trimEnd().split("\n");
      const bottom = rest.at(-1);
      expect(displayWidth(top ?? "")).toBe(displayWidth(firstContent ?? ""));
      expect(displayWidth(top ?? "")).toBe(displayWidth(bottom ?? ""));
    } finally {
      if (original) Object.defineProperty(process.stderr, "columns", original);
      else Reflect.deleteProperty(process.stderr, "columns");
      write.mockRestore();
    }
  });
});
