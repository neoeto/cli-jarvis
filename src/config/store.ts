import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { CjError } from "../shared/errors.js";
import {
  appConfigSchema,
  authConfigSchema,
  defaultConfig,
  emptyAuthConfig,
  migrateLegacyConfig,
  type AppConfig,
  type AuthConfig
} from "./schema.js";
import { getAppPaths, type AppPaths } from "./paths.js";
import { assertSecureWindowsAcl } from "./windows-acl.js";

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CjError("CONFIG_INVALID", `Cannot read ${file}`, { cause: error });
  }
}

async function atomicWriteJson(file: string, data: unknown, secret = false): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: secret ? 0o600 : 0o644 });
    if (secret) {
      if (process.platform === "win32") await assertSecureWindowsAcl(temporary);
      else await chmod(temporary, 0o600);
    }
    await rename(temporary, file);
    if (secret && process.platform !== "win32") await chmod(file, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export class ConfigStore {
  constructor(readonly paths: AppPaths = getAppPaths()) {}

  async loadConfig(): Promise<AppConfig> {
    const raw = await readJson(this.paths.configFile);
    if (raw === undefined) return defaultConfig;
    const result = appConfigSchema.safeParse(raw);
    if (result.success) return result.data;
    const migrated = migrateLegacyConfig(raw);
    if (!migrated) throw new CjError("CONFIG_INVALID", `Invalid config: ${result.error.message}`);
    // Migrate in memory first. Read-only commands (doctor, list, tools) must
    // not mutate a user's configuration merely by inspecting it; the next
    // explicit configuration save persists the v2 form atomically.
    return migrated;
  }

  async saveConfig(config: AppConfig): Promise<void> {
    const parsed = appConfigSchema.parse(config);
    // `provider` and `limits` are retained as a backwards-compatible active
    // profile view. Keep the view and the selected profile atomic on writes.
    const normalized: AppConfig = {
      ...parsed,
      profiles: {
        ...parsed.profiles,
        [parsed.activeProfile]: { provider: parsed.provider, limits: parsed.limits }
      }
    };
    await atomicWriteJson(this.paths.configFile, normalized);
  }

  async loadAuth(): Promise<AuthConfig> {
    const raw = await readJson(this.paths.authFile);
    if (raw === undefined) return emptyAuthConfig;
    if (process.platform !== "win32") {
      const mode = (await stat(this.paths.authFile)).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new CjError(
          "CONFIG_INVALID",
          `Credential file permissions are too broad (${mode.toString(8)}); expected 600: ${this.paths.authFile}`
        );
      }
    } else {
      await assertSecureWindowsAcl(this.paths.authFile);
    }
    const result = authConfigSchema.safeParse(raw);
    if (!result.success) {
      throw new CjError("CONFIG_INVALID", `Invalid auth config: ${result.error.message}`);
    }
    return result.data;
  }

  async saveAuth(auth: AuthConfig): Promise<void> {
    await atomicWriteJson(this.paths.authFile, authConfigSchema.parse(auth), true);
    await assertSecureWindowsAcl(this.paths.authFile);
  }

  /**
   * Validate a settings draft before writing either document. Both individual
   * writes remain atomic; if the config write fails after auth succeeds, put
   * the previous auth state back on a best-effort basis and preserve the
   * caller's draft for retry.
   */
  async saveSettings(config: AppConfig, auth: AuthConfig): Promise<void> {
    const parsedConfig = appConfigSchema.parse(config);
    const parsedAuth = authConfigSchema.parse(auth);
    const previousAuth = await this.loadAuth();
    await this.saveAuth(parsedAuth);
    try {
      await this.saveConfig(parsedConfig);
    } catch (error) {
      await this.saveAuth(previousAuth).catch(() => undefined);
      throw error;
    }
  }

  async resolveApiKey(providerId: string): Promise<string> {
    const credential = (await this.loadAuth()).providers[providerId];
    if (!credential) throw new CjError("AUTH_MISSING", `No credentials configured for ${providerId}`);
    if (credential.type === "api_key") return credential.key;
    const value = process.env[credential.variable];
    if (!value) {
      throw new CjError("AUTH_MISSING", `Environment variable ${credential.variable} is not set`);
    }
    return value;
  }
}
