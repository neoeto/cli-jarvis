import { CjError } from "../shared/errors.js";
import type { ModelToolDefinition } from "../providers/types.js";
import type { Tool } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    const name = tool.definition.function.name;
    if (this.tools.has(name)) throw new Error(`Tool already registered: ${name}`);
    this.tools.set(name, tool);
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
}
