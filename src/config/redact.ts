import type { AppConfig, AuthConfig } from "./schema.js";

export function redactAuth(auth: AuthConfig): unknown {
  return {
    version: auth.version,
    providers: Object.fromEntries(
      Object.entries(auth.providers).map(([provider, credential]) => [
        provider,
        credential.type === "api_key"
          ? { type: credential.type, key: "********" }
          : credential
      ])
    )
  };
}

export function printableConfig(config: AppConfig, auth: AuthConfig): unknown {
  return { ...config, auth: redactAuth(auth) };
}
