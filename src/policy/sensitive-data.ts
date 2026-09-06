import path from "node:path";

const sensitiveNames = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519"
]);

const sensitiveExtensions = new Set([".pem", ".key", ".p12", ".pfx", ".kdbx"]);

export function sensitivePathReason(file: string): string | undefined {
  const name = path.basename(file).toLowerCase();
  if (sensitiveNames.has(name) || name.startsWith(".env.")) return `sensitive filename ${name}`;
  const extension = path.extname(name);
  if (sensitiveExtensions.has(extension)) return `sensitive extension ${extension}`;
  const parts = file.split(/[\\/]/).map((part) => part.toLowerCase());
  if (parts.includes(".ssh") || parts.includes(".aws") || parts.includes(".gnupg")) {
    return "sensitive credential directory";
  }
  return undefined;
}

const secretPatterns: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
  /\b(AKIA[A-Z0-9]{16})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /((?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?)[^\s"']{6,}/gi
];

export function redactSecrets(value: string): { value: string; redactions: number } {
  let redactions = 0;
  let output = value;
  for (const pattern of secretPatterns) {
    output = output.replace(pattern, (...args: unknown[]) => {
      redactions += 1;
      const prefix = typeof args[1] === "string" && /[:=]|Bearer/i.test(args[1]) ? args[1] : "";
      return `${prefix}[REDACTED]`;
    });
  }
  return { value: output, redactions };
}
