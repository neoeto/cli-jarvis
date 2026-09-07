import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { CjError } from "../shared/errors.js";
import type { EffectKind, RiskLevel, Tool, ToolContext, PreparedAction, ToolResult } from "./types.js";
import { ToolRegistry } from "./registry.js";

const riskOrder: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
const effectSchema = z.enum(["read", "write", "move", "trash", "delete", "process", "network", "git"]);
const manifestSchema = z.object({
  version: z.literal(1),
  name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  module: z.string().min(1),
  description: z.string().min(1).max(2_000),
  riskLevel: z.enum(["low", "medium", "high"]),
  effects: z.array(effectSchema).min(1),
  permissions: z.array(z.enum(["workspace", "process", "network"])).min(1),
  platforms: z.array(z.enum(["darwin", "linux", "win32"])).min(1),
  dataFlows: z.array(z.enum(["filesystem", "process", "network"])).default([])
}).strict();

export type LocalToolManifest = z.infer<typeof manifestSchema>;
export interface ExtensionDiagnostic {
  directory: string;
  name?: string;
  enabled: boolean;
  ok: boolean;
  message: string;
}

function stronger(left: RiskLevel, right: RiskLevel): RiskLevel {
  return riskOrder[left] >= riskOrder[right] ? left : right;
}

function wrapExtension(tool: Tool, manifest: LocalToolManifest): Tool {
  if (tool.definition.function.name !== manifest.name) {
    throw new CjError("CONFIG_INVALID", `Extension name does not match manifest: ${manifest.name}`);
  }
  if (tool.possibleEffects.some((effect) => !manifest.effects.includes(effect))) {
    throw new CjError("CONFIG_INVALID", `Extension ${manifest.name} has effects not declared in its manifest`);
  }
  const requiredPermissions = new Set(manifest.effects.flatMap((effect) => {
    if (effect === "network") return ["network"];
    if (effect === "process" || effect === "git") return ["process"];
    return ["workspace"];
  }));
  if ([...requiredPermissions].some((permission) => !manifest.permissions.includes(permission as "workspace" | "process" | "network"))) {
    throw new CjError("CONFIG_INVALID", `Extension ${manifest.name} does not declare permissions for all effects`);
  }
  return {
    definition: {
      ...tool.definition,
      function: { ...tool.definition.function, description: manifest.description }
    },
    defaultRisk: stronger(tool.defaultRisk, manifest.riskLevel),
    possibleEffects: manifest.effects as EffectKind[],
    parse: (input: unknown) => tool.parse(input),
    async prepare(input: unknown, context: ToolContext): Promise<PreparedAction> {
      const action = await tool.prepare(input, context);
      if (action.toolName !== manifest.name) {
        throw new CjError("TOOL_FAILED", `Extension ${manifest.name} returned an action for another Tool`);
      }
      if (action.effects.some((effect) => !manifest.effects.includes(effect))) {
        throw new CjError("TOOL_FAILED", `Extension ${manifest.name} declared an undeclared effect`);
      }
      return { ...action, riskLevel: stronger(action.riskLevel, manifest.riskLevel) };
    },
    execute: (action: PreparedAction, context: ToolContext): Promise<ToolResult> => tool.execute(action, context)
  };
}

async function manifestsIn(toolsDir: string): Promise<Array<{ file: string; directory: string }>> {
  try {
    const entries = await readdir(toolsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ directory: path.join(toolsDir, entry.name), file: path.join(toolsDir, entry.name, "cj-tool.json") }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Discover opt-in extensions from `$CJ_CONFIG_DIR/tools/<extension>/cj-tool.json`. */
export async function discoverLocalTools(
  registry: ToolRegistry,
  toolsDir: string,
  enabledNames: readonly string[],
  loadEnabled = true
): Promise<ExtensionDiagnostic[]> {
  const diagnostics: ExtensionDiagnostic[] = [];
  for (const candidate of await manifestsIn(toolsDir)) {
    let manifest: LocalToolManifest;
    try {
      manifest = manifestSchema.parse(JSON.parse(await readFile(candidate.file, "utf8")));
      const enabled = enabledNames.includes(manifest.name);
      if (!manifest.platforms.includes(process.platform as "darwin" | "linux" | "win32")) {
        diagnostics.push({ directory: candidate.directory, name: manifest.name, enabled, ok: false, message: `Unsupported platform: ${process.platform}` });
        continue;
      }
      if (!enabled || !loadEnabled) {
        diagnostics.push({ directory: candidate.directory, name: manifest.name, enabled, ok: true, message: enabled ? "Validated; not loaded" : "Disabled" });
        continue;
      }
      const moduleFile = path.resolve(candidate.directory, manifest.module);
      if (!moduleFile.startsWith(`${candidate.directory}${path.sep}`) && moduleFile !== candidate.directory) {
        throw new CjError("CONFIG_INVALID", "Extension module must be inside its manifest directory");
      }
      if (!(await stat(moduleFile)).isFile()) throw new CjError("CONFIG_INVALID", `Extension module is not a file: ${manifest.module}`);
      const imported = await import(pathToFileURL(moduleFile).href);
      const exported = (imported.default ?? imported.tool) as Tool | undefined;
      if (!exported || typeof exported.prepare !== "function" || typeof exported.execute !== "function") {
        throw new CjError("CONFIG_INVALID", `Extension ${manifest.name} must export default or named tool`);
      }
      registry.register(wrapExtension(exported, manifest), "local-extension");
      diagnostics.push({ directory: candidate.directory, name: manifest.name, enabled, ok: true, message: "Loaded" });
    } catch (error) {
      diagnostics.push({
        directory: candidate.directory,
        enabled: false,
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return diagnostics;
}
