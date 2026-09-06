import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "../agent/events.js";
import { redactSecrets } from "../policy/sensitive-data.js";

export interface AuditRecord {
  version: 1;
  timestamp: string;
  taskId: string;
  event: string;
  data: Record<string, unknown>;
}

export interface TaskAuditContext {
  taskId: string;
  cliVersion: string;
  cwd: string;
  provider: string;
  model: string;
  promptHash: string;
}

function safeText(value: string): string {
  return redactSecrets(value).value.slice(0, 2_000);
}

function auditDataForAgentEvent(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case "status":
      return { message: safeText(event.message) };
    case "tool_start":
      return {
        tool: event.name,
        riskLevel: event.riskLevel,
        summary: safeText(event.summary)
      };
    case "tool_result":
      return {
        tool: event.name,
        success: event.success,
        message: safeText(event.message),
        durationMs: event.durationMs
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
    case "assistant_delta":
      return { deltaLength: event.content.length };
    case "assistant":
      return { responseLength: event.content.length };
  }
}

export class AuditStore {
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
    await this.append({
      version: 1,
      timestamp: new Date().toISOString(),
      taskId: context.taskId,
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
      event: event.type,
      data: auditDataForAgentEvent(event)
    });
  }

  async taskFinished(taskId: string, success: boolean, code?: string): Promise<void> {
    await this.append({
      version: 1,
      timestamp: new Date().toISOString(),
      taskId,
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
}
