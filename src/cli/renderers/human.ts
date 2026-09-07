import pc from "picocolors";
import type { AgentEvent, EventSink } from "../../agent/events.js";
import { redactSecrets } from "../../policy/sensitive-data.js";
import { renderMarkdown } from "./markdown.js";

type Colors = ReturnType<typeof pc.createColors>;

function textWidth(value: string): number {
  return [...value].reduce(
    (width, character) => width + (/[^\u0000-\u00FF]/u.test(character) ? 2 : 1),
    0
  );
}

function wrapText(value: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const character of value) {
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
  const header = ` ${zh ? "⚠ 需要确认" : "⚠ Confirmation required"} `;
  const headerWidth = textWidth(header);
  const topFill = Math.max(1, width + 2 - headerWidth - 2);
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
  let streamedMarkdown = "";
  let sawStreamDelta = false;
  const flushStream = (final = false): void => {
    if (!streamedMarkdown) return;
    const fences = (streamedMarkdown.match(/(^|\n)\s*```/g) ?? []).length;
    // Do not render an unfinished fenced block. Rendering only completed
    // paragraph blocks also avoids repeatedly repainting Markdown syntax.
    const paragraphBreak = streamedMarkdown.lastIndexOf("\n\n");
    const lastBreak = final && fences % 2 === 0
      ? streamedMarkdown.length
      : fences % 2 === 0 && paragraphBreak >= 0
        ? paragraphBreak + 2
        : 0;
    if (lastBreak <= 0) return;
    const safe = streamedMarkdown.slice(0, lastBreak);
    streamedMarkdown = streamedMarkdown.slice(lastBreak);
    const rendered = renderMarkdown(safe, colors);
    if (rendered) process.stdout.write(`${rendered}\n`);
  };
  return (event: AgentEvent) => {
    switch (event.type) {
      case "status":
        process.stderr.write(`${colors.dim(event.message)}\n`);
        break;
      case "task_status":
        if (options.verbose) process.stderr.write(`${colors.dim(`[${event.taskId.slice(0, 8)}] ${event.status}${event.detail ? `: ${event.detail}` : ""}`)}\n`);
        break;
      case "task_step":
        if (options.verbose) process.stderr.write(`${colors.dim(`[${event.taskId.slice(0, 8)}] ${event.stepId} ${event.status}${event.dependsOn.length ? ` ← ${event.dependsOn.join(", ")}` : ""}${event.detail ? `: ${event.detail}` : ""}`)}\n`);
        break;
      case "tool_start":
        process.stderr.write(`${colors.cyan("→")} ${colors.bold(event.name)}: ${event.summary}\n`);
        break;
      case "tool_preview":
        process.stderr.write(`${colors.cyan("◇")} ${colors.bold(event.name)}: ${event.summary} ${colors.dim(options.language === "zh-CN" ? "(预览)" : "(preview)")}\n`);
        break;
      case "tool_result":
        process.stderr.write(`${event.success ? colors.green("✓") : colors.red("✗")} ${event.message} ${colors.dim(`(${event.durationMs}ms)`)}\n`);
        if (options.verbose && event.data !== undefined) {
          const serialized = redactSecrets(JSON.stringify(event.data, null, 2)).value;
          process.stderr.write(`${colors.dim(serialized)}\n`);
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
      case "assistant_delta":
        sawStreamDelta = true;
        streamedMarkdown += event.content;
        flushStream();
        break;
      case "assistant":
        if (sawStreamDelta && event.streamed) {
          // Providers return both deltas and a complete string. Only flush the
          // unrendered suffix so users never see a duplicated answer.
          flushStream(true);
          if (streamedMarkdown) {
            process.stdout.write(`${renderMarkdown(streamedMarkdown, colors)}\n`);
            streamedMarkdown = "";
          }
        } else {
          process.stdout.write(`${renderMarkdown(event.content, colors)}\n`);
        }
        sawStreamDelta = false;
        streamedMarkdown = "";
        break;
      case "memory_used":
        process.stderr.write(`${colors.dim(options.language === "zh-CN" ? `使用了 ${event.ids.length} 条本地记忆：${event.purpose}` : `Used ${event.ids.length} local memory fact(s): ${event.purpose}`)}\n`);
        break;
    }
  };
}
