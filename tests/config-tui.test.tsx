import React from "react";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { defaultConfig, type AuthConfig } from "../src/config/schema.js";
import { ConfigTuiApp } from "../src/cli/config-tui/app.js";
import {
  addProfile,
  createConfigDraft,
  credentialSummary,
  draftChanged,
  removeProfile,
  selectProfile,
  updateActiveProfile,
  validateDraft
} from "../src/cli/config-tui/model.js";

const auth: AuthConfig = {
  version: 1,
  providers: { deepseek: { type: "api_key", key: "sk-top-secret-value" } }
};
const execFileAsync = promisify(execFile);

describe("config TUI draft model", () => {
  it("keeps active profile mirrors in sync while profiles are added, selected, and edited", () => {
    const initial = createConfigDraft(defaultConfig, auth);
    const withWork = addProfile(initial, "work");
    const selected = selectProfile(withWork, "work");
    const updated = updateActiveProfile(selected, (profile) => ({
      ...profile,
      provider: { ...profile.provider, id: "openai", kind: "openai-compatible" }
    }));

    expect(updated.config.activeProfile).toBe("work");
    expect(updated.config.provider.id).toBe("openai");
    expect(updated.config.profiles.work?.provider.id).toBe("openai");
    expect(draftChanged(initial, updated)).toBe(true);
    expect(validateDraft(updated)).toBeUndefined();
    expect(() => removeProfile(updated, "work")).toThrow(/active profile/i);
  });

  it("never exposes literal API keys in credential labels", () => {
    expect(credentialSummary(auth, "deepseek", "en")).toBe("Stored API key");
    expect(credentialSummary(auth, "deepseek", "zh-CN")).toBe("已保存 API Key");
    expect(credentialSummary(auth, "deepseek", "en")).not.toContain("sk-top-secret-value");
  });
});

describe("config TUI rendering", () => {
  it("renders the settings navigation without rendering API key contents", () => {
    const app = render(<ConfigTuiApp
      initial={createConfigDraft(defaultConfig, auth)}
      externalEntries={{}}
      validateExternalCommand={async (value) => ({ command: value, entry: "/usr/bin/example" })}
      onApply={async () => undefined}
    />);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("CJ 应用配置");
    expect(frame).toContain("模型档案");
    expect(frame).not.toContain("sk-top-secret-value");
    app.unmount();
  });

  it("shows a dedicated Tavily web-search settings page", async () => {
    const app = render(<ConfigTuiApp
      initial={createConfigDraft({ ...defaultConfig, webSearch: { enabled: true } }, {
        version: 1,
        providers: { tavily: { type: "env", variable: "TAVILY_API_KEY" } }
      })}
      externalEntries={{}}
      validateExternalCommand={async (value) => ({ command: value, entry: "/usr/bin/example" })}
      onApply={async () => undefined}
    />);
    app.stdin.write("\u001b[B");
    app.stdin.write("\u001b[B");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("网络搜索");
    expect(frame).toContain("启用 Tavily 网络搜索: 开启");
    expect(frame).toContain("Tavily API Key: 环境变量: TAVILY_API_KEY");
    app.unmount();
  });

  it("shows registered PATH commands with their current resolution", async () => {
    const app = render(<ConfigTuiApp
      initial={createConfigDraft({ ...defaultConfig, externalCli: { commands: ["greet", "missing"] } }, auth)}
      externalEntries={{ greet: "/usr/local/bin/greet", missing: "" }}
      validateExternalCommand={async (value) => ({ command: value, entry: `/usr/local/bin/${value}` })}
      onApply={async () => undefined}
    />);
    for (let index = 0; index < 5; index++) app.stdin.write("\u001b[B");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("PATH 工具");
    expect(frame).toContain("/usr/local/bin/greet");
    expect(frame).toContain("当前 PATH 中不可用");
    app.unmount();
  });


  it("rejects JSON/non-interactive invocation before writing settings", async () => {
    const entry = path.resolve("src/cli/index.ts");
    const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    let failure: (Error & { code?: number; stdout?: string }) | undefined;
    try {
      await execFileAsync(process.execPath, ["--import", tsxImport, entry, "--json", "config", "tui"], {
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
      });
    } catch (error) {
      failure = error as Error & { code?: number; stdout?: string };
    }
    expect(failure?.code).toBe(2);
    expect(failure?.stdout).toContain('"code":"CONFIG_INVALID"');
    expect(failure?.stdout).toContain("cannot run in JSON mode");
  });
});
