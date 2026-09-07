import type { AppConfig } from "../config/schema.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/**
 * Create an adapter without leaking DeepSeek request fields to other
 * OpenAI-compatible providers. The legacy name remains exported for callers
 * that only use the default profile.
 */
export function createProvider(config: AppConfig, apiKey: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: config.provider.id,
    apiKey,
    baseURL: config.provider.baseURL,
    ...(config.provider.kind === "deepseek"
      ? { extraBody: { thinking: { type: config.provider.thinking ? "enabled" : "disabled" } } }
      : {})
  });
}

export function createDeepSeekProvider(config: AppConfig, apiKey: string): OpenAICompatibleProvider {
  return createProvider(config, apiKey);
}
