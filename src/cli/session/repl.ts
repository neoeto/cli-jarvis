import { asCjError, CjError } from "../../shared/errors.js";
import type { HistorySummary, TaskHistorySummary } from "../../audit/store.js";
import type { UsageSummary } from "../../providers/usage.js";
import { formatUsage } from "../../providers/usage.js";
import type { SessionInput } from "./input.js";
import { parseSessionInput, type SessionCommand } from "./commands.js";

export interface ChatStatus {
  startedAt: string;
  sessionId?: string;
  turns: number;
  contextMessages: number;
  provider: string;
  model: string;
  workspaceRoot: string;
  usage?: UsageSummary;
}

export interface SessionHandlers {
  input: SessionInput;
  language: "zh-CN" | "en";
  runPrompt: (prompt: string, signal: AbortSignal, retry?: boolean) => Promise<unknown>;
  clear: () => void;
  status: () => ChatStatus;
  tools: () => string;
  history: () => Promise<string>;
  last: () => Promise<string>;
  write: (message: string) => void;
  reportError: (error: CjError) => void;
  prompt?: string;
}

function helpText(language: "zh-CN" | "en"): string {
  return language === "zh-CN"
    ? "输入问题开始对话。命令：/clear、/status、/tools、/history、/last、/retry、/cancel、/exit。"
    : "Enter a prompt to start. Commands: /clear, /status, /tools, /history, /last, /retry, /cancel, /exit.";
}

function formatStatus(status: ChatStatus, language: "zh-CN" | "en"): string {
  if (language === "zh-CN") {
    return [
      "会话状态",
      `  开始时间: ${status.startedAt}`,
      ...(status.sessionId ? [`  会话 ID: ${status.sessionId}`] : []),
      `  已完成轮次: ${status.turns}`,
      `  当前上下文消息: ${status.contextMessages}`,
      ...(status.usage ? [`  Token 用量: ${formatUsage(status.usage, language)}`] : []),
      `  Provider: ${status.provider}`,
      `  模型: ${status.model}`,
      `  工作区: ${status.workspaceRoot}`
    ].join("\n");
  }
  return [
    "Session status",
    `  Started: ${status.startedAt}`,
    ...(status.sessionId ? [`  Session ID: ${status.sessionId}`] : []),
    `  Completed turns: ${status.turns}`,
    `  Context messages: ${status.contextMessages}`,
    ...(status.usage ? [`  Token usage: ${formatUsage(status.usage, language)}`] : []),
    `  Provider: ${status.provider}`,
    `  Model: ${status.model}`,
    `  Workspace: ${status.workspaceRoot}`
  ].join("\n");
}

function unknownCommand(command: Extract<SessionCommand, { kind: "unknown" }>, language: "zh-CN" | "en"): string {
  return language === "zh-CN"
    ? `未知命令 ${command.name}。输入 /status 查看状态，或 /exit 退出。`
    : `Unknown command ${command.name}. Use /status for status or /exit to leave.`;
}

/** Run a TTY chat loop. Local commands never enter the model transcript. */
export async function runInteractiveSession(options: SessionHandlers): Promise<void> {
  const { input, language, write } = options;
  const prompt = options.prompt ?? "cj> ";
  let exiting = false;
  let activeTurn = false;
  let lastPrompt: string | undefined;
  let cancelCurrentTurn: (() => void) | undefined;
  let interruptsForCurrentTurn = 0;

  const removeInterrupt = input.onInterrupt(() => {
    if (activeTurn && cancelCurrentTurn) {
      if (interruptsForCurrentTurn > 0) {
        exiting = true;
        cancelCurrentTurn();
        write(language === "zh-CN" ? "\n会话已退出。" : "\nSession closed.");
        input.close();
        return;
      }
      interruptsForCurrentTurn += 1;
      cancelCurrentTurn();
      write(language === "zh-CN" ? "\n正在取消当前任务…" : "\nCancelling the current task…");
      return;
    }
    exiting = true;
    input.close();
  });

  write(language === "zh-CN" ? `CJ 会话已启动。${helpText(language)}` : `CJ session started. ${helpText(language)}`);
  const runTurn = async (promptText: string, retry = false): Promise<void> => {
    activeTurn = true;
    const controller = new AbortController();
    cancelCurrentTurn = () => controller.abort(new Error("Interrupted"));
    interruptsForCurrentTurn = 0;
    try {
      await options.runPrompt(promptText, controller.signal, retry);
      lastPrompt = promptText;
    } catch (error) {
      options.reportError(asCjError(error));
    } finally {
      activeTurn = false;
      cancelCurrentTurn = undefined;
      interruptsForCurrentTurn = 0;
    }
  };
  try {
    while (!exiting) {
      const raw = await input.next(prompt);
      if (raw === undefined) break;
      const command = parseSessionInput(raw);
      switch (command.kind) {
        case "empty":
          continue;
        case "clear":
          options.clear();
          write(language === "zh-CN" ? "上下文已清空。" : "Context cleared.");
          continue;
        case "status":
          write(formatStatus(options.status(), language));
          continue;
        case "tools":
          write(options.tools());
          continue;
        case "history":
          try {
            write(await options.history());
          } catch (error) {
            options.reportError(asCjError(error));
          }
          continue;
        case "last":
          try {
            write(await options.last());
          } catch (error) {
            options.reportError(asCjError(error));
          }
          continue;
        case "cancel":
          write(language === "zh-CN" ? "当前没有运行中的任务；运行中任务请按 Ctrl+C 取消。" : "No task is currently running; press Ctrl+C to cancel a running task.");
          continue;
        case "retry":
          if (!lastPrompt) {
            write(language === "zh-CN" ? "没有可重试的已完成任务。" : "There is no completed task to retry.");
            continue;
          }
          await runTurn(lastPrompt, true);
          continue;
        case "exit":
          exiting = true;
          write(language === "zh-CN" ? "会话已退出。" : "Session closed.");
          continue;
        case "unknown":
          write(unknownCommand(command, language));
          continue;
        case "prompt":
          await runTurn(command.prompt);
          continue;
      }
    }
  } finally {
    removeInterrupt();
    input.close();
  }
}

export function formatTools(tools: Array<{ name: string; risk: string; description: string }>, language: "zh-CN" | "en"): string {
  if (tools.length === 0) return language === "zh-CN" ? "没有可用工具。" : "No Tools are available.";
  const header = language === "zh-CN" ? "可用工具" : "Available Tools";
  return [header, ...tools.map((tool) => `  ${tool.name}\t${tool.risk}\t${tool.description}`)].join("\n");
}

export function formatHistory(
  records: Array<{ timestamp: string; taskId: string; sessionId?: string; event: string; data: Record<string, unknown> }>,
  language: "zh-CN" | "en"
): string {
  if (records.length === 0) return language === "zh-CN" ? "暂无历史记录。" : "No history.";
  return records.map((record) => {
    const tool = typeof record.data.tool === "string" ? `  ${record.data.tool}` : "";
    const success = typeof record.data.success === "boolean" ? `  ${record.data.success ? "ok" : "failed"}` : "";
    const session = record.sessionId ? `  session:${record.sessionId.slice(0, 8)}` : "";
    return `${record.timestamp}  ${record.taskId.slice(0, 8)}${session}  ${record.event}${tool}${success}`;
  }).join("\n");
}

export function formatTaskHistory(
  summaries: TaskHistorySummary[],
  language: "zh-CN" | "en"
): string {
  if (summaries.length === 0) return language === "zh-CN" ? "暂无历史记录。" : "No history.";
  return summaries.map((summary) => {
    const session = summary.sessionId ? `  session:${summary.sessionId.slice(0, 8)}` : "";
    const duration = summary.durationMs === undefined
      ? "-"
      : summary.durationMs < 1_000
        ? `${summary.durationMs}ms`
        : `${(summary.durationMs / 1_000).toFixed(summary.durationMs < 10_000 ? 1 : 0)}s`;
    const status = language === "zh-CN"
      ? summary.status === "completed" ? "完成" : summary.status === "failed" ? "失败" : summary.status === "cancelled" ? "已取消" : "未完成"
      : summary.status;
    const title = summary.title ?? (language === "zh-CN" ? "旧记录，无介绍" : "Legacy record, no description");
    return `${summary.startedAt}  task:${summary.taskId.slice(0, 8)}${session}  ${status}  ${formatUsage(summary, language)}  tools:${summary.toolCalls}  ${duration}  ${title}${summary.errorCode ? `  ${summary.errorCode}` : ""}`;
  }).join("\n");
}

export function formatGroupedHistory(summaries: HistorySummary[], language: "zh-CN" | "en"): string {
  if (summaries.length === 0) return language === "zh-CN" ? "暂无历史记录。" : "No history.";
  return summaries.map((summary) => {
    const status = language === "zh-CN"
      ? summary.status === "completed" ? "完成" : summary.status === "failed" ? "失败" : summary.status === "cancelled" ? "已取消" : "未完成"
      : summary.status;
    const title = summary.title ?? (language === "zh-CN" ? "旧记录，无介绍" : "Legacy record, no description");
    if (summary.kind === "task") {
      return `${summary.lastActiveAt}  task:${summary.taskId.slice(0, 8)}  ${status}  ${formatUsage(summary, language)}  tools:${summary.toolCalls}  ${title}`;
    }
    const failures = summary.failedTurns || summary.cancelledTurns
      ? `  failed:${summary.failedTurns} cancelled:${summary.cancelledTurns}`
      : "";
    return `${summary.lastActiveAt}  chat:${summary.sessionId.slice(0, 8)}  ${status}  turns:${summary.turns}${failures}  ${formatUsage(summary, language)}  tools:${summary.toolCalls}  ${title}`;
  }).join("\n");
}
