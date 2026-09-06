import { randomUUID } from "node:crypto";
import { lstat, open, opendir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveExistingPath } from "../../policy/paths.js";
import type { PreparedAction, Tool, ToolContext, ToolResult } from "../types.js";

const fileTypeSchema = z.enum(["file", "directory", "symlink", "other"]);

const inputSchema = z
  .object({
    path: z.string().default("."),
    recursive: z.boolean().default(true),
    maxDepth: z.number().int().min(0).max(20).default(10),
    nameContains: z.string().min(1).optional(),
    extensions: z.array(z.string().min(1)).max(20).optional(),
    types: z.array(fileTypeSchema).min(1).max(4).optional(),
    minSizeBytes: z.number().int().min(0).optional(),
    maxSizeBytes: z.number().int().min(0).optional(),
    contentContains: z.string().min(1).optional(),
    caseSensitive: z.boolean().default(false),
    includeHidden: z.boolean().default(false),
    sortBy: z.enum(["path", "size", "modifiedAt"]).default("path"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
    limit: z.number().int().min(1).max(500).default(100)
  })
  .strict()
  .refine(
    (value) =>
      value.minSizeBytes === undefined ||
      value.maxSizeBytes === undefined ||
      value.minSizeBytes <= value.maxSizeBytes,
    { message: "minSizeBytes must not exceed maxSizeBytes" }
  );

type SearchFilesInput = z.infer<typeof inputSchema>;

interface SearchFilesPayload extends SearchFilesInput {
  target: string;
  workspaceRoot: string;
}

export interface SearchFileEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: string;
  contentMatched?: boolean;
}

export interface SearchFilesData {
  entries: SearchFileEntry[];
  scanned: number;
  matched: number;
  scanTruncated: boolean;
  contentFilesSkipped: number;
}

const MAX_SCANNED_ENTRIES = 50_000;
const MAX_CONTENT_FILE_BYTES = 2 * 1024 * 1024;

async function readContentBounded(file: string): Promise<Buffer | undefined> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(MAX_CONTENT_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONTENT_FILE_BYTES) return undefined;
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function normalizeExtension(extension: string): string {
  return extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
}

function classifyEntry(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): SearchFileEntry["type"] {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function compareEntries(
  left: SearchFileEntry,
  right: SearchFileEntry,
  sortBy: SearchFilesInput["sortBy"],
  sortOrder: SearchFilesInput["sortOrder"]
): number {
  const direction = sortOrder === "asc" ? 1 : -1;
  if (sortBy === "size") return direction * (left.size - right.size || left.path.localeCompare(right.path));
  if (sortBy === "modifiedAt") {
    return direction * (left.modifiedAt.localeCompare(right.modifiedAt) || left.path.localeCompare(right.path));
  }
  return direction * left.path.localeCompare(right.path);
}

export class SearchFilesTool implements Tool<SearchFilesInput, SearchFilesPayload, SearchFilesData> {
  readonly defaultRisk = "low" as const;
  readonly possibleEffects = ["read"] as const;
  readonly definition = {
    type: "function" as const,
    function: {
      name: "search_files",
      description:
        "Search workspace files by name substring, extension, type, byte size, or literal text content. Can sort matches by path, size, or modification time. Size filters apply only to files. Content matches return metadata, not file contents.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Workspace-relative directory path", default: "." },
          recursive: { type: "boolean", default: true },
          maxDepth: { type: "integer", minimum: 0, maximum: 20, default: 10 },
          nameContains: { type: "string", minLength: 1, description: "Literal substring of the base filename" },
          extensions: {
            type: "array",
            maxItems: 20,
            items: { type: "string", minLength: 1 },
            description: "Extensions with or without a leading dot, for example [\".ts\", \"md\"]"
          },
          types: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", enum: ["file", "directory", "symlink", "other"] }
          },
          minSizeBytes: {
            type: "integer",
            minimum: 0,
            description: "Minimum file size in bytes; use 10485760 for 10 MiB"
          },
          maxSizeBytes: { type: "integer", minimum: 0, description: "Maximum file size in bytes" },
          contentContains: {
            type: "string",
            minLength: 1,
            description: "Literal text to find; files larger than 2 MiB are skipped"
          },
          caseSensitive: { type: "boolean", default: false },
          includeHidden: { type: "boolean", default: false },
          sortBy: { type: "string", enum: ["path", "size", "modifiedAt"], default: "path" },
          sortOrder: { type: "string", enum: ["asc", "desc"], default: "asc" },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 100 }
        }
      }
    }
  };

  parse(input: unknown): SearchFilesInput {
    return inputSchema.parse(input);
  }

  async prepare(input: SearchFilesInput, context: ToolContext): Promise<PreparedAction<SearchFilesPayload>> {
    const resolved = await resolveExistingPath(context.workspaceRoot, input.path);
    const { workspaceRoot, path: target } = resolved;
    const targetStat = await stat(target);
    if (!targetStat.isDirectory()) throw new Error(`Not a directory: ${input.path}`);
    return {
      id: randomUUID(),
      toolName: "search_files",
      riskLevel: resolved.external ? "high" : "low",
      summary: context.language === "zh-CN" ? `在 ${input.path} 下搜索文件` : `Search files under ${input.path}`,
      targets: [target],
      effects: ["read"],
      reversible: true,
      payload: { ...input, target, workspaceRoot },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }

  async execute(
    action: PreparedAction<SearchFilesPayload>,
    context: ToolContext
  ): Promise<ToolResult<SearchFilesData>> {
    const input = action.payload;
    const matches: SearchFileEntry[] = [];
    const normalizedName = input.caseSensitive ? input.nameContains : input.nameContains?.toLowerCase();
    const normalizedContent = input.caseSensitive ? input.contentContains : input.contentContains?.toLowerCase();
    const extensions = input.extensions?.map(normalizeExtension);
    let scanned = 0;
    let scanTruncated = false;
    let contentFilesSkipped = 0;

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (context.signal.aborted) throw context.signal.reason;
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (context.signal.aborted) throw context.signal.reason;
        if (!input.includeHidden && entry.name.startsWith(".")) continue;
        if (scanned >= MAX_SCANNED_ENTRIES) {
          scanTruncated = true;
          break;
        }
        scanned += 1;

        const absolute = path.join(directory, entry.name);
        const metadata = await lstat(absolute).catch(() => undefined);
        const type = classifyEntry(entry);
        if (!metadata) continue;

        let accepted = true;
        const comparableName = input.caseSensitive ? entry.name : entry.name.toLowerCase();
        if (normalizedName !== undefined && !comparableName.includes(normalizedName)) accepted = false;
        if (input.types && !input.types.includes(type)) accepted = false;
        if (extensions && (type !== "file" || !extensions.includes(path.extname(entry.name).toLowerCase()))) {
          accepted = false;
        }
        if (input.minSizeBytes !== undefined && (type !== "file" || metadata.size < input.minSizeBytes)) {
          accepted = false;
        }
        if (input.maxSizeBytes !== undefined && (type !== "file" || metadata.size > input.maxSizeBytes)) {
          accepted = false;
        }

        let contentMatched: boolean | undefined;
        if (accepted && normalizedContent !== undefined) {
          if (type !== "file" || metadata.size > MAX_CONTENT_FILE_BYTES) {
            accepted = false;
            if (type === "file") contentFilesSkipped += 1;
          } else {
            const data = await readContentBounded(absolute);
            if (!data) {
              accepted = false;
              contentFilesSkipped += 1;
            } else if (data.includes(0)) {
              accepted = false;
            } else {
              const text = data.toString("utf8");
              const comparableText = input.caseSensitive ? text : text.toLowerCase();
              contentMatched = comparableText.includes(normalizedContent);
              accepted = contentMatched;
            }
          }
        }

        if (accepted) {
          matches.push({
            path: path.relative(input.workspaceRoot, absolute) || ".",
            type,
            size: metadata.size,
            modifiedAt: metadata.mtime.toISOString(),
            ...(contentMatched === undefined ? {} : { contentMatched })
          });
        }

        if (input.recursive && entry.isDirectory() && depth < input.maxDepth && !scanTruncated) {
          await visit(absolute, depth + 1);
        }
      }
    };

    await visit(input.target, 0);
    matches.sort((left, right) => compareEntries(left, right, input.sortBy, input.sortOrder));
    const entries = matches.slice(0, input.limit);
    const data: SearchFilesData = {
      entries,
      scanned,
      matched: matches.length,
      scanTruncated,
      contentFilesSkipped
    };
    return {
      success: true,
      message: context.language === "zh-CN"
        ? `找到 ${matches.length} 个匹配条目，返回 ${entries.length} 个${scanTruncated ? "（扫描已截断）" : ""}`
        : `Found ${matches.length} matching entries; returning ${entries.length}${scanTruncated ? " (scan truncated)" : ""}`,
      effects: [`Read directory tree ${input.target}`],
      data
    };
  }
}
