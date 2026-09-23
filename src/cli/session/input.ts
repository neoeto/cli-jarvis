import { createInterface, type Interface, type Key } from "node:readline";
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
const FULL_REDRAW_CURSOR_HOME = "\x1b[1G";

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
    private readonly takePendingEraseWidth: () => number | undefined,
    private readonly clearPendingEraseWidths: () => void
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
    // Newer Node versions redraw after a delete instead of writing \b \b.
    // Discard widths queued while its writable output was buffering so they
    // cannot affect a later legacy-style erase.
    if (content.startsWith(FULL_REDRAW_CURSOR_HOME)) this.clearPendingEraseWidths();
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
  const pendingEraseWidths: number[] = [];
  const clearPendingEraseWidths = (): void => {
    pendingEraseWidths.length = 0;
  };
  const terminalOutput = terminal
    ? new DisplayWidthOutput(
      output,
      () => pendingEraseWidths.shift(),
      clearPendingEraseWidths
    )
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

  const recordBackspaceWidth = (_value: string, key: Key): void => {
    // Keypress events are emitted one at a time even when the terminal
    // delivers several keystrokes in one data chunk. Record the width before
    // readline mutates its line so every CJK backspace gets its own erase
    // width.
    if (!pending) {
      clearPendingEraseWidths();
      return;
    }
    if (key.name !== "backspace") return;
    const width = previousCharacterWidth(readline.line, readline.cursor);
    if (width !== undefined && width > 1) pendingEraseWidths.push(width);
  };
  // This listener must run before readline's keypress listener, not merely
  // before the raw data decoder, because one input chunk can contain multiple
  // backspaces.
  input.prependListener("keypress", recordBackspaceWidth);

  const settle = (): void => {
    if (!pending) return;
    const answer = lines.join("\n");
    lines = [];
    clearPendingEraseWidths();
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
    input.removeListener("keypress", recordBackspaceWidth);
    clearPendingEraseWidths();
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
