import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverLocalTools } from "../src/tools/extensions.js";
import { ToolRegistry } from "../src/tools/registry.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local Tool discovery", () => {
  it("loads only enabled manifests and preserves their declared risk floor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cj-tools-test-"));
    created.push(root);
    const directory = path.join(root, "example_tool");
    await mkdir(directory);
    await writeFile(path.join(directory, "cj-tool.json"), JSON.stringify({
      version: 1,
      name: "example_tool",
      module: "tool.mjs",
      description: "An example tool",
      riskLevel: "high",
      effects: ["read"],
      permissions: ["workspace"],
      platforms: [process.platform],
      dataFlows: ["filesystem"]
    }));
    await writeFile(path.join(directory, "tool.mjs"), `
      export default {
        definition: { type: "function", function: { name: "example_tool", description: "ignored", parameters: { type: "object" } } },
        defaultRisk: "low", possibleEffects: ["read"], parse: (value) => value,
        prepare: async () => ({ id: "a", toolName: "example_tool", riskLevel: "low", summary: "read", targets: [], effects: ["read"], payload: {}, expiresAt: new Date(Date.now() + 1000).toISOString() }),
        execute: async () => ({ success: true, message: "ok", effects: [] })
      };
    `);
    const registry = new ToolRegistry();
    await expect(discoverLocalTools(registry, root, [])).resolves.toEqual([
      expect.objectContaining({ name: "example_tool", enabled: false, ok: true })
    ]);
    await expect(discoverLocalTools(registry, root, ["example_tool"])).resolves.toEqual([
      expect.objectContaining({ name: "example_tool", enabled: true, ok: true, message: "Loaded" })
    ]);
    expect(registry.get("example_tool").defaultRisk).toBe("high");
    expect(registry.origin("example_tool")).toBe("local-extension");
  });
});
