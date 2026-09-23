import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const { createInterface } = vi.hoisted(() => {
  return {
    createInterface: (options: { input: PassThrough; output: PassThrough }) => {
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {
        line: [],
        close: [],
        SIGINT: []
      };
      const readline = {
        line: "",
        cursor: 0,
        on(event: string, listener: (...args: unknown[]) => void) {
          listeners[event].push(listener);
          return readline;
        },
        resume: () => readline,
        pause: () => readline,
        setPrompt: () => undefined,
        prompt: () => undefined,
        close: () => {
          for (const listener of listeners.close) listener();
        }
      };

      options.input.on("keypress", (value: string, key: { name?: string }) => {
        if (key.name === "backspace" && readline.cursor > 0) {
          readline.line = readline.line.slice(0, readline.cursor - 1) + readline.line.slice(readline.cursor);
          readline.cursor -= 1;
          options.output.write("\b \b");
          return;
        }
        readline.line = readline.line.slice(0, readline.cursor) + value + readline.line.slice(readline.cursor);
        readline.cursor += value.length;
        options.output.write(value);
      });

      return readline;
    }
  };
});

vi.mock("node:readline", () => ({ createInterface }));

import { createReadlineSessionInput } from "../src/cli/session/input.js";

describe("readline session input CJK deletion", () => {
  it("erases each grouped CJK backspace at its full display width", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
    output.isTTY = true;
    output.columns = 80;
    const rendered: string[] = [];
    output.on("data", (chunk: Buffer) => rendered.push(chunk.toString("utf8")));

    const sessionInput = createReadlineSessionInput(input, output);
    const answer = sessionInput.next("cj> ");
    input.emit("keypress", "汉", { sequence: "汉" });
    input.emit("keypress", "字", { sequence: "字" });
    input.emit("keypress", "", { name: "backspace" });
    input.emit("keypress", "", { name: "backspace" });

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(rendered.join("")).toBe("汉字\b\b  \b\b\b\b  \b\b");

    sessionInput.close();
    await expect(answer).resolves.toBeUndefined();
  });
});
