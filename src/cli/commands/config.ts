import { input, password, select } from "@inquirer/prompts";
import type { Command } from "commander";
import type { ConfigStore } from "../../config/store.js";
import { printableConfig } from "../../config/redact.js";

export function addConfigCommand(program: Command, store: ConfigStore): void {
  const command = program.command("config").description("Configure the LLM provider");

  command.action(async () => {
    const current = await store.loadConfig();
    const currentAuth = await store.loadAuth();
    const zh = current.language === "zh-CN";
    const provider = await input({ message: "Provider ID", default: current.provider.id });
    const baseURL = await input({ message: zh ? "API 地址" : "Base URL", default: current.provider.baseURL });
    const model = await input({ message: zh ? "模型" : "Model", default: current.provider.model });
    const language = await select({
      message: zh ? "界面语言" : "Display language",
      default: current.language,
      choices: [
        { name: "中文", value: "zh-CN" as const },
        { name: "English", value: "en" as const }
      ]
    });
    const storage = await select({
      message: zh ? "API Key 保存方式" : "API Key storage",
      choices: [
        { name: zh ? "保存到仅当前用户可读的 auth.json" : "Save in owner-only auth.json", value: "api_key" as const },
        { name: zh ? "从环境变量读取" : "Read from an environment variable", value: "env" as const }
      ]
    });

    const credential = storage === "api_key"
      ? {
          type: "api_key" as const,
          key: await password({ message: "API Key", mask: "*", validate: (value) => value.length > 0 || (zh ? "必填" : "Required") })
        }
      : {
          type: "env" as const,
          variable: await input({
            message: zh ? "环境变量名" : "Environment variable",
            default: "DEEPSEEK_API_KEY",
            validate: (value) => /^[A-Z_][A-Z0-9_]*$/.test(value) || (zh ? "请使用大写环境变量名" : "Use an uppercase environment variable name")
          })
        };

    await store.saveConfig({
      ...current,
      provider: { id: provider, baseURL, model, thinking: false },
      language
    });
    await store.saveAuth({
      ...currentAuth,
      providers: { ...currentAuth.providers, [provider]: credential }
    });
    process.stdout.write(zh ? "配置已保存。\n" : "Configuration saved.\n");
  });

  command
    .command("list")
    .description("Show configuration with credentials redacted")
    .action(async () => {
      process.stdout.write(`${JSON.stringify(printableConfig(await store.loadConfig(), await store.loadAuth()), null, 2)}\n`);
    });
}
