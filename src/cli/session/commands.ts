export type SessionCommand =
  | { kind: "empty" }
  | { kind: "prompt"; prompt: string }
  | { kind: "clear" }
  | { kind: "status" }
  | { kind: "tools" }
  | { kind: "history" }
  | { kind: "exit" }
  | { kind: "unknown"; name: string };

/** Parse a local chat command without sending it to the model. */
export function parseSessionInput(input: string): SessionCommand {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "empty" };

  // A slash at the beginning of a multi-line prompt is ordinary user content
  // once more than one line is present (for example a pasted shell script).
  if (trimmed.includes("\n") || !trimmed.startsWith("/")) {
    return { kind: "prompt", prompt: input.trim() };
  }

  const [name] = trimmed.slice(1).split(/\s+/, 1);
  switch (name?.toLowerCase()) {
    case "clear":
      return { kind: "clear" };
    case "status":
      return { kind: "status" };
    case "tools":
      return { kind: "tools" };
    case "history":
      return { kind: "history" };
    case "exit":
    case "quit":
      return { kind: "exit" };
    default:
      return { kind: "unknown", name: trimmed.split(/\s+/, 1)[0] ?? trimmed };
  }
}
