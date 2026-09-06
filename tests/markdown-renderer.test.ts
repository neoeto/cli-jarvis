import { describe, expect, it, vi } from "vitest";
import { createHumanRenderer } from "../src/cli/renderers/human.js";
import { renderMarkdown } from "../src/cli/renderers/markdown.js";

describe("terminal Markdown renderer", () => {
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
});
