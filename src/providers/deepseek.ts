import type { AppConfig } from "../config/schema.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

export function createDeepSeekProvider(config: AppConfig, apiKey: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: config.provider.id,
    apiKey,
    baseURL: config.provider.baseURL,
    extraBody: { thinking: { type: config.provider.thinking ? "enabled" : "disabled" } }
  });
}
