import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { createDeepSeekProvider } from "../src/providers/deepseek.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
    )
  );
});

describe("DeepSeek provider", () => {
  it("sends non-thinking Chat Completions requests and normalizes Tool calls", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let authorization: string | undefined;
    const usageSnapshots: number[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      authorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const usage = {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_cache_hit_tokens: 6,
        prompt_cache_miss_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 3 }
      };
      response.end(
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-v4-flash",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "list_files", arguments: '{"path":"."}' }
                  }
                ]
              }
            }
          ]
        })}\n\ndata: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-flash", choices: [], usage })}\n\ndata: [DONE]\n\n`
      );
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const config = {
      ...defaultConfig,
      provider: {
        ...defaultConfig.provider,
        baseURL: `http://127.0.0.1:${address.port}`
      }
    };
    const provider = createDeepSeekProvider(config, "test-api-key");
    const result = await provider.complete(
      {
        model: config.provider.model,
        messages: [{ role: "user", content: "list files" }],
        tools: [
          {
            type: "function",
            function: {
              name: "list_files",
              description: "List files",
              parameters: { type: "object" }
            }
          }
        ],
        toolChoice: "auto",
        onUsage: (usage) => { usageSnapshots.push(usage.totalTokens); }
      },
      new AbortController().signal
    );

    expect(authorization).toBe("Bearer test-api-key");
    expect(requestBody).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "disabled" },
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true }
    });
    expect(result).toEqual({
      kind: "tool_calls",
      calls: [{ id: "call-1", name: "list_files", arguments: '{"path":"."}' }],
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        cachedInputTokens: 6,
        uncachedInputTokens: 5,
        reasoningTokens: 3
      }
    });
    expect(usageSnapshots).toEqual([2, 18]);
  });

  it.each([undefined, "Consider the request first."])("keeps reasoning %s separate from streamed answer text", async (reasoning) => {
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the request before responding.
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (content: string, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-stream",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-v4-flash",
          choices: [{ index: 0, finish_reason: finishReason, delta: { content, ...(content === "hello " && reasoning ? { reasoning_content: reasoning } : {}) } }]
        })}\n\n`;
      response.end(`${chunk("hello ", null)}${chunk("world", "stop")}data: [DONE]\n\n`);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");
    const provider = createDeepSeekProvider(
      {
        ...defaultConfig,
        provider: { ...defaultConfig.provider, baseURL: `http://127.0.0.1:${address.port}` }
      },
      "test-api-key"
    );
    const deltas: string[] = [];
    const result = await provider.complete(
      {
        model: defaultConfig.provider.model,
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        toolChoice: "none",
        onTextDelta: (delta) => deltas.push(delta)
      },
      new AbortController().signal
    );
    expect(deltas).toEqual(["hello ", "world"]);
    expect(result).toEqual({ kind: "message", content: "hello world", streamed: true, ...(reasoning ? { reasoning } : {}) });
  });
});
