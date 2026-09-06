import type { Command } from "commander";
import type { AuditStore } from "../../audit/store.js";
import { CjError } from "../../shared/errors.js";

export function addHistoryCommand(program: Command, audit: AuditStore): void {
  program
    .command("history")
    .description("Show local redacted audit history")
    .option("-n, --limit <number>", "maximum records", "50")
    .action(async (options: { limit: string }, command: Command) => {
      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw new CjError("CONFIG_INVALID", "limit must be between 1 and 1000");
      }
      const records = await audit.list(limit);
      if (command.optsWithGlobals().json === true) {
        for (const record of records) process.stdout.write(`${JSON.stringify(record)}\n`);
        return;
      }
      if (records.length === 0) {
        process.stdout.write("No history.\n");
        return;
      }
      for (const record of records) {
        process.stdout.write(`${record.timestamp}  ${record.taskId.slice(0, 8)}  ${record.event}`);
        const tool = typeof record.data.tool === "string" ? `  ${record.data.tool}` : "";
        const success = typeof record.data.success === "boolean" ? `  ${record.data.success ? "ok" : "failed"}` : "";
        process.stdout.write(`${tool}${success}\n`);
      }
    });
}
