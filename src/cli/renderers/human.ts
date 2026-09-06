import pc from "picocolors";
import type { AgentEvent, EventSink } from "../../agent/events.js";
import { redactSecrets } from "../../policy/sensitive-data.js";
import { renderMarkdown } from "./markdown.js";

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

function confirmationPanel(request: Extract<AgentEvent, { type: "confirmation_requested" }>['request'], language: "zh-CN" | "en"): string {
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
      ? `${pc.bold(line.slice(0, separator + 1))}${line.slice(separator + 1)}`
      : line;
    return `${pc.yellow("┃")} ${styled}${" ".repeat(Math.max(0, width - textWidth(line)))} ${pc.yellow("┃")}`;
  };
  return [
    `${pc.yellow("┏━")}${pc.bgYellow(pc.black(header))}${pc.yellow("━".repeat(topFill))}${pc.yellow("┓")}`,
    ...lines.map(styleLine),
    `${pc.yellow("┗")}${pc.yellow("━".repeat(width + 2))}${pc.yellow("┛")}`
  ].join("\n");
}

export function createHumanRenderer(options: { verbose: boolean; language: "zh-CN" | "en" }): EventSink {
  return (event: AgentEvent) => {
    switch (event.type) {
      case "status":
        process.stderr.write(`${pc.dim(event.message)}\n`);
        break;
      case "tool_start":
        process.stderr.write(`${pc.cyan("→")} ${pc.bold(event.name)}: ${event.summary}\n`);
        break;
      case "tool_result":
        process.stderr.write(`${event.success ? pc.green("✓") : pc.red("✗")} ${event.message} ${pc.dim(`(${event.durationMs}ms)`)}\n`);
        if (options.verbose && event.data !== undefined) {
          const serialized = redactSecrets(JSON.stringify(event.data, null, 2)).value;
          process.stderr.write(`${pc.dim(serialized)}\n`);
        }
        break;
      case "confirmation_requested": {
        const { request } = event;
        process.stderr.write(`${confirmationPanel(request, options.language)}\n`);
        break;
      }
      case "confirmation_resolved":
        process.stderr.write(`${event.approved ? pc.green(options.language === "zh-CN" ? "✓ 已批准" : "✓ Approved") : pc.red(options.language === "zh-CN" ? "✗ 未批准" : "✗ Not approved")}\n`);
        break;
      case "assistant_delta":
        // Markdown is rendered after the complete assistant message arrives.
        break;
      case "assistant":
        process.stdout.write(`${renderMarkdown(event.content)}\n`);
        break;
    }
  };
}
