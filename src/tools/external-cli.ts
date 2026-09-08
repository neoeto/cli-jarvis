import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, open, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
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
const RULE_VERSION = 2;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const safeMessage = (error: unknown) => redactSecrets(error instanceof Error ? error.message : String(error)).value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2000);
export interface ExternalDiagnostic {
  entry: string;
  status: "pending" | "approved" | "partial" | "rejected" | "error" | "unsupported" | "duplicate";
  message: string;
  tools: string[];
}
interface Snapshot { target: string; fingerprint: string; sidecar: string }
interface CacheEntry { review: Review; documents: HelpDocument[] }
export interface ExternalRefreshOptions {
  registry: ToolRegistry;
  config: AppConfig;
  stateDir: string;
  /** Omitted for read-only inspection: never probe or contact a model. */
  provider?: () => Promise<ModelProvider>;
  signal: AbortSignal;
  force?: boolean;
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
async function snapshot(entry: string, signal: AbortSignal): Promise<Snapshot> {
  signal.throwIfAborted();
  const target = await realpath(entry);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("CLI target is not a regular file");
  if (process.platform !== "win32") await access(target, constants.X_OK);
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
  const fingerprint = digest(JSON.stringify([entry, target, info.mode, info.size, info.mtimeMs, info.ctimeMs, await fileDigest(target, signal), docStamps]));
  return { target, fingerprint, sidecar: docs.join("\n") };
}

export async function collectHelp(entry: string, initial: Snapshot, signal: AbortSignal): Promise<HelpDocument[]> {
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
  // Reserve part of the total budget for help probes even with large sidecars.
  const sidecar = take(Buffer.from(initial.sidecar).subarray(0, MAX_DOCUMENT_BYTES / 2).toString("utf8"));
  while (queue.length && probes < 20 && bytesLeft > 0) {
    signal.throwIfAborted();
    const command = queue.shift()!;
    let text = "";
    let truncated = false;
    const attempts: NonNullable<HelpDocument["attempts"]> = [];
    for (const flag of ["--help", "-h"]) {
      if (probes >= 20 || bytesLeft <= 0) break;
      if (await realpath(entry) !== initial.target) throw new Error("CLI target changed during help collection");
      probes++;
      const args = [...command, flag];
      try {
        // HOME is a location, not an inherited credential. Many CLIs resolve it
        // before parsing --help. Keep the rest of the minimal environment.
        const result = await runProcess({ command: initial.target, args, cwd: path.dirname(entry), env: minimalProcessEnvironment({ HOME: os.homedir() }), timeoutMs: 3000, maxOutputBytes: 32 * 1024, signal });
        const output = take(`${result.stdout}\n${result.stderr}`);
        attempts.push({ args, exitCode: result.exitCode, timedOut: result.timedOut, truncated: result.truncated, message: safeMessage(output).slice(0, 400) });
        if (!result.timedOut) {
          // Keep complete lines within the budget instead of discarding all help
          // just because later output exceeds it. Tell the reviewer it is partial.
          truncated ||= result.truncated || bytesLeft === 0;
          text += truncated ? output.slice(0, Math.max(0, output.lastIndexOf("\n"))) : output;
        }
      } catch (error) {
        signal.throwIfAborted();
        attempts.push({ args, exitCode: null, timedOut: false, truncated: false, message: safeMessage(error) });
      }
      if (usableHelp(text)) break;
    }
    const combined = command.length === 0 ? `${text}\n${sidecar}` : text;
    const children = helpChildren(combined);
    documents.push({ command, text, children, truncated, attempts, ...(command.length === 0 ? { supplementary: sidecar } : {}) });
    if (command.length < 4) for (const child of children) queue.push([...command, child]);
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

export async function refreshExternalTools(options: ExternalRefreshOptions): Promise<ExternalDiagnostic[]> {
  const { registry, config, signal } = options;
  registry.removeExternalTools();
  const diagnostics: ExternalDiagnostic[] = [];
  const targets = new Set<string>();
  const cacheDir = path.join(options.stateDir, "external-cli-cache");
  let provider: ModelProvider | undefined;
  for (const directory of config.externalCli.directories) {
    signal.throwIfAborted();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { diagnostics.push({ entry: directory, status: "error", message: safeMessage(error), tools: [] }); continue; }
    for (const candidate of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal.throwIfAborted();
      if (!candidate.isFile() && !candidate.isSymbolicLink()) continue;
      // Shared tool folders often contain Finder metadata and documentation
      // files. Only executable files and executable symlinks are candidates.
      if (candidate.name.startsWith(".")) continue;
      if (/\.(md|txt)$/i.test(candidate.name)) continue;
      const entry = path.resolve(directory, candidate.name);
      const diagnostic: ExternalDiagnostic = { entry, status: "pending", message: "Awaiting documentation review", tools: [] };
      let errorFile: string | undefined;
      try {
        if (process.platform === "win32" && !/\.(exe|com)$/i.test(entry)) {
          diagnostic.status = "unsupported"; diagnostic.message = "Only native .exe/.com executables are supported; shell wrappers are unsupported";
          diagnostics.push(diagnostic); continue;
        }
        if (process.platform !== "win32") {
          try {
            await access(entry, constants.X_OK);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM") continue;
            throw error;
          }
        }
        const initial = await snapshot(entry, signal);
        if (process.platform === "win32" && !/\.(exe|com)$/i.test(initial.target)) throw new Error("Unsupported executable target");
        if (targets.has(initial.target)) { diagnostics.push({ ...diagnostic, status: "duplicate", message: "Duplicate real executable path" }); continue; }
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
            cached = { review: validateReview(parseReview(raw.review, path.basename(entry), raw.documents), raw.documents), documents: raw.documents };
          } catch { /* Missing/corrupt cache is pending, never executable. */ }
        }
        if (!cached && options.provider) {
          const documents = await collectHelp(entry, initial, signal);
          let review: Review;
          if (!documents.some((doc) => usableHelp(`${doc.text}\n${documents[0]?.supplementary ?? ""}`))) {
            review = { capabilities: [], rejected: [] };
          } else {
            provider ??= await options.provider();
            const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(config.limits.modelTimeoutMs)]);
            review = await reviewHelp(provider, config.provider.model, documents, reviewSignal, path.basename(entry));
          }
          review.rejected.push(...collectionRejections(documents));
          if ((await snapshot(entry, signal)).fingerprint !== initial.fingerprint) throw new Error("CLI or documentation changed during review; retry refresh");
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
            const tool = createExternalTool(entry, initial.target, capability, async () => {
              if ((await snapshot(entry, signal)).fingerprint !== initial.fingerprint) throw new Error("CLI or documentation changed; refresh before executing");
            });
            registry.register(tool, "external-cli"); diagnostic.tools.push(tool.definition.function.name);
          }
          const reasons = cached.review.rejected.map((item) => `${item.command.join(" ") || "(root)"} [${item.kind ?? "documentation"}]: ${item.reason}`);
          diagnostic.status = diagnostic.tools.length ? (reasons.length ? "partial" : "approved")
            : cached.review.rejected.some((item) => item.kind === "review" || item.kind === "collection") ? "error"
            : cached.review.rejected.some((item) => item.kind === "unsupported") ? "unsupported" : "rejected";
          diagnostic.message = reasons.length ? safeMessage(reasons.join("; ")) : "Documentation approved";
        }
      } catch (error) {
        signal.throwIfAborted();
        diagnostic.status = "error"; diagnostic.message = safeMessage(error);
        if (errorFile && options.provider) await writeState(errorFile, { message: diagnostic.message }).catch(() => undefined);
      }
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}
