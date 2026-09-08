import path from "node:path";
import { z } from "zod";

export const providerConfigSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  baseURL: z.string().url(),
  model: z.string().min(1),
  /** The only provider-specific setting currently supported by the DeepSeek adapter. */
  thinking: z.boolean(),
  kind: z.enum(["deepseek", "openai-compatible"]).default("openai-compatible")
}).strict();

export const profileSchema = z.object({
  provider: providerConfigSchema,
  limits: z.object({
    maxToolCalls: z.number().int().min(1),
    taskTimeoutMs: z.number().int().min(1_000).max(300_000),
    modelTimeoutMs: z.number().int().min(1_000).max(300_000),
    toolTimeoutMs: z.number().int().min(100).max(120_000),
    maxOutputBytes: z.number().int().min(1_024).max(10 * 1024 * 1024)
  })
}).strict();

const legacyConfigSchema = z.object({
  version: z.literal(1),
  provider: z.object({
    id: z.string().min(1),
    baseURL: z.string().url(),
    model: z.string().min(1),
    thinking: z.boolean()
  }),
  language: z.enum(["zh-CN", "en"]),
  limits: z.object({
    maxToolCalls: z.number().int().min(1),
    taskTimeoutMs: z.number().int().min(1_000).max(300_000)
  })
}).strict();

export const appConfigSchema = z.object({
  version: z.literal(2),
  /** A compatibility mirror of the active profile's provider. Never edit it directly. */
  provider: providerConfigSchema,
  activeProfile: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  profiles: z.record(z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), profileSchema).refine(
    (profiles) => Object.keys(profiles).length > 0,
    "At least one profile is required"
  ),
  language: z.enum(["zh-CN", "en"]),
  limits: profileSchema.shape.limits,
  security: z.object({
    /** Workspace-relative roots that may be addressed by tools. The host ceiling is always the workspace. */
    allowedRoots: z.array(z.string().min(1).refine(
      (value) => !/^(?:[a-zA-Z]:[\\/]|[\\/]|\.\.(?:[\\/]|$))/.test(value),
      "Authorization roots must be workspace-relative"
    )).min(1).max(100).default(["."])
  }).default({ allowedRoots: ["."] }),
  memory: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  externalCli: z.object({ directories: z.array(z.string().min(1).refine((value) => path.isAbsolute(value), "CLI directories must be absolute")).max(100).default([]) }).strict().default({ directories: [] }),
  plugins: z.object({ enabled: z.array(z.string().min(1)).max(100).default([]) }).default({ enabled: [] }),
  skills: z.object({
    trustedWorkspaceDirectories: z.array(z.object({
      directory: z.string().min(1).refine((value) => path.isAbsolute(value), "Skill directory must be absolute"),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/)
    }).strict()).max(100).default([])
  }).strict().default({ trustedWorkspaceDirectories: [] })
}).strict().superRefine((value, context) => {
  if (!value.profiles[value.activeProfile]) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["activeProfile"], message: "Active profile does not exist" });
  }
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProfileConfig = z.infer<typeof profileSchema>;
export type LegacyAppConfig = z.infer<typeof legacyConfigSchema>;

export const defaultConfig: AppConfig = {
  version: 2,
  provider: {
    id: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    thinking: false,
    kind: "deepseek"
  },
  activeProfile: "default",
  profiles: {
    default: {
      provider: {
        id: "deepseek",
        baseURL: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        thinking: false,
        kind: "deepseek"
      },
      limits: {
        maxToolCalls: 20,
        taskTimeoutMs: 300_000,
        modelTimeoutMs: 120_000,
        toolTimeoutMs: 60_000,
        maxOutputBytes: 512 * 1024
      }
    }
  },
  language: "zh-CN",
  limits: {
    maxToolCalls: 20,
    taskTimeoutMs: 300_000,
    modelTimeoutMs: 120_000,
    toolTimeoutMs: 60_000,
    maxOutputBytes: 512 * 1024
  },
  security: { allowedRoots: ["."] },
  memory: { enabled: false },
  externalCli: { directories: [] },
  plugins: { enabled: [] },
  skills: { trustedWorkspaceDirectories: [] }
};

/** Convert the original single-provider file without changing its credentials. */
export function migrateLegacyConfig(input: unknown): AppConfig | undefined {
  const legacy = legacyConfigSchema.safeParse(input);
  if (!legacy.success) return undefined;
  const kind = legacy.data.provider.id === "deepseek" ? "deepseek" as const : "openai-compatible" as const;
  const provider: ProviderConfig = { ...legacy.data.provider, kind };
  const limits = {
    ...legacy.data.limits,
    modelTimeoutMs: Math.min(120_000, legacy.data.limits.taskTimeoutMs),
    toolTimeoutMs: 60_000,
    maxOutputBytes: 512 * 1024
  };
  return {
    version: 2,
    provider,
    activeProfile: "default",
    profiles: { default: { provider, limits } },
    language: legacy.data.language,
    limits,
    security: { allowedRoots: ["."] },
    memory: { enabled: false },
    externalCli: { directories: [] },
    plugins: { enabled: [] },
    skills: { trustedWorkspaceDirectories: [] }
  };
}

export const authConfigSchema = z.object({
  version: z.literal(1),
  providers: z.record(
    z.string(),
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("api_key"), key: z.string().min(1) }),
      z.object({ type: z.literal("env"), variable: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) })
    ])
  )
});

export type AuthConfig = z.infer<typeof authConfigSchema>;

export const emptyAuthConfig: AuthConfig = { version: 1, providers: {} };
