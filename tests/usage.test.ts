import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent/events.js";
import type { ModelProvider } from "../src/providers/types.js";
import { formatUsage, TrackedModelProvider, UsageAccumulator } from "../src/providers/usage.js";

const request = {
  model: "fake-model",
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [],
  toolChoice: "none" as const
};

describe("tracked model usage", () => {
  it("uses the final cumulative snapshot once", async () => {
    const events: AgentEvent[] = [];
    const provider: ModelProvider = {
      id: "fake",
      async complete(modelRequest) {
        await modelRequest.onUsage?.({ inputTokens: 3, outputTokens: 1, totalTokens: 4, cachedInputTokens: 1, uncachedInputTokens: 2 });
        await modelRequest.onUsage?.({ inputTokens: 5, outputTokens: 2, totalTokens: 7, cachedInputTokens: 3, uncachedInputTokens: 2, reasoningTokens: 1 });
        return { kind: "message", content: "ok", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, cachedInputTokens: 3, uncachedInputTokens: 2, reasoningTokens: 1 } };
      }
    };
    const accumulator = new UsageAccumulator();
    await new TrackedModelProvider(provider, "agent", accumulator, (event) => { events.push(event); }).complete(request, new AbortController().signal);

    expect(accumulator.summary()).toEqual({
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, cachedInputTokens: 3, uncachedInputTokens: 2, reasoningTokens: 1 },
      requests: 1,
      unknownRequests: 0,
      cacheReportedRequests: 1,
      reasoningReportedRequests: 1
    });
    expect(events).toEqual([expect.objectContaining({ type: "model_usage", purpose: "agent", success: true, usage: expect.objectContaining({ totalTokens: 7, cachedInputTokens: 3, reasoningTokens: 1 }) })]);
    expect(formatUsage(accumulator.summary(), "zh-CN")).toContain("缓存命中:3 未命中:2 命中率:60.0%");
  });

  it("retains the last reported usage when a request fails and marks missing usage", async () => {
    const events: AgentEvent[] = [];
    const accumulator = new UsageAccumulator();
    const partial: ModelProvider = {
      id: "fake",
      async complete(modelRequest) {
        await modelRequest.onUsage?.({ inputTokens: 8, outputTokens: 1, totalTokens: 9 });
        throw new Error("stream failed");
      }
    };
    await expect(new TrackedModelProvider(partial, "title", accumulator, (event) => { events.push(event); }).complete(request, new AbortController().signal)).rejects.toThrow("stream failed");
    const missing: ModelProvider = { id: "fake", async complete() { throw new Error("no response"); } };
    await expect(new TrackedModelProvider(missing, "agent", accumulator, (event) => { events.push(event); }).complete(request, new AbortController().signal)).rejects.toThrow("no response");

    expect(accumulator.summary()).toEqual({
      usage: { inputTokens: 8, outputTokens: 1, totalTokens: 9 },
      requests: 2,
      unknownRequests: 1,
      cacheReportedRequests: 0,
      reasoningReportedRequests: 0
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "model_usage", success: false, usage: { inputTokens: 8, outputTokens: 1, totalTokens: 9 } }),
      expect.objectContaining({ type: "model_usage", success: false })
    ]);
  });
});
