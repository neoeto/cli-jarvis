import { createInterface, type Interface } from "node:readline";
import { Writable, type Readable } from "node:stream";
import displayWidth from "string-width";

const PASTE_SETTLE_MS = 40;

export interface SessionInput {
  next(prompt: string): Promise<string | undefined>;
  onInterrupt(handler: () => void): () => void;
  close(): void;
}

interface PendingAnswer {
  resolve: (value: string | undefined) => void;
}

const SINGLE_CELL_BACKSPACE_ERASE = "\b \b";

/**
 * Node's readline occasionally erases a CJK double-width character with a
 * single-cell sequence (\b \b), which leaves one display cell behind in some
 * terminals. Expand just that sequence while leaving all other readline
 * output untouched.
 */
export function renderBackspaceErase(width: number): string {
  if (width <= 1) return SINGLE_CELL_BACKSPACE_ERASE;
  return "\b".repeat(width) + " ".repeat(width) + "\b".repeat(width);
}

class DisplayWidthOutput extends Writable {
  readonly isTTY: boolean | undefined;

  constructor(
    private readonly target: Writable,
    private readonly takePendingEraseWidth: () => number | undefined
  ) {
    super();
    this.isTTY = (target as Writable & { isTTY?: boolean }).isTTY;
  }

  get columns(): number | undefined {
    return (this.target as Writable & { columns?: number }).columns;
  }

  get rows(): number | undefined {
    return (this.target as Writable & { rows?: number }).rows;
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    // Writable supplies the sentinel encoding "buffer" for Buffer chunks;
    // that is not accepted by Buffer.toString(). Terminal control sequences
    // are UTF-8, so decode those explicitly and otherwise forward untouched.
    const content = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (content === SINGLE_CELL_BACKSPACE_ERASE) {
      this.target.write(renderBackspaceErase(this.takePendingEraseWidth() ?? 1), callback);
      return;
    }
    this.target.write(chunk, encoding, callback);
  }
}

function previousCharacterWidth(line: string, cursor: number): number | undefined {
  const prefix = line.slice(0, cursor);
  const character = Array.from(prefix).at(-1);
  return character ? displayWidth(character) : undefined;
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
  let pendingEraseWidth: number | undefined;
  const terminalOutput = terminal
    ? new DisplayWidthOutput(output, () => {
      const width = pendingEraseWidth;
      pendingEraseWidth = undefined;
      return width;
    })
    : output;
  const readline = createInterface({
    input,
    output: terminalOutput,
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

  const recordBackspaceWidth = (chunk: unknown): void => {
    // While a task is running, another UI (for example ask_question) may own
    // stdin. Its keypresses must not affect this idle chat editor.
    if (!pending) {
      pendingEraseWidth = undefined;
      return;
    }
    const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : typeof chunk === "string" ? chunk : "";
    pendingEraseWidth = value === "\x7f" || value === "\b"
      ? previousCharacterWidth(readline.line, readline.cursor)
      : undefined;
  };
  // The listener must run before readline mutates line/cursor in response to
  // the backspace byte.
  input.prependListener("data", recordBackspaceWidth);

  const settle = (): void => {
    if (!pending) return;
    const answer = lines.join("\n");
    lines = [];
    settleTimer = undefined;
    pendingEraseWidth = undefined;
    const current = pending;
    pending = undefined;
    // Do not leave the chat readline consuming stdin while a running task may
    // show an Inquirer confirmation or clarification. The next chat turn
    // resumes it explicitly in next().
    readline.pause();
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
    input.removeListener("data", recordBackspaceWidth);
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
