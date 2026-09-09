import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, open, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AppConfig } from "../config/schema.js";
import type { ModelProvider } from "../providers/types.js";
import { minimalProcessEnvironment, runProcess } from "../process/run.js";
import { redactSecrets } from "../policy/sensitive-data.js";
import { createExternalTool } from "./external-cli-tool.js";
import { helpChildren, parseReview, reviewHelp, usableHelp, validateReview, type HelpDocument, type Review } from "./external-cli-review.js";
import type { ToolRegistry } from "./registry.js";

// Invalidate both old approvals and old rejections when collection/review changes.
const RULE_VERSION = 3;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const safeMessage = (error: unknown) => redactSecrets(error instanceof Error ? error.message : String(error)).value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2000);

export type ExternalStatus = "pending" | "approved" | "partial" | "rejected" | "error" | "unsupported" | "duplicate" | "missing";
export interface ExternalDiagnostic {
  command: string;
  entry: string;
  status: ExternalStatus;
  message: string;
  tools: string[];
}

interface Snapshot {
  command: string;
  entry: string;
  target: string;
  fingerprint: string;
  sidecar: string;
}
interface CacheEntry { review: Review; documents: HelpDocument[] }
export interface ExternalRefreshOptions {
  registry: ToolRegistry;
  config: AppConfig;
  stateDir: string;
  /** Omitted for read-only inspection: never probe or contact a model. */
  provider?: () => Promise<ModelProvider>;
  signal: AbortSignal;
  force?: boolean;
  /** Restrict a refresh to explicitly registered command names. */
  commands?: readonly string[];
}

class CommandResolutionError extends Error {
  constructor(readonly kind: "missing" | "unsupported", message: string) {
    super(message);
  }
}

export function normalizeExternalCommand(value: string): string {
  const command = value.trim();
  if (!command || /[\s\\/:\0]/.test(command)) {
    throw new Error("CLI command must be one PATH command name without arguments or path separators");
  }
  if (command.length > 255) throw new Error("CLI command name is too long");
  return process.platform === "win32" ? command.toLowerCase() : command;
}

function windowsExtensions(): string[] {
  const configured = (process.env.PATHEXT ?? ".COM;.EXE")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension === ".exe" || extension === ".com");
  return configured.length ? configured : [".com", ".exe"];
}

/** Resolve one executable exactly as the current CJ process resolves its PATH. */
export async function resolveExternalCommand(commandValue: string, cwd = process.cwd()): Promise<string> {
  const command = normalizeExternalCommand(commandValue);
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    throw new CommandResolutionError("unsupported", "Only native .exe/.com executables are supported; shell wrappers are unsupported");
  }
  const pathValue = process.env.PATH ?? "";
  const segments = pathValue.split(path.delimiter);
  const hasAllowedExtension = process.platform === "win32" && /\.(?:exe|com)$/i.test(command);
  const candidates = process.platform === "win32"
    ? hasAllowedExtension ? [command] : windowsExtensions().map((extension) => `${command}${extension}`)
    : [command];

  for (const segment of segments) {
    const directory = path.resolve(cwd, segment || ".");
    for (const candidate of candidates) {
      const entry = path.join(directory, candidate);
      try {
        const target = await realpath(entry);
        const info = await stat(target);
        if (!info.isFile()) continue;
        if (process.platform !== "win32") await access(target, constants.X_OK);
        if (process.platform === "win32" && !/\.(?:exe|com)$/i.test(target)) continue;
        return entry;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") continue;
        throw error;
      }
    }
  }
  throw new CommandResolutionError("missing", `Command is not an executable available on PATH: ${command}`);
}

async function writeState(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(() => undefined); }
}

async function boundedRead(file: string, maximum: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Documentation is not a regular file");
    const buffer = Buffer.alloc(maximum);
    const { bytesRead } = await handle.read(buffer, 0, maximum, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

async function fileDigest(file: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(file, { signal });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function snapshot(command: string, entry: string, signal: AbortSignal): Promise<Snapshot> {
  signal.throwIfAborted();
  const target = await realpath(entry);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("CLI target is not a regular file");
  if (process.platform !== "win32") await access(target, constants.X_OK);
  if (process.platform === "win32" && !/\.(?:exe|com)$/i.test(target)) {
    throw new CommandResolutionError("unsupported", "Only native .exe/.com executables are supported; shell wrappers are unsupported");
  }
  const docs: string[] = [];
  const docStamps: unknown[] = [];
  for (const suffix of [".md", ".help.txt"]) {
    const file = `${entry}${suffix}`;
    try {
      const text = await boundedRead(file, MAX_DOCUMENT_BYTES / 2);
      docs.push(text);
      docStamps.push([suffix, await realpath(file), await fileDigest(file, signal)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const fingerprint = digest(JSON.stringify([command, entry, target, info.mode, info.size, info.mtimeMs, info.ctimeMs, await fileDigest(target, signal), docStamps]));
  return { command, entry, target, fingerprint, sidecar: docs.join("\n") };
}

async function snapshotCommand(command: string, signal: AbortSignal): Promise<Snapshot> {
  const normalized = normalizeExternalCommand(command);
  return snapshot(normalized, await resolveExternalCommand(normalized), signal);
}

export async function collectHelp(command: string, initial: Snapshot, signal: AbortSignal): Promise<HelpDocument[]> {
  let bytesLeft = MAX_DOCUMENT_BYTES;
  let probes = 0;
  const documents: HelpDocument[] = [];
  const queue: string[][] = [[]];
  const take = (text: string): string => {
    const buffer = Buffer.from(redactSecrets(text).value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
    const result = buffer.subarray(0, bytesLeft).toString("utf8");
    bytesLeft = Math.max(0, bytesLeft - Buffer.byteLength(result));
    return result;
  };
  const sidecar = take(Buffer.from(initial.sidecar).subarray(0, MAX_DOCUMENT_BYTES / 2).toString("utf8"));
  while (queue.length && probes < 20 && bytesLeft > 0) {
    signal.throwIfAborted();
    const subcommand = queue.shift()!;
    let text = "";
    let truncated = false;
    const attempts: NonNullable<HelpDocument["attempts"]> = [];
    for (const flag of ["--help", "-h"]) {
      if (probes >= 20 || bytesLeft <= 0) break;
      if ((await snapshotCommand(command, signal)).fingerprint !== initial.fingerprint) throw new Error("CLI, PATH resolution or documentation changed during help collection");
      probes++;
      const args = [...subcommand, flag];
      try {
        const result = await runProcess({ command: initial.target, args, cwd: path.dirname(initial.entry), env: minimalProcessEnvironment({ HOME: os.homedir() }), timeoutMs: 3000, maxOutputBytes: 32 * 1024, signal });
        const output = take(`${result.stdout}\n${result.stderr}`);
        attempts.push({ args, exitCode: result.exitCode, timedOut: result.timedOut, truncated: result.truncated, message: safeMessage(output).slice(0, 400) });
        if (!result.timedOut) {
          truncated ||= result.truncated || bytesLeft === 0;
          text += truncated ? output.slice(0, Math.max(0, output.lastIndexOf("\n"))) : output;
        }
      } catch (error) {
        signal.throwIfAborted();
        attempts.push({ args, exitCode: null, timedOut: false, truncated: false, message: safeMessage(error) });
      }
      if (usableHelp(text)) break;
    }
    const combined = subcommand.length === 0 ? `${text}\n${sidecar}` : text;
    const children = helpChildren(combined);
    documents.push({ command: subcommand, text, children, truncated, attempts, ...(subcommand.length === 0 ? { supplementary: sidecar } : {}) });
    if (subcommand.length < 4) for (const child of children) queue.push([...subcommand, child]);
  }
  return documents;
}

function collectionRejections(documents: HelpDocument[]): Review["rejected"] {
  const supplementary = documents[0]?.supplementary ?? "";
  const rejected: Review["rejected"] = [];
  for (const doc of documents) {
    if (!usableHelp(`${doc.text}\n${supplementary}`)) {
      const attempts = doc.attempts ?? [];
      const failed = attempts.some((item) => item.timedOut || item.exitCode !== 0);
      rejected.push({ command: doc.command, kind: failed ? "collection" : "documentation",
        reason: `${failed ? "Help collection failed" : "Help contains no invocation syntax"}: ${attempts.map((item) => `${item.args.join(" ")} (${item.timedOut ? "timed out after 3000ms" : `exit ${item.exitCode ?? "unknown"}`}): ${item.message || "empty output"}`).join("; ") || "empty output"}` });
    }
    for (const child of doc.children) {
      const command = [...doc.command, child];
      if (!documents.some((item) => JSON.stringify(item.command) === JSON.stringify(command))) rejected.push({ command, kind: "limit", reason: "Help was not probed within the depth, 20-probe or document budget" });
    }
  }
  return rejected;
}

function requestedCommands(config: AppConfig, commands: readonly string[] | undefined): string[] {
  const registered = config.externalCli.commands;
  if (!commands) return registered;
  const selected = new Set(commands.map(normalizeExternalCommand));
  return registered.filter((command) => selected.has(command));
}

export async function refreshExternalTools(options: ExternalRefreshOptions): Promise<ExternalDiagnostic[]> {
  const { registry, config, signal } = options;
  registry.removeExternalTools();
  const diagnostics: ExternalDiagnostic[] = [];
  const targets = new Set<string>();
  const cacheDir = path.join(options.stateDir, "external-cli-cache");
  let provider: ModelProvider | undefined;
  for (const command of requestedCommands(config, options.commands)) {
    signal.throwIfAborted();
    const diagnostic: ExternalDiagnostic = { command, entry: command, status: "pending", message: "Awaiting documentation review", tools: [] };
    let errorFile: string | undefined;
    try {
      const initial = await snapshotCommand(command, signal);
      diagnostic.entry = initial.entry;
      if (targets.has(initial.target)) {
        diagnostics.push({ ...diagnostic, status: "duplicate", message: "Duplicate real executable path" });
        continue;
      }
      targets.add(initial.target);
      const key = digest(JSON.stringify([RULE_VERSION, initial.fingerprint, config.provider]));
      const cacheFile = path.join(cacheDir, `${key}.json`);
      errorFile = path.join(cacheDir, `${key}.error.json`);
      if (options.force && options.provider) await unlink(cacheFile).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      let cached: CacheEntry | undefined;
      if (!options.force) {
        try {
          const raw = JSON.parse(await boundedRead(cacheFile, 2 * 1024 * 1024)) as CacheEntry;
          if (!Array.isArray(raw.documents) || raw.documents.some((doc) => !Array.isArray(doc.command) || typeof doc.text !== "string" || !Array.isArray(doc.children) || (doc.supplementary !== undefined && typeof doc.supplementary !== "string"))) throw new Error("Invalid cached documents");
          cached = { review: validateReview(parseReview(raw.review, command, raw.documents), raw.documents), documents: raw.documents };
        } catch { /* Missing/corrupt cache is pending, never executable. */ }
      }
      if (!cached && options.provider) {
        const documents = await collectHelp(command, initial, signal);
        let review: Review;
        if (!documents.some((doc) => usableHelp(`${doc.text}\n${documents[0]?.supplementary ?? ""}`))) {
          review = { capabilities: [], rejected: [] };
        } else {
          provider ??= await options.provider();
          const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(config.limits.modelTimeoutMs)]);
          review = await reviewHelp(provider, config.provider.model, documents, reviewSignal, command);
        }
        review.rejected.push(...collectionRejections(documents));
        if ((await snapshotCommand(command, signal)).fingerprint !== initial.fingerprint) throw new Error("CLI, PATH resolution or documentation changed during review; retry refresh");
        cached = { review, documents };
        const transient = review.rejected.some((item) => item.kind === "review" || item.kind === "collection");
        if (!transient) {
          await writeState(cacheFile, cached);
          await unlink(errorFile).catch(() => undefined);
        } else {
          await writeState(errorFile, { message: safeMessage(review.rejected.map((item) => item.reason).join("; ")) });
        }
      }
      if (!cached && !options.provider) {
        try {
          const previous = JSON.parse(await boundedRead(errorFile, 16384)) as { message?: unknown };
          if (typeof previous.message === "string") {
            diagnostic.status = "error";
            diagnostic.message = `Last review failed; retry on next refresh: ${safeMessage(previous.message)}`;
          }
        } catch { /* No saved failure; leave pending. */ }
      }
      if (cached) {
        for (const capability of cached.review.capabilities) {
          const tool = createExternalTool(command, initial.target, capability, async () => {
            if ((await snapshotCommand(command, signal)).fingerprint !== initial.fingerprint) {
              throw new Error("CLI, PATH resolution or documentation changed; refresh before executing");
            }
          });
          registry.register(tool, "external-cli");
          diagnostic.tools.push(tool.definition.function.name);
        }
        const reasons = cached.review.rejected.map((item) => `${item.command.join(" ") || "(root)"} [${item.kind ?? "documentation"}]: ${item.reason}`);
        diagnostic.status = diagnostic.tools.length ? (reasons.length ? "partial" : "approved")
          : cached.review.rejected.some((item) => item.kind === "review" || item.kind === "collection") ? "error"
          : cached.review.rejected.some((item) => item.kind === "unsupported") ? "unsupported" : "rejected";
        diagnostic.message = reasons.length ? safeMessage(reasons.join("; ")) : "Documentation approved";
      }
    } catch (error) {
      signal.throwIfAborted();
      diagnostic.status = error instanceof CommandResolutionError ? error.kind : "error";
      diagnostic.message = safeMessage(error);
      if (errorFile && options.provider) await writeState(errorFile, { message: diagnostic.message }).catch(() => undefined);
    }
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}
