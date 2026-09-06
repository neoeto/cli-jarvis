import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config/schema.js";
import { createDeepSeekProvider } from "../../src/providers/deepseek.js";

const apiKey = process.env.DEEPSEEK_API_KEY;

describe.skipIf(!apiKey)("DeepSeek live API", () => {
  it("returns text and a required Tool call", async () => {
    const provider = createDeepSeekProvider(defaultConfig, apiKey!);
    const signal = AbortSignal.timeout(25_000);
    const text = await provider.complete(
      {
        model: defaultConfig.provider.model,
        messages: [{ role: "user", content: "Reply with exactly OK." }],
        tools: [],
        toolChoice: "none"
      },
      signal
    );
    expect(text.kind).toBe("message");

    const call = await provider.complete(
      {
        model: defaultConfig.provider.model,
        messages: [{ role: "user", content: "Call list_files with path set to a single dot." }],
        tools: [
          {
            type: "function",
            function: {
              name: "list_files",
              description: "List files",
              parameters: {
                type: "object",
                additionalProperties: false,
                required: ["path"],
                properties: { path: { type: "string" } }
              }
            }
          }
        ],
        toolChoice: "required"
      },
      signal
    );
    expect(call).toMatchObject({ kind: "tool_calls", calls: [expect.objectContaining({ name: "list_files" })] });
  });
});
