import { describe, expect, it, vi } from "vitest";

const { confirmMock } = vi.hoisted(() => ({
  confirmMock: vi.fn()
}));

vi.mock("@inquirer/prompts", () => ({ confirm: confirmMock }));

import { createTerminalConfirmation } from "../src/cli/confirmation.js";

describe("terminal confirmation", () => {
  it("uses a concise y/n prompt without exposing the internal action id", async () => {
    confirmMock.mockResolvedValueOnce(true);
    const signal = new AbortController().signal;
    const request = {
      actionId: "internal-action-id",
      toolName: "run_command",
      summary: "Run a command",
      targets: ["/workspace"],
      effects: ["process"],
      reversible: false
    };

    await expect(createTerminalConfirmation("zh-CN")(request, signal)).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledWith(
      { message: "确认执行“run_command”吗？", default: false },
      { signal }
    );
    expect(JSON.stringify(confirmMock.mock.calls[0])).not.toContain("internal-action-id");
  });

  it("treats the default negative answer as rejection", async () => {
    confirmMock.mockResolvedValueOnce(false);
    await expect(
      createTerminalConfirmation("en")(
        {
          actionId: "internal-action-id",
          toolName: "write_file",
          summary: "Write a file",
          targets: ["/workspace/file.txt"],
          effects: ["write"]
        },
        new AbortController().signal
      )
    ).resolves.toBe(false);
  });
});
