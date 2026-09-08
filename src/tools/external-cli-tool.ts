import { z } from "zod";
import { createHash } from "node:crypto";
import os from "node:os";
import type { Capability } from "./external-cli-review.js";
import { RunCommandTool } from "./builtins/run-command.js";
import type { Tool, ToolContext, PreparedAction } from "./types.js";

export function externalToolName(entry: string, command: string[]): string {
  const label = `${entry.split(/[\\/]/).pop()}_${command.join("_")}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  return `cli_${label}_${createHash("sha256").update(JSON.stringify([entry, command])).digest("hex").slice(0, 12)}`;
}

export function createExternalTool(entry: string, executable: string, capability: Capability, assertUnchanged: () => Promise<void>): Tool {
  const runner = new RunCommandTool();
  const name = externalToolName(entry, capability.command);
  const shape: Record<string, z.ZodTypeAny> = {};
  const properties: Record<string, unknown> = {};
  for (const parameter of capability.parameters) {
    let value: z.ZodTypeAny = parameter.type === "boolean" ? z.boolean() : parameter.type === "integer" ? z.number().int().safe() : z.string().max(8192).refine((text) => !text.includes("\0") && !text.startsWith("-"), "Values must not start with '-' or contain NUL");
    if (parameter.choices.length) value = value.refine((input) => parameter.choices.includes(String(input)), "Unsupported choice");
    if (parameter.type === "boolean" && parameter.required) value = value.refine((input) => input === true, "Required flag must be true");
    shape[parameter.name] = parameter.required ? value : value.optional();
    properties[parameter.name] = { type: parameter.type, description: parameter.description, ...(parameter.choices.length ? { enum: parameter.choices } : {}) };
  }
  shape.cwd = z.string().default(".");
  shape.timeout_ms = z.number().int().min(100).max(120000).default(30000);
  properties.cwd = { type: "string", default: "." };
  properties.timeout_ms = { type: "integer", minimum: 100, maximum: 120000, default: 30000 };
  const schema = z.object(shape).strict();
  return {
    defaultRisk: "high", possibleEffects: runner.possibleEffects,
    definition: { type: "function", function: { name, description: `${capability.description}\nUsage: ${capability.example}\nExternal CLI; execution requires confirmation.`, parameters: { type: "object", additionalProperties: false, properties, required: capability.parameters.filter((item) => item.required).map((item) => item.name) } } },
    parse: (input) => schema.parse(input),
    async prepare(raw: unknown, context: ToolContext): Promise<PreparedAction> {
      await assertUnchanged();
      const input = schema.parse(raw);
      const args = [...capability.command];
      let omittedPositional = false;
      for (const parameter of capability.parameters) {
        const value = input[parameter.name];
        if (value === undefined) { if (!parameter.flag) omittedPositional = true; continue; }
        if (!parameter.flag && omittedPositional) throw new Error("Cannot skip an earlier positional argument");
        if (parameter.type === "boolean") { if (value) args.push(parameter.flag!); }
        else { if (parameter.flag) args.push(parameter.flag); args.push(String(value)); }
      }
      const action = await runner.prepare(runner.parse({ command: executable, args, cwd: input.cwd, environment: { HOME: os.homedir() }, timeoutMs: Math.min(Number(input.timeout_ms), context.toolTimeoutMs ?? 120000) }), context);
      return { ...action, toolName: name };
    },
    async execute(action, context) {
      await assertUnchanged();
      return runner.execute(action as Parameters<RunCommandTool["execute"]>[0], context);
    }
  };
}
