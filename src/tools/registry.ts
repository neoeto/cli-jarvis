import { CjError } from "../shared/errors.js";
import type { ModelToolDefinition } from "../providers/types.js";
import type { Tool } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly origins = new Map<string, "builtin" | "local-extension">();

  register(tool: Tool, origin: "builtin" | "local-extension" = "builtin"): this {
    const name = tool.definition.function.name;
    if (this.tools.has(name)) throw new Error(`Tool already registered: ${name}`);
    this.tools.set(name, tool);
    this.origins.set(name, origin);
    return this;
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) throw new CjError("TOOL_NOT_FOUND", `Unknown Tool: ${name}`);
    return tool;
  }

  definitions(): ModelToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  entries(): Tool[] {
    return [...this.tools.values()];
  }

  origin(name: string): "builtin" | "local-extension" | undefined {
    return this.origins.get(name);
  }
}
