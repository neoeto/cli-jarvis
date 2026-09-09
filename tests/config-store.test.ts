import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/store.js";
import { printableConfig } from "../src/config/redact.js";
import { defaultConfig } from "../src/config/schema.js";
import { getAppPaths } from "../src/config/paths.js";

const created: string[] = [];

async function temporaryStore(): Promise<ConfigStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cj-config-test-"));
  created.push(directory);
  return new ConfigStore(getAppPaths({ CJ_CONFIG_DIR: directory }));
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ConfigStore", () => {
  it("returns defaults when no config exists", async () => {
    const store = await temporaryStore();
    await expect(store.loadConfig()).resolves.toEqual(defaultConfig);
  });

  it("persists config and redacts nothing internally", async () => {
    const store = await temporaryStore();
    const config = { ...defaultConfig, language: "en" as const };
    await store.saveConfig(config);
    await expect(store.loadConfig()).resolves.toEqual(config);
  });

  it("accepts a tool-call limit above the default", async () => {
    const store = await temporaryStore();
    const config = structuredClone(defaultConfig);
    config.limits.maxToolCalls = 50;
    if (config.profiles.default) config.profiles.default.limits.maxToolCalls = 50;
    await store.saveConfig(config);
    await expect(store.loadConfig()).resolves.toMatchObject({ limits: { maxToolCalls: 50 } });
  });

  it("stores and resolves a literal API key", async () => {
    const store = await temporaryStore();
    await store.saveAuth({
      version: 1,
      providers: { deepseek: { type: "api_key", key: "test-secret" } }
    });
    await expect(store.resolveApiKey("deepseek")).resolves.toBe("test-secret");
    expect(await readFile(store.paths.authFile, "utf8")).toContain("test-secret");
    if (process.platform !== "win32") {
      await chmod(store.paths.authFile, 0o600);
      expect((await stat(store.paths.authFile)).mode & 0o777).toBe(0o600);
    }
  });

  it("validates both configuration documents before batch settings save", async () => {
    const store = await temporaryStore();
    const invalidAuth = { version: 1, providers: { deepseek: { type: "env", variable: "not-valid" } } } as unknown as Parameters<ConfigStore["saveSettings"]>[1];
    await expect(store.saveSettings(defaultConfig, invalidAuth)).rejects.toThrow();
    await expect(readFile(store.paths.authFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(store.paths.configFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the previous auth state when saving config fails after auth succeeds", async () => {
    const store = await temporaryStore();
    await store.saveAuth({ version: 1, providers: { deepseek: { type: "api_key", key: "old-secret" } } });
    await mkdir(store.paths.configFile, { recursive: true });
    await expect(store.saveSettings(defaultConfig, {
      version: 1,
      providers: { deepseek: { type: "api_key", key: "new-secret" } }
    })).rejects.toThrow();
    await expect(store.resolveApiKey("deepseek")).resolves.toBe("old-secret");
  });

  it("rejects a credential file readable by group or other users", async () => {
    if (process.platform === "win32") return;
    const store = await temporaryStore();
    await store.saveAuth({
      version: 1,
      providers: { deepseek: { type: "api_key", key: "test-secret" } }
    });
    await chmod(store.paths.authFile, 0o644);
    await expect(store.loadAuth()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("never exposes a literal key through printable configuration", () => {
    const printable = JSON.stringify(printableConfig(defaultConfig, {
      version: 1,
      providers: { deepseek: { type: "api_key", key: "sk-abcdefghijklmnopqrstuvwxyz" } }
    }));
    expect(printable).toContain("********");
    expect(printable).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("migrates a v1 single-provider configuration in memory without touching credentials", async () => {
    const store = await temporaryStore();
    await mkdir(path.dirname(store.paths.configFile), { recursive: true });
    await writeFile(store.paths.configFile, JSON.stringify({
      version: 1,
      provider: { id: "legacy", baseURL: "https://example.test/v1", model: "legacy-model", thinking: false },
      language: "en",
      limits: { maxToolCalls: 5, taskTimeoutMs: 60_000 }
    }));
    const migrated = await store.loadConfig();
    expect(migrated).toMatchObject({ version: 3, activeProfile: "default", provider: { id: "legacy", kind: "openai-compatible" } });
    expect(migrated.profiles.default?.limits.modelTimeoutMs).toBe(60_000);
  });

  it("defaults web search to disabled for existing v2 configuration files", async () => {
    const store = await temporaryStore();
    const { webSearch: _webSearch, ...preWebSearchConfig } = defaultConfig;
    await mkdir(path.dirname(store.paths.configFile), { recursive: true });
    await writeFile(store.paths.configFile, JSON.stringify(preWebSearchConfig));
    await expect(store.loadConfig()).resolves.toMatchObject({ version: 3, webSearch: { enabled: false } });
  });

  it("migrates v2 settings while discarding directory-based external CLI registrations", async () => {
    const store = await temporaryStore();
    const { externalCli: _externalCli, ...withoutExternalCli } = defaultConfig;
    const previous = {
      ...withoutExternalCli,
      version: 2,
      externalCli: { directories: ["/tmp/old-cli-directory"] }
    };
    await mkdir(path.dirname(store.paths.configFile), { recursive: true });
    await writeFile(store.paths.configFile, JSON.stringify(previous));
    await expect(store.loadConfig()).resolves.toMatchObject({
      version: 3,
      externalCli: { commands: [] },
      provider: defaultConfig.provider,
      language: defaultConfig.language
    });
  });
});
