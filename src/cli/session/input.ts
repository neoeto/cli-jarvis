import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

const PASTE_SETTLE_MS = 40;

export interface SessionInput {
  next(prompt: string): Promise<string | undefined>;
  onInterrupt(handler: () => void): () => void;
  close(): void;
}

interface PendingAnswer {
  resolve: (value: string | undefined) => void;
}

/**
 * Read one chat turn at a time while retaining readline's editing and history
 * behavior. A short settle window joins lines arriving in one paste operation
 * into one prompt instead of treating every pasted line as a new turn.
 */
export function createReadlineSessionInput(
  input: Readable & { isTTY?: boolean },
  output: Writable & { isTTY?: boolean }
): SessionInput {
  const terminal = Boolean(input.isTTY && output.isTTY);
  const readline = createInterface({
    input,
    output,
    terminal,
    historySize: 100,
    removeHistoryDuplicates: true,
    crlfDelay: Infinity
  });

  let closed = false;
  let pending: PendingAnswer | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  let lines: string[] = [];
  const interrupts = new Set<() => void>();

  const settle = (): void => {
    if (!pending) return;
    const answer = lines.join("\n");
    lines = [];
    const current = pending;
    pending = undefined;
    current.resolve(answer);
  };

  readline.on("line", (line) => {
    if (!pending) return;
    lines.push(line);
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, PASTE_SETTLE_MS);
  });

  readline.on("close", () => {
    closed = true;
    if (settleTimer) clearTimeout(settleTimer);
    if (pending) {
      const current = pending;
      pending = undefined;
      current.resolve(lines.length ? lines.join("\n") : undefined);
    }
    lines = [];
  });

  readline.on("SIGINT", () => {
    for (const interrupt of interrupts) interrupt();
  });

  return {
    next(prompt): Promise<string | undefined> {
      if (closed) return Promise.resolve(undefined);
      if (pending) throw new Error("A session input request is already pending");
      lines = [];
      return new Promise<string | undefined>((resolve) => {
        pending = { resolve };
        readline.resume();
        readline.setPrompt(prompt);
        readline.prompt();
      });
    },
    onInterrupt(handler): () => void {
      interrupts.add(handler);
      return () => interrupts.delete(handler);
    },
    close(): void {
      if (settleTimer) clearTimeout(settleTimer);
      readline.close();
    }
  };
}

export type ReadlineSessionInput = Interface;
