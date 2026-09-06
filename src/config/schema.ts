import { z } from "zod";

export const appConfigSchema = z.object({
  version: z.literal(1),
  provider: z.object({
    id: z.string().min(1),
    baseURL: z.string().url(),
    model: z.string().min(1),
    thinking: z.boolean()
  }),
  language: z.enum(["zh-CN", "en"]),
  limits: z.object({
    maxToolCalls: z.number().int().min(1).max(20),
    taskTimeoutMs: z.number().int().min(1_000).max(300_000)
  })
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export const defaultConfig: AppConfig = {
  version: 1,
  provider: {
    id: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    thinking: false
  },
  language: "zh-CN",
  limits: {
    maxToolCalls: 20,
    taskTimeoutMs: 300_000
  }
};

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
