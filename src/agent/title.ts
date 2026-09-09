import { redactSecrets } from "../policy/sensitive-data.js";
import type { ModelProvider } from "../providers/types.js";

export interface TaskTitle {
  title: string;
  generated: boolean;
}

export function cleanTaskTitle(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(normalized).slice(0, 60).join("");
}

export function fallbackTaskTitle(prompt: string, language: "zh-CN" | "en"): string {
  return cleanTaskTitle(redactSecrets(prompt).value.slice(0, 2_000)) || (language === "zh-CN" ? "未命名任务" : "Untitled task");
}

export async function createTaskTitle(options: {
  provider: ModelProvider;
  model: string;
  prompt: string;
  language: "zh-CN" | "en";
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<TaskTitle> {
  const fallback = fallbackTaskTitle(options.prompt, options.language);
  try {
    const response = await options.provider.complete({
      model: options.model,
      messages: [
        { role: "system", content: "Create a concise title for this user request. Return only the title, with no quotes or punctuation wrapper. Maximum 60 characters." },
        { role: "user", content: redactSecrets(options.prompt).value.slice(0, 2_000) }
      ],
      tools: [],
      toolChoice: "none"
    }, AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]));
    if (response.kind === "message") {
      const title = cleanTaskTitle(response.content);
      if (title) return { title, generated: true };
    }
  } catch {
    // Title generation is best effort and must never prevent the actual task.
  }
  return { title: fallback, generated: false };
}
