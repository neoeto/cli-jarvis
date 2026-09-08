import { appConfigSchema, authConfigSchema, type AppConfig, type AuthConfig, type ProfileConfig } from "../../config/schema.js";

export interface ConfigDraft {
  config: AppConfig;
  auth: AuthConfig;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export function createConfigDraft(config: AppConfig, auth: AuthConfig): ConfigDraft {
  return { config: copy(config), auth: copy(auth) };
}

export function draftChanged(baseline: ConfigDraft, draft: ConfigDraft): boolean {
  return JSON.stringify(baseline) !== JSON.stringify(draft);
}

export function activeProfile(draft: ConfigDraft): ProfileConfig {
  const profile = draft.config.profiles[draft.config.activeProfile];
  if (!profile) throw new Error("Active profile is missing");
  return profile;
}

/** Keep the legacy active-profile mirrors consistent with the profile table. */
export function syncActiveProfile(draft: ConfigDraft): ConfigDraft {
  const profile = activeProfile(draft);
  return {
    ...draft,
    config: { ...draft.config, provider: copy(profile.provider), limits: copy(profile.limits) }
  };
}

export function selectProfile(draft: ConfigDraft, name: string): ConfigDraft {
  if (!draft.config.profiles[name]) throw new Error(`Unknown profile: ${name}`);
  return syncActiveProfile({ ...draft, config: { ...draft.config, activeProfile: name } });
}

export function updateActiveProfile(draft: ConfigDraft, update: (profile: ProfileConfig) => ProfileConfig): ConfigDraft {
  const name = draft.config.activeProfile;
  return syncActiveProfile({
    ...draft,
    config: { ...draft.config, profiles: { ...draft.config.profiles, [name]: update(activeProfile(draft)) } }
  });
}

export function addProfile(draft: ConfigDraft, name: string): ConfigDraft {
  const normalized = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) throw new Error("Profile name must start with a letter or number and use only letters, numbers, dots, underscores, or hyphens");
  if (draft.config.profiles[normalized]) throw new Error("A profile with this name already exists");
  return {
    ...draft,
    config: {
      ...draft.config,
      profiles: { ...draft.config.profiles, [normalized]: copy(activeProfile(draft)) }
    }
  };
}

export function removeProfile(draft: ConfigDraft, name: string): ConfigDraft {
  if (name === draft.config.activeProfile) throw new Error("The active profile cannot be removed");
  if (!draft.config.profiles[name]) throw new Error("Unknown profile");
  const { [name]: _removed, ...profiles } = draft.config.profiles;
  return { ...draft, config: { ...draft.config, profiles } };
}

export function validateDraft(draft: ConfigDraft): string | undefined {
  const config = appConfigSchema.safeParse(syncActiveProfile(draft).config);
  if (!config.success) return config.error.issues[0]?.message ?? "Invalid configuration";
  const auth = authConfigSchema.safeParse(draft.auth);
  if (!auth.success) return auth.error.issues[0]?.message ?? "Invalid credentials";
  return undefined;
}

export function credentialSummary(auth: AuthConfig, provider: string, language: "zh-CN" | "en"): string {
  const credential = auth.providers[provider];
  if (!credential) return language === "zh-CN" ? "未配置" : "Not configured";
  return credential.type === "api_key"
    ? (language === "zh-CN" ? "已保存 API Key" : "Stored API key")
    : `${language === "zh-CN" ? "环境变量" : "Environment"}: ${credential.variable}`;
}

export function addUnique(values: string[], value: string): string[] {
  const normalized = value.trim();
  return normalized && !values.includes(normalized) ? [...values, normalized] : values;
}

export function removeAt<T>(values: T[], index: number): T[] {
  return values.filter((_, itemIndex) => itemIndex !== index);
}
