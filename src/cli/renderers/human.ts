import pc from "picocolors";
import textWidth from "string-width";
import type { AgentEvent, EventSink } from "../../agent/events.js";
import { redactSecrets } from "../../policy/sensitive-data.js";
import { renderMarkdown } from "./markdown.js";

type Colors = ReturnType<typeof pc.createColors>;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function wrapText(value: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const { segment: character } of graphemes.segment(value)) {
    if (character === "\n" || character === "\r\n") {
      lines.push(line);
      line = "";
      lineWidth = 0;
      continue;
    }
    const characterWidth = textWidth(character);
    if (line && lineWidth + characterWidth > width) {
      lines.push(line);
      line = "";
      lineWidth = 0;
    }
    line += character;
    lineWidth += characterWidth;
  }
  lines.push(line);
  return lines;
}

function confirmationPanel(
  request: Extract<AgentEvent, { type: "confirmation_requested" }>["request"],
  language: "zh-CN" | "en",
  colors: Colors
): string {
  const zh = language === "zh-CN";
  const label = (name: string, value: string): string => `${name}: ${value}`;
  const rawLines = [
    label(zh ? "操作" : "operation", request.summary),
    label(zh ? "影响" : "effects", request.effects.join(", ") || (zh ? "未声明" : "unspecified")),
    label(zh ? "可恢复" : "reversible", request.reversible === undefined ? (zh ? "未知" : "unknown") : request.reversible ? (zh ? "是" : "yes") : (zh ? "否" : "no")),
    ...request.targets.map((target) => label(zh ? "目标" : "target", target))
  ];
  const terminalColumns = typeof process.stderr.columns === "number" ? process.stderr.columns : 100;
  const width = Math.max(42, Math.min(96, terminalColumns - 6));
  const lines = rawLines.flatMap((line) => wrapText(line, width));
  // Use a fixed-width marker: terminals disagree on whether ⚠ takes one or two cells.
  const header = ` ${zh ? "! 需要确认" : "! Confirmation required"} `;
  const headerWidth = textWidth(header);
  // The top line has `┏━` before the title and `┓` after its fill, while
  // content lines and the bottom border occupy width + 4 cells. Keep the
  // top-right corner in the same column even when the title has wide CJK
  // characters or emoji.
  const topFill = Math.max(1, width + 1 - headerWidth);
  const styleLine = (line: string): string => {
    const separator = line.indexOf(":");
    const styled = separator > 0
      ? `${colors.bold(line.slice(0, separator + 1))}${line.slice(separator + 1)}`
      : line;
    return `${colors.yellow("┃")} ${styled}${" ".repeat(Math.max(0, width - textWidth(line)))} ${colors.yellow("┃")}`;
  };
  return [
    `${colors.yellow("┏━")}${colors.bgYellow(colors.black(header))}${colors.yellow("━".repeat(topFill))}${colors.yellow("┓")}`,
    ...lines.map(styleLine),
    `${colors.yellow("┗")}${colors.yellow("━".repeat(width + 2))}${colors.yellow("┛")}`
  ].join("\n");
}

function batchConfirmationPanel(
  requests: Extract<AgentEvent, { type: "confirmation_batch_requested" }>["requests"],
  language: "zh-CN" | "en",
  colors: Colors
): string {
  const title = language === "zh-CN" ? `⚠ 需要确认（${requests.length} 个操作）` : `⚠ Confirmation required (${requests.length} operations)`;
  const rows = requests.flatMap((request, index) => [
    `${index + 1}. ${request.toolName}: ${request.summary}`,
    ...(request.targets.length ? [`   ${language === "zh-CN" ? "目标" : "targets"}: ${request.targets.join(", ")}`] : [])
  ]);
  return `${colors.yellow(title)}\n${rows.map((row) => `  ${row}`).join("\n")}`;
}

export function createHumanRenderer(options: {
  verbose: boolean;
  language: "zh-CN" | "en";
  plain?: boolean;
  noColor?: boolean;
}): EventSink {
  const colors = pc.createColors(pc.isColorSupported && !(options.plain || options.noColor));
  const zh = options.language === "zh-CN";
  const muted = (label: string, message: string): void => {
    const lines = redactSecrets(message).value.split("\n");
    process.stderr.write(`${colors.dim(lines.map((line, index) =>
      `  ${index === 0 ? `[${label}]` : "  │"} ${line}`
    ).join("\n"))}\n`);
  };
  return (event: AgentEvent) => {
    switch (event.type) {
      case "status":
        muted(zh ? "状态" : "Status", event.message);
        break;
      case "task_status":
        if (options.verbose) muted(zh ? "任务" : "Task", `[${event.taskId.slice(0, 8)}] ${event.status}${event.detail ? `: ${event.detail}` : ""}`);
        break;
      case "task_step":
        if (options.verbose) muted(zh ? "步骤" : "Step", `[${event.taskId.slice(0, 8)}] ${event.stepId} ${event.status}${event.dependsOn.length ? ` ← ${event.dependsOn.join(", ")}` : ""}${event.detail ? `: ${event.detail}` : ""}`);
        break;
      case "tool_start":
        muted(zh ? "工具" : "Tool", `→ ${event.name}: ${event.summary}`);
        break;
      case "tool_preview":
        muted(zh ? "预览" : "Preview", `◇ ${event.name}: ${event.summary}`);
        break;
      case "tool_result":
        if (event.success) {
          muted(zh ? "完成" : "Done", `✓ ${event.message} (${event.durationMs}ms)`);
        } else {
          process.stderr.write(`${colors.red(`✗ [${zh ? "失败" : "Failed"}] ${event.message}`)} ${colors.dim(`(${event.durationMs}ms)`)}\n`);
        }
        if (options.verbose && event.data !== undefined) {
          const serialized = redactSecrets(JSON.stringify(event.data, null, 2)).value;
          muted(zh ? "详情" : "Details", serialized);
        }
        if (event.recovery) {
          process.stderr.write(`${colors.dim(options.language === "zh-CN" ? `恢复提示：${event.recovery.instruction}` : `Recovery hint: ${event.recovery.instruction}`)}\n`);
        }
        break;
      case "confirmation_requested": {
        const { request } = event;
        process.stderr.write(`${confirmationPanel(request, options.language, colors)}\n`);
        break;
      }
      case "confirmation_resolved":
        process.stderr.write(`${event.approved ? colors.green(options.language === "zh-CN" ? "✓ 已批准" : "✓ Approved") : colors.red(options.language === "zh-CN" ? "✗ 未批准" : "✗ Not approved")}\n`);
        break;
      case "confirmation_batch_requested":
        process.stderr.write(`${batchConfirmationPanel(event.requests, options.language, colors)}\n`);
        break;
      case "confirmation_batch_resolved":
        process.stderr.write(`${event.approved ? colors.green(options.language === "zh-CN" ? `✓ 已批准 ${event.actionIds.length} 个操作` : `✓ Approved ${event.actionIds.length} operations`) : colors.red(options.language === "zh-CN" ? "✗ 未批准操作批次" : "✗ Operation batch not approved")}\n`);
        break;
      case "question_requested":
        // The terminal question handler renders the interactive control. Keep
        // this semantic event silent to avoid printing the question twice.
        break;
      case "question_resolved":
        muted(zh ? "状态" : "Status", zh ? "✓ 已收到回答" : "✓ Answer received");
        break;
      case "assistant_delta":
        // A text delta may precede Tool calls. Wait for the semantic response
        // before deciding whether it belongs to the answer or the process log.
        break;
      case "assistant_progress":
        muted(zh ? "决策" : "Decision", renderMarkdown(event.content, pc.createColors(false)));
        break;
      case "reasoning":
        if (options.verbose) muted(zh ? "思考" : "Reasoning", renderMarkdown(event.content, pc.createColors(false)));
        break;
      case "assistant": {
        const answer = renderMarkdown(event.content, colors);
        if (!answer) break;
        // Keep redirected stdout free of presentation labels for scripts.
        const heading = process.stdout.isTTY
          ? `\n${colors.bold(colors.cyan(zh ? "━━ 回答 ━━" : "━━ Answer ━━"))}\n\n`
          : "";
        process.stdout.write(`${heading}${answer}\n${process.stdout.isTTY ? "\n" : ""}`);
        break;
      }
      case "memory_used":
        muted(zh ? "记忆" : "Memory", zh ? `使用了 ${event.ids.length} 条本地记忆：${event.purpose}` : `Used ${event.ids.length} local memory fact(s): ${event.purpose}`);
        break;
    }
  };
}
