import type { Command } from "commander";
import type { AuditStore } from "../../audit/store.js";
import type { AuditRecord, HistorySummary, TaskHistorySummary } from "../../audit/store.js";
import { CjError } from "../../shared/errors.js";
import { confirm } from "@inquirer/prompts";
import path from "node:path";
import { formatUsage } from "../../providers/usage.js";

export function addHistoryCommand(program: Command, audit: AuditStore): void {
  const history = program
    .command("history")
    .description("Show local redacted audit history")
    .option("-n, --limit <number>", "maximum history entries (or events with --events)", "50")
    .option("--events", "show raw event records instead of one summary per task")
    .option("--tasks", "show each task/turn instead of grouping chat sessions")
    .option("--session <session-id>", "show task turns for one chat session by ID or prefix")
    .option("-v, --verbose", "show Token usage statistics in summary output")
    .action(async (options: { limit: string; events?: boolean; tasks?: boolean; session?: string; verbose?: boolean }, command: Command) => {
      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw new CjError("CONFIG_INVALID", "limit must be between 1 and 1000");
      }
      const json = command.optsWithGlobals().json === true;
      if (options.events && (options.tasks || options.session)) {
        throw new CjError("CONFIG_INVALID", "--events cannot be combined with --tasks or --session");
      }
      if (json && (options.tasks || options.session)) {
        throw new CjError("CONFIG_INVALID", "--json emits raw events and cannot be combined with --tasks or --session");
      }
      const records = await audit.list(limit);
      if (json) {
        for (const record of records) process.stdout.write(`${JSON.stringify(record)}\n`);
        return;
      }
      if (options.events) {
        printEvents(records);
        return;
      }
      const summaries = options.session
        ? audit.summarizeRecords((await audit.recordsForSession(options.session)).records, limit)
        : options.tasks
          ? await audit.listTaskSummaries(limit)
          : await audit.listHistorySummaries(limit);
      if (summaries.length === 0) {
        process.stdout.write("No history.\n");
        return;
      }
      if (options.session || options.tasks) printSummaries((summaries as TaskHistorySummary[]).reverse(), options.verbose === true);
      else printHistorySummaries(summaries as HistorySummary[], options.verbose === true);
    });

  history
    .command("export")
    .description("Export already-redacted audit records as owner-only JSONL or standalone HTML")
    .argument("<file>")
    .option("--task <task-id>", "export one task by full ID or an unambiguous prefix")
    .option("--session <session-id>", "export one cj chat session by full ID or an unambiguous prefix")
    .option("--format <format>", "jsonl or html; .html filenames default to html")
    .option("--html", "shortcut for --format html")
    .action(async (file: string, options: { task?: string; session?: string; format?: string; html?: boolean }) => {
      const target = path.resolve(file);
      const inferred = path.extname(target).toLowerCase() === ".html" ? "html" : "jsonl";
      const format = options.html ? "html" : options.format ?? inferred;
      if (format !== "jsonl" && format !== "html") throw new CjError("CONFIG_INVALID", "format must be jsonl or html");
      const result = await audit.exportTo(target, options, format);
      const scope = result.taskId ? ` for task ${result.taskId}` : result.sessionId ? ` for session ${result.sessionId}` : "";
      process.stdout.write(`Exported ${result.count} redacted audit records${scope} as ${format} to ${target}\n`);
    });

  history
    .command("prune")
    .description("Remove audit records older than a number of days after confirmation")
    .requiredOption("--older-than <days>", "records older than this many days")
    .action(async (options: { olderThan: string }) => {
      const days = Number(options.olderThan);
      if (!Number.isInteger(days) || days < 1 || days > 36_500) {
        throw new CjError("CONFIG_INVALID", "older-than must be an integer between 1 and 36500");
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new CjError("CONFIRMATION_REQUIRED", "Pruning audit history requires an interactive confirmation");
      }
      if (!(await confirm({ message: `Remove audit records older than ${days} day(s)?`, default: false }))) {
        throw new CjError("CONFIRMATION_REJECTED", "The user rejected pruning audit history");
      }
      const result = await audit.pruneOlderThan(new Date(Date.now() - days * 86_400_000));
      process.stdout.write(`Removed ${result.removed} record(s); retained ${result.retained}.\n`);
    });
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "-";
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

export function printSummaries(summaries: TaskHistorySummary[], verbose = false): void {
  for (const summary of summaries) {
    const session = summary.sessionId ? `  session:${summary.sessionId.slice(0, 8)}` : "";
    const error = summary.errorCode ? `  ${summary.errorCode}` : "";
    process.stdout.write(
      `${summary.startedAt}  task:${summary.taskId.slice(0, 8)}${session}  ${summary.status}${verbose ? `  ${formatUsage(summary)}` : ""}  tools:${summary.toolCalls}  ${formatDuration(summary.durationMs)}  ${summary.title ?? "Legacy record, no description"}${error}\n`
    );
  }
}

export function printHistorySummaries(summaries: HistorySummary[], verbose = false): void {
  for (const summary of summaries) {
    const title = summary.title ?? "Legacy record, no description";
    if (summary.kind === "task") {
      process.stdout.write(`${summary.lastActiveAt}  task:${summary.taskId.slice(0, 8)}  ${summary.status}${verbose ? `  ${formatUsage(summary)}` : ""}  tools:${summary.toolCalls}  ${title}\n`);
      continue;
    }
    const failures = summary.failedTurns || summary.cancelledTurns
      ? `  failed:${summary.failedTurns} cancelled:${summary.cancelledTurns}`
      : "";
    process.stdout.write(`${summary.lastActiveAt}  chat:${summary.sessionId.slice(0, 8)}  ${summary.status}  turns:${summary.turns}${failures}${verbose ? `  ${formatUsage(summary)}` : ""}  tools:${summary.toolCalls}  ${title}\n`);
  }
}

export function printEvents(records: AuditRecord[]): void {
  if (records.length === 0) {
    process.stdout.write("No history.\n");
    return;
  }
  for (const record of records) {
    const session = record.sessionId ? `  session:${record.sessionId.slice(0, 8)}` : "";
    process.stdout.write(`${record.timestamp}  ${record.taskId.slice(0, 8)}${session}  ${record.event}`);
    const tool = typeof record.data.tool === "string" ? `  ${record.data.tool}` : "";
    const success = typeof record.data.success === "boolean" ? `  ${record.data.success ? "ok" : "failed"}` : "";
    process.stdout.write(`${tool}${success}\n`);
  }
}
