import pc from "picocolors";
import type { AgentEvent, EventSink } from "../../agent/events.js";
import { redactSecrets } from "../../policy/sensitive-data.js";

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
      const zh = options.language === "zh-CN";
      process.stderr.write(`${pc.yellow("⚠")} ${pc.bold(zh ? "需要确认" : "Confirmation required")}\n`);
      process.stderr.write(`  ${request.summary}\n`);
      process.stderr.write(`  ${zh ? "影响" : "effects"}: ${request.effects.join(", ") || (zh ? "未声明" : "unspecified")}\n`);
      process.stderr.write(`  ${zh ? "可恢复" : "reversible"}: ${request.reversible === undefined ? (zh ? "未知" : "unknown") : request.reversible ? (zh ? "是" : "yes") : (zh ? "否" : "no")}\n`);
      for (const target of request.targets.slice(0, 20)) process.stderr.write(`  ${zh ? "目标" : "target"}: ${target}\n`);
      if (request.targets.length > 20) {
        process.stderr.write(`  ${zh ? `… 以及另外 ${request.targets.length - 20} 个目标` : `… and ${request.targets.length - 20} more targets`}\n`);
      }
      break;
    }
    case "confirmation_resolved":
      process.stderr.write(`${event.approved ? pc.green(options.language === "zh-CN" ? "✓ 已批准" : "✓ Approved") : pc.red(options.language === "zh-CN" ? "✗ 未批准" : "✗ Not approved")}\n`);
      break;
    case "assistant_delta":
      process.stdout.write(event.content);
      break;
    case "assistant":
      process.stdout.write(event.streamed ? "\n" : `${event.content}\n`);
      break;
  }
  };
}
