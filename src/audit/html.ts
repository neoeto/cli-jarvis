import type { AuditRecord, TaskHistorySummary } from "./store.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;"
  })[character] ?? character);
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "未记录";
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function statusLabel(status: TaskHistorySummary["status"]): string {
  return {
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    incomplete: "未完成"
  }[status];
}

function eventLabel(event: string): string {
  return {
    task_started: "任务开始",
    task_finished: "任务结束",
    task_status: "任务状态",
    task_step: "任务步骤",
    tool_start: "工具开始",
    tool_preview: "工具预览",
    tool_result: "工具结果",
    confirmation_requested: "请求确认",
    confirmation_resolved: "确认结果",
    confirmation_batch_requested: "批量确认请求",
    confirmation_batch_resolved: "批量确认结果",
    question_requested: "请求澄清",
    question_resolved: "已收到澄清",
    assistant_delta: "助手流式输出",
    assistant: "助手响应",
    status: "状态",
    memory_used: "使用记忆"
  }[event] ?? event;
}

interface DisplayEvent {
  timestamp: string;
  type: string;
  count: number;
  data: Record<string, unknown>;
}

function collapseEvents(records: AuditRecord[]): DisplayEvent[] {
  const output: DisplayEvent[] = [];
  for (const record of records) {
    const previous = output.at(-1);
    if (record.event === "assistant_delta" && previous?.type === "assistant_delta") {
      previous.count += 1;
      const previousLength = typeof previous.data.deltaLength === "number" ? previous.data.deltaLength : 0;
      const currentLength = typeof record.data.deltaLength === "number" ? record.data.deltaLength : 0;
      previous.data = { deltaLength: previousLength + currentLength };
      continue;
    }
    output.push({ timestamp: record.timestamp, type: record.event, count: 1, data: record.data });
  }
  return output;
}

function taskDetails(records: AuditRecord[], summaries: TaskHistorySummary[]): string {
  const byTask = new Map<string, AuditRecord[]>();
  for (const record of records) {
    const taskRecords = byTask.get(record.taskId) ?? [];
    taskRecords.push(record);
    byTask.set(record.taskId, taskRecords);
  }
  const summariesByTask = new Map(summaries.map((summary) => [summary.taskId, summary]));
  const taskIds = [...summaries.map((summary) => summary.taskId), ...byTask.keys()]
    .filter((taskId, index, all) => all.indexOf(taskId) === index);
  return taskIds.map((taskId) => {
    const taskRecords = byTask.get(taskId) ?? [];
    const summary = summariesByTask.get(taskId);
    const status = summary?.status ?? "incomplete";
    const eventRows = collapseEvents(taskRecords).map((event) => {
      const count = event.count > 1 ? `<span class="event-count">合并 ${event.count} 个片段</span>` : "";
      return `<tr><td><time datetime="${escapeHtml(event.timestamp)}">${escapeHtml(formatTimestamp(event.timestamp))}</time></td><td><span class="event-name">${escapeHtml(eventLabel(event.type))}</span><code>${escapeHtml(event.type)}</code>${count}</td><td><pre>${escapeHtml(JSON.stringify(event.data, null, 2))}</pre></td></tr>`;
    }).join("\n");
    const session = summary?.sessionId
      ? `<span><small>会话</small><code>${escapeHtml(summary.sessionId)}</code></span>`
      : "<span><small>会话</small><b>单次任务</b></span>";
    return `<details class="task-detail"><summary class="task-summary"><span class="task-primary"><code>${escapeHtml(taskId)}</code><span class="status status-${status}">${statusLabel(status)}</span></span><span class="task-secondary"><span><small>开始</small><time datetime="${escapeHtml(summary?.startedAt ?? taskRecords[0]?.timestamp ?? "")}">${escapeHtml(formatTimestamp(summary?.startedAt ?? taskRecords[0]?.timestamp ?? ""))}</time></span>${session}<span><small>事件</small><b>${formatNumber(summary?.eventCount ?? taskRecords.length)}</b></span><span><small>耗时</small><b>${formatDuration(summary?.durationMs)}</b></span></span></summary><div class="detail-body"><div class="detail-intro"><p>已折叠连续的助手流式输出。以下内容仅包含已脱敏的审计元数据。</p></div><div class="table-scroll"><table class="events"><caption class="sr-only">${escapeHtml(taskId)} 的事件明细</caption><thead><tr><th scope="col">时间</th><th scope="col">事件</th><th scope="col">脱敏数据</th></tr></thead><tbody>${eventRows}</tbody></table></div></div></details>`;
  }).join("\n");
}

function exportRange(records: AuditRecord[]): string {
  if (records.length === 0) return "无记录";
  const timestamps = records.map((record) => record.timestamp).sort();
  return `${formatTimestamp(timestamps[0]!)} 至 ${formatTimestamp(timestamps.at(-1)!)}`;
}

/** Render a standalone, local-only report from already-redacted audit records. */
export function renderAuditHtml(
  records: AuditRecord[],
  summaries: TaskHistorySummary[],
  scope: string
): string {
  const completed = summaries.filter((summary) => summary.status === "completed").length;
  const attentionRequired = summaries.length - completed;
  const taskRows = summaries.map((summary) => {
    const session = summary.sessionId ? `<code>${escapeHtml(summary.sessionId)}</code>` : "单次任务";
    const error = summary.errorCode ? `<code>${escapeHtml(summary.errorCode)}</code>` : "无";
    return `<tr><td><time datetime="${escapeHtml(summary.startedAt)}">${escapeHtml(formatTimestamp(summary.startedAt))}</time></td><td><code>${escapeHtml(summary.taskId)}</code></td><td>${session}</td><td><span class="status status-${summary.status}">${statusLabel(summary.status)}</span></td><td>${formatNumber(summary.toolCalls)}</td><td>${formatNumber(summary.eventCount)}</td><td>${formatDuration(summary.durationMs)}</td><td>${error}</td></tr>`;
  }).join("\n") || "<tr><td class=\"empty-row\" colspan=\"8\">没有可导出的审计任务。</td></tr>";
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>CJ 历史报告</title>
<style>
  :root {
    color-scheme: light dark;
    --canvas: #f5f7f7;
    --surface: #ffffff;
    --surface-muted: #eef3f2;
    --ink: #172422;
    --muted: #53635f;
    --line: #cbd8d4;
    --accent: #0f766e;
    --accent-soft: #d9eeea;
    --success: #18794e;
    --success-soft: #ddf2e6;
    --failure: #b42318;
    --failure-soft: #fbe5e2;
    --cancelled: #a15c10;
    --cancelled-soft: #fbecd8;
    --radius: 14px;
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --canvas: #101716;
      --surface: #17201e;
      --surface-muted: #1d2926;
      --ink: #e8f1ee;
      --muted: #adbbb6;
      --line: #38504a;
      --accent: #54b5a9;
      --accent-soft: #173f39;
      --success: #79d6a0;
      --success-soft: #153c2b;
      --failure: #f5a19a;
      --failure-soft: #4a2423;
      --cancelled: #f1bd7d;
      --cancelled-soft: #4a3420;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--canvas); color: var(--ink); line-height: 1.5; }
  .shell { width: min(1280px, calc(100% - 40px)); margin: 0 auto; padding: 36px 0 64px; }
  .report-header { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 420px); gap: 36px; align-items: end; padding: 0 0 28px; border-bottom: 1px solid var(--line); }
  .eyebrow { margin: 0 0 9px; color: var(--accent); font: 700 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; }
  h1, h2 { margin: 0; letter-spacing: -.035em; }
  h1 { font-size: clamp(2rem, 4vw, 3rem); line-height: 1.06; }
  h2 { font-size: 1.15rem; line-height: 1.2; }
  .lede { max-width: 58ch; margin: 14px 0 0; color: var(--muted); font-size: 1rem; }
  .report-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 22px; margin: 0; padding: 17px 18px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
  .report-meta div { min-width: 0; }
  dt, small { display: block; margin-bottom: 3px; color: var(--muted); font-size: .72rem; font-weight: 650; letter-spacing: .03em; }
  dd { margin: 0; overflow-wrap: anywhere; font-size: .88rem; }
  code, pre, time { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  code { overflow-wrap: anywhere; }
  .overview { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 30px 0 40px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
  .metric { min-width: 0; padding: 18px 20px; }
  .metric + .metric { border-left: 1px solid var(--line); }
  .metric small { margin-bottom: 7px; }
  .metric strong { display: block; font-size: clamp(1.5rem, 3vw, 2rem); letter-spacing: -.04em; line-height: 1; }
  .metric.accent { background: var(--accent-soft); color: var(--accent); }
  .metric.attention strong { color: var(--failure); }
  section + section { margin-top: 44px; }
  .section-heading { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; margin-bottom: 14px; }
  .section-heading p { margin: 0; color: var(--muted); font-size: .88rem; }
  .table-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
  table { width: 100%; border-collapse: collapse; min-width: 860px; font-size: .84rem; }
  th, td { padding: 12px 14px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); }
  th { background: var(--surface-muted); color: var(--muted); font-size: .72rem; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:nth-child(even) { background: color-mix(in srgb, var(--surface-muted) 45%, transparent); }
  .empty-row { padding: 28px 14px; text-align: center; color: var(--muted); }
  .status { display: inline-flex; align-items: center; min-height: 24px; padding: 2px 8px; border: 1px solid currentColor; border-radius: 999px; font-size: .75rem; font-weight: 700; line-height: 1; white-space: nowrap; }
  .status-completed { color: var(--success); background: var(--success-soft); }
  .status-failed { color: var(--failure); background: var(--failure-soft); }
  .status-cancelled { color: var(--cancelled); background: var(--cancelled-soft); }
  .status-incomplete { color: var(--muted); background: var(--surface-muted); }
  .task-detail { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); margin: 10px 0; overflow: hidden; }
  .task-summary { display: grid; grid-template-columns: minmax(180px, .85fr) minmax(0, 2fr); gap: 18px; align-items: center; padding: 16px 42px 16px 18px; cursor: pointer; list-style: none; position: relative; }
  .task-summary::-webkit-details-marker { display: none; }
  .task-summary::before { content: "+"; position: absolute; right: 18px; color: var(--accent); font: 700 1.1rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .task-detail[open] .task-summary::before { content: "-"; }
  .task-summary:hover { background: var(--surface-muted); }
  .task-summary:focus-visible { outline: 3px solid var(--accent); outline-offset: -3px; }
  .task-primary { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .task-primary code { font-size: .9rem; font-weight: 700; }
  .task-secondary { display: grid; grid-template-columns: 1.25fr 1.5fr .55fr .6fr; gap: 12px; min-width: 0; }
  .task-secondary span { min-width: 0; }
  .task-secondary b, .task-secondary time, .task-secondary code { display: block; font-size: .82rem; font-weight: 600; overflow-wrap: anywhere; }
  .detail-body { border-top: 1px solid var(--line); }
  .detail-intro { padding: 12px 18px; background: var(--surface-muted); }
  .detail-intro p { margin: 0; color: var(--muted); font-size: .82rem; }
  .detail-body .table-scroll { margin: 16px 18px 18px; border-radius: 10px; }
  .events { min-width: 760px; font-size: .8rem; }
  .events th:first-child { width: 174px; }
  .events th:nth-child(2) { width: 190px; }
  .events td:nth-child(2) { min-width: 175px; }
  .event-name { display: block; margin-bottom: 3px; font-weight: 700; }
  .event-count { display: inline-block; margin: 6px 0 0; color: var(--accent); font-size: .74rem; font-weight: 700; }
  pre { max-width: 620px; margin: 0; color: var(--ink); font-size: .77rem; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
  .report-footer { margin-top: 44px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: .8rem; }
  .report-footer p { margin: 0; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  @media (max-width: 780px) {
    .shell { width: min(100% - 28px, 1280px); padding-top: 25px; }
    .report-header { grid-template-columns: 1fr; gap: 24px; }
    .overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .metric:nth-child(3) { border-left: 0; border-top: 1px solid var(--line); }
    .metric:nth-child(4) { border-top: 1px solid var(--line); }
    .task-summary { grid-template-columns: 1fr; gap: 14px; }
    .task-summary::before { top: 18px; }
    .task-secondary { grid-template-columns: 1fr 1fr; }
    .section-heading { display: block; }
    .section-heading p { margin-top: 6px; }
  }
  @media print {
    @page { margin: 14mm; }
    :root { color-scheme: light; }
    body { background: #fff; color: #172422; }
    .shell { width: 100%; padding: 0; }
    .report-meta, .overview, .task-detail, .table-scroll { break-inside: avoid; }
    .task-summary:hover { background: transparent; }
  }
</style>
</head>
<body>
<main class="shell">
  <header class="report-header">
    <div>
      <p class="eyebrow">本地审计记录</p>
      <h1>CJ 历史报告</h1>
      <p class="lede">按任务汇总的本地执行记录，可展开查看已脱敏的事件元数据。</p>
    </div>
    <dl class="report-meta">
      <div><dt>导出范围</dt><dd>${escapeHtml(scope)}</dd></div>
      <div><dt>导出时间</dt><dd>${escapeHtml(formatTimestamp(new Date().toISOString()))}</dd></div>
      <div><dt>时间范围</dt><dd>${escapeHtml(exportRange(records))}</dd></div>
      <div><dt>时区</dt><dd>${escapeHtml(timeZone)}</dd></div>
    </dl>
  </header>

  <section class="overview" aria-label="导出概览">
    <div class="metric accent"><small>任务</small><strong>${formatNumber(summaries.length)}</strong></div>
    <div class="metric"><small>审计事件</small><strong>${formatNumber(records.length)}</strong></div>
    <div class="metric"><small>已完成</small><strong>${formatNumber(completed)}</strong></div>
    <div class="metric attention"><small>需关注</small><strong>${formatNumber(attentionRequired)}</strong></div>
  </section>

  <section aria-labelledby="summary-heading">
    <div class="section-heading"><h2 id="summary-heading">任务摘要</h2><p>第二列为任务 ID。会话 ID 仅在 chat 任务中出现。</p></div>
    <div class="table-scroll"><table><caption class="sr-only">任务摘要</caption><thead><tr><th scope="col">开始时间</th><th scope="col">任务 ID</th><th scope="col">会话</th><th scope="col">状态</th><th scope="col">工具</th><th scope="col">事件</th><th scope="col">耗时</th><th scope="col">错误</th></tr></thead><tbody>${taskRows}</tbody></table></div>
  </section>

  <section aria-labelledby="details-heading">
    <div class="section-heading"><h2 id="details-heading">事件明细</h2><p>展开任务以查看详情。</p></div>
    ${taskDetails(records, summaries) || "<p class=\"empty-row\">没有可导出的审计事件。</p>"}
  </section>

  <footer class="report-footer"><p>此页面由 cj 在本机生成，只包含已脱敏的审计元数据。</p></footer>
</main>
</body>
</html>`;
}
