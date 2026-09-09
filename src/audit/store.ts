import { appendFile, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentEvent } from "../agent/events.js";
import { redactSecrets } from "../policy/sensitive-data.js";
import { CjError } from "../shared/errors.js";
import { renderAuditHtml } from "./html.js";
import type { ModelUsage } from "../providers/types.js";
import { addModelUsage, hasCacheBreakdown } from "../providers/usage.js";

export interface AuditRecord {
  version: 1;
  timestamp: string;
  taskId: string;
  sessionId?: string;
  event: string;
  data: Record<string, unknown>;
}

export interface TaskAuditContext {
  taskId: string;
  sessionId?: string;
  cliVersion: string;
  cwd: string;
  provider: string;
  model: string;
  promptHash: string;
}

export interface TaskHistorySummary {
  taskId: string;
  sessionId?: string;
  startedAt: string;
  finishedAt?: string;
  status: "completed" | "failed" | "cancelled" | "incomplete";
  toolCalls: number;
  eventCount: number;
  durationMs?: number;
  errorCode?: string;
  title?: string;
  usage?: ModelUsage;
  usageRequests: number;
  unknownUsageRequests: number;
  cacheReportedRequests: number;
  reasoningReportedRequests: number;
}

export interface SessionHistorySummary {
  kind: "chat";
  sessionId: string;
  title?: string;
  startedAt: string;
  lastActiveAt: string;
  status: TaskHistorySummary["status"];
  turns: number;
  failedTurns: number;
  cancelledTurns: number;
  toolCalls: number;
  usage?: ModelUsage;
  usageRequests: number;
  unknownUsageRequests: number;
  cacheReportedRequests: number;
  reasoningReportedRequests: number;
}

export type HistorySummary = ({ kind: "task"; lastActiveAt: string } & TaskHistorySummary) | SessionHistorySummary;

export type AuditExportFormat = "jsonl" | "html";

function safeText(value: string): string {
  return redactSecrets(value).value.slice(0, 2_000);
}

function auditDataForAgentEvent(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case "status":
      return { message: safeText(event.message) };
    case "task_status":
      return { status: event.status, ...(event.detail ? { detail: safeText(event.detail) } : {}) };
    case "task_step":
      return {
        stepId: event.stepId,
        tool: event.tool,
        status: event.status,
        dependsOn: event.dependsOn,
        ...(event.detail ? { detail: safeText(event.detail) } : {})
      };
    case "tool_start":
      return {
        tool: event.name,
        riskLevel: event.riskLevel,
        summary: safeText(event.summary)
      };
    case "tool_preview":
      return { tool: event.name, riskLevel: event.riskLevel, summary: safeText(event.summary), preview: true };
    case "tool_result":
      return {
        tool: event.name,
        success: event.success,
        message: safeText(event.message),
        durationMs: event.durationMs,
        ...(event.recovery === undefined
          ? {}
          : { recovery: { instruction: safeText(event.recovery.instruction), ...(event.recovery.snapshotId ? { snapshotId: event.recovery.snapshotId } : {}) } })
      };
    case "confirmation_requested":
      return {
        tool: event.request.toolName,
        actionId: event.request.actionId,
        effects: event.request.effects,
        reversible: event.request.reversible ?? null,
        targetCount: event.request.targets.length,
        summary: safeText(event.request.summary)
      };
    case "confirmation_resolved":
      return { actionId: event.actionId, approved: event.approved };
    case "confirmation_batch_requested":
      return {
        actionCount: event.requests.length,
        tools: event.requests.map((request) => request.toolName),
        targetCount: event.requests.reduce((count, request) => count + request.targets.length, 0)
      };
    case "confirmation_batch_resolved":
      return { actionCount: event.actionIds.length, approved: event.approved };
    case "question_requested":
      return {
        questionLength: event.request.question.length,
        optionCount: event.request.options.length,
        multiple: event.request.multiple
      };
    case "question_resolved":
      return { selectedCount: event.selectedCount, hasCustomInput: event.hasCustomInput };
    case "assistant_delta":
      return { deltaLength: event.content.length };
    case "assistant_progress":
    case "reasoning":
    case "assistant":
      return { responseLength: event.content.length };
    case "memory_used":
      return { memoryIds: event.ids, purpose: safeText(event.purpose) };
    case "task_title":
      return { title: safeText(event.title), generated: event.generated };
    case "model_usage":
      return {
        requestId: event.requestId,
        model: safeText(event.model),
        purpose: safeText(event.purpose),
        success: event.success,
        ...(event.usage ? { usage: event.usage } : {})
      };
    case "usage_summary":
      return {
        scope: event.scope,
        requests: event.requests,
        unknownRequests: event.unknownRequests,
        cacheReportedRequests: event.cacheReportedRequests,
        reasoningReportedRequests: event.reasoningReportedRequests,
        ...(event.usage ? { usage: event.usage } : {})
      };
  }
}

export class AuditStore {
  private readonly taskSessions = new Map<string, string>();

  constructor(readonly file: string) {}

  createTaskContext(input: Omit<TaskAuditContext, "taskId">): TaskAuditContext {
    return { taskId: randomUUID(), ...input };
  }

  private async append(record: AuditRecord): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await appendFile(this.file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") await chmod(this.file, 0o600);
  }

  async taskStarted(context: TaskAuditContext): Promise<void> {
    if (context.sessionId) this.taskSessions.set(context.taskId, context.sessionId);
    await this.append({
      version: 1,
      timestamp: new Date().toISOString(),
      taskId: context.taskId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      event: "task_started",
      data: {
        cliVersion: context.cliVersion,
        cwd: context.cwd,
        provider: context.provider,
        model: context.model,
        promptHash: context.promptHash,
        platform: process.platform
      }
    });
  }

  async agentEvent(taskId: string, event: AgentEvent): Promise<void> {
    await this.append({
      version: 1,
      timestamp: new Date().toISOString(),
      taskId,
      ...(this.taskSessions.has(taskId) ? { sessionId: this.taskSessions.get(taskId)! } : {}),
      event: event.type,
      data: auditDataForAgentEvent(event)
    });
  }

  async taskFinished(taskId: string, success: boolean, code?: string): Promise<void> {
    await this.append({
      version: 1,
      timestamp: new Date().toISOString(),
      taskId,
      ...(this.taskSessions.has(taskId) ? { sessionId: this.taskSessions.get(taskId)! } : {}),
      event: "task_finished",
      data: { success, ...(code ? { code } : {}) }
    });
  }

  async list(limit = 50): Promise<AuditRecord[]> {
    try {
      const text = await readFile(this.file, "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as AuditRecord];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** Group the append-only event log into the task-oriented view used by the human CLI. */
  summarizeRecords(records: AuditRecord[], limit = 50): TaskHistorySummary[] {
    const summaries = new Map<string, TaskHistorySummary>();
    for (const record of records) {
      const current = summaries.get(record.taskId) ?? {
        taskId: record.taskId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        startedAt: record.timestamp,
        status: "incomplete" as const,
        toolCalls: 0,
        eventCount: 0,
        usageRequests: 0,
        unknownUsageRequests: 0,
        cacheReportedRequests: 0,
        reasoningReportedRequests: 0
      };
      current.eventCount += 1;
      if (record.sessionId && !current.sessionId) current.sessionId = record.sessionId;
      if (record.timestamp < current.startedAt) current.startedAt = record.timestamp;
      if (record.event === "tool_start" || record.event === "tool_preview") current.toolCalls += 1;
      if (record.event === "task_title" && typeof record.data.title === "string") current.title = record.data.title;
      if (record.event === "model_usage") {
        current.usageRequests += 1;
        const usage = record.data.usage;
        if (usage && typeof usage === "object" &&
          typeof (usage as ModelUsage).inputTokens === "number" &&
          typeof (usage as ModelUsage).outputTokens === "number" &&
          typeof (usage as ModelUsage).totalTokens === "number") {
          current.usage = addModelUsage(current.usage, usage as ModelUsage);
          if (hasCacheBreakdown(usage as ModelUsage)) current.cacheReportedRequests += 1;
          if ((usage as ModelUsage).reasoningTokens !== undefined) current.reasoningReportedRequests += 1;
        } else {
          current.unknownUsageRequests += 1;
        }
      }
      if (record.event === "task_status" && typeof record.data.status === "string") {
        if (record.data.status === "cancelled") current.status = "cancelled";
        if (record.data.status === "failed") current.status = "failed";
      }
      if (record.event === "task_finished") {
        current.finishedAt = record.timestamp;
        const success = record.data.success === true;
        const code = typeof record.data.code === "string" ? record.data.code : undefined;
        current.status = success ? "completed" : code === "ABORTED" ? "cancelled" : "failed";
        if (code) current.errorCode = code;
        const started = new Date(current.startedAt).getTime();
        const finished = new Date(record.timestamp).getTime();
        if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
          current.durationMs = finished - started;
        }
      }
      summaries.set(record.taskId, current);
    }
    return [...summaries.values()].slice(-limit);
  }

  async listTaskSummaries(limit = 50): Promise<TaskHistorySummary[]> {
    return this.summarizeRecords(await this.list(Number.MAX_SAFE_INTEGER), limit);
  }

  summarizeHistory(records: AuditRecord[], limit = 50): HistorySummary[] {
    const tasks = this.summarizeRecords(records, Number.MAX_SAFE_INTEGER);
    const grouped = new Map<string, SessionHistorySummary>();
    const output: HistorySummary[] = [];
    for (const task of tasks) {
      const lastActiveAt = task.finishedAt ?? task.startedAt;
      if (!task.sessionId) {
        output.push({ kind: "task", lastActiveAt, ...task });
        continue;
      }
      const current = grouped.get(task.sessionId);
      if (!current) {
        grouped.set(task.sessionId, {
          kind: "chat",
          sessionId: task.sessionId,
          ...(task.title ? { title: task.title } : {}),
          startedAt: task.startedAt,
          lastActiveAt,
          status: task.status,
          turns: 1,
          failedTurns: task.status === "failed" ? 1 : 0,
          cancelledTurns: task.status === "cancelled" ? 1 : 0,
          toolCalls: task.toolCalls,
          ...(task.usage ? { usage: task.usage } : {}),
          usageRequests: task.usageRequests,
          unknownUsageRequests: task.unknownUsageRequests,
          cacheReportedRequests: task.cacheReportedRequests,
          reasoningReportedRequests: task.reasoningReportedRequests
        });
        continue;
      }
      current.turns += 1;
      current.failedTurns += task.status === "failed" ? 1 : 0;
      current.cancelledTurns += task.status === "cancelled" ? 1 : 0;
      current.toolCalls += task.toolCalls;
      current.usageRequests += task.usageRequests;
      current.unknownUsageRequests += task.unknownUsageRequests;
      current.cacheReportedRequests += task.cacheReportedRequests;
      current.reasoningReportedRequests += task.reasoningReportedRequests;
      if (task.usage) current.usage = addModelUsage(current.usage, task.usage);
      if (lastActiveAt >= current.lastActiveAt) {
        current.lastActiveAt = lastActiveAt;
        current.status = task.status;
      }
      if (task.startedAt < current.startedAt) {
        current.startedAt = task.startedAt;
        if (task.title) current.title = task.title;
      }
    }
    output.push(...grouped.values());
    return output.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)).slice(0, limit);
  }

  async listHistorySummaries(limit = 50): Promise<HistorySummary[]> {
    return this.summarizeHistory(await this.list(Number.MAX_SAFE_INTEGER), limit);
  }

  async recordsForTask(taskIdOrPrefix: string): Promise<{ taskId: string; records: AuditRecord[] }> {
    const records = await this.list(Number.MAX_SAFE_INTEGER);
    const taskIds = [...new Set(records.map((record) => record.taskId))].filter((taskId) => taskId.startsWith(taskIdOrPrefix));
    if (taskIds.length === 0) throw new CjError("CONFIG_INVALID", `No audit task matches: ${taskIdOrPrefix}`);
    if (taskIds.length > 1) throw new CjError("CONFIG_INVALID", `Ambiguous task ID prefix: ${taskIdOrPrefix}`);
    const taskId = taskIds[0]!;
    return { taskId, records: records.filter((record) => record.taskId === taskId) };
  }

  async recordsForSession(sessionIdOrPrefix: string): Promise<{ sessionId: string; records: AuditRecord[] }> {
    const records = await this.list(Number.MAX_SAFE_INTEGER);
    const sessionIds = [...new Set(records.flatMap((record) => record.sessionId ? [record.sessionId] : []))]
      .filter((sessionId) => sessionId.startsWith(sessionIdOrPrefix));
    if (sessionIds.length === 0) throw new CjError("CONFIG_INVALID", `No audit session matches: ${sessionIdOrPrefix}`);
    if (sessionIds.length > 1) throw new CjError("CONFIG_INVALID", `Ambiguous session ID prefix: ${sessionIdOrPrefix}`);
    const sessionId = sessionIds[0]!;
    return { sessionId, records: records.filter((record) => record.sessionId === sessionId) };
  }

  async exportTo(
    file: string,
    filter: { task?: string; session?: string } = {},
    format: AuditExportFormat = "jsonl"
  ): Promise<{ count: number; taskId?: string; sessionId?: string }> {
    if (filter.task && filter.session) throw new CjError("CONFIG_INVALID", "Choose either task or session, not both");
    const selected = filter.task
      ? await this.recordsForTask(filter.task)
      : filter.session
        ? await this.recordsForSession(filter.session)
        : undefined;
    const records = selected?.records ?? await this.list(Number.MAX_SAFE_INTEGER);
    const scope = selected && "taskId" in selected
      ? `任务 ${selected.taskId}`
      : selected && "sessionId" in selected
        ? `会话 ${selected.sessionId}`
        : "全部历史";
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const content = format === "html"
        ? renderAuditHtml(
            records,
            this.summarizeRecords(records, Number.MAX_SAFE_INTEGER),
            scope
          )
        : `${records.map((record) => JSON.stringify(record)).join("\n")}${records.length ? "\n" : ""}`;
      await writeFile(temporary, content, { mode: 0o600 });
      if (process.platform !== "win32") await chmod(temporary, 0o600);
      await rename(temporary, file);
      if (process.platform !== "win32") await chmod(file, 0o600);
      return {
        count: records.length,
        ...(selected && "taskId" in selected ? { taskId: selected.taskId } : {}),
        ...(selected && "sessionId" in selected ? { sessionId: selected.sessionId } : {})
      };
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async pruneOlderThan(cutoff: Date): Promise<{ removed: number; retained: number }> {
    const records = await this.list(Number.MAX_SAFE_INTEGER);
    const retained = records.filter((record) => new Date(record.timestamp).getTime() >= cutoff.getTime());
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${retained.map((record) => JSON.stringify(record)).join("\n")}${retained.length ? "\n" : ""}`, { mode: 0o600 });
      if (process.platform !== "win32") await chmod(temporary, 0o600);
      await rename(temporary, this.file);
      if (process.platform !== "win32") await chmod(this.file, 0o600);
      return { removed: records.length - retained.length, retained: retained.length };
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
