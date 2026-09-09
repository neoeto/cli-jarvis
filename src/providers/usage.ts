import { randomUUID } from "node:crypto";
import type { EventSink } from "../agent/events.js";
import type { ModelProvider, ModelRequest, ModelResponse, ModelUsage } from "./types.js";

export interface UsageSummary {
  usage?: ModelUsage;
  requests: number;
  unknownRequests: number;
  cacheReportedRequests: number;
  reasoningReportedRequests: number;
}

export function hasCacheBreakdown(usage: ModelUsage): boolean {
  return usage.cachedInputTokens !== undefined || usage.uncachedInputTokens !== undefined;
}

export function addModelUsage(left: ModelUsage | undefined, right: ModelUsage): ModelUsage {
  const cachedInputTokens = left?.cachedInputTokens !== undefined || right.cachedInputTokens !== undefined
    ? (left?.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0)
    : undefined;
  const uncachedInputTokens = left?.uncachedInputTokens !== undefined || right.uncachedInputTokens !== undefined
    ? (left?.uncachedInputTokens ?? 0) + (right.uncachedInputTokens ?? 0)
    : undefined;
  const reasoningTokens = left?.reasoningTokens !== undefined || right.reasoningTokens !== undefined
    ? (left?.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0)
    : undefined;
  return {
    inputTokens: (left?.inputTokens ?? 0) + right.inputTokens,
    outputTokens: (left?.outputTokens ?? 0) + right.outputTokens,
    totalTokens: (left?.totalTokens ?? 0) + right.totalTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens })
  };
}

export function mergeUsageSummaries(left: UsageSummary, right: UsageSummary): UsageSummary {
  return {
    ...(right.usage ? { usage: addModelUsage(left.usage, right.usage) } : left.usage ? { usage: left.usage } : {}),
    requests: left.requests + right.requests,
    unknownRequests: left.unknownRequests + right.unknownRequests,
    cacheReportedRequests: left.cacheReportedRequests + right.cacheReportedRequests,
    reasoningReportedRequests: left.reasoningReportedRequests + right.reasoningReportedRequests
  };
}

export class UsageAccumulator {
  private requestCount = 0;
  private unknownCount = 0;
  private cacheReportedCount = 0;
  private reasoningReportedCount = 0;
  private usage: ModelUsage | undefined;

  add(usage: ModelUsage | undefined): void {
    this.requestCount += 1;
    if (!usage) {
      this.unknownCount += 1;
      return;
    }
    this.usage = addModelUsage(this.usage, usage);
    if (hasCacheBreakdown(usage)) this.cacheReportedCount += 1;
    if (usage.reasoningTokens !== undefined) this.reasoningReportedCount += 1;
  }

  summary(): UsageSummary {
    return {
      ...(this.usage ? { usage: this.usage } : {}),
      requests: this.requestCount,
      unknownRequests: this.unknownCount,
      cacheReportedRequests: this.cacheReportedCount,
      reasoningReportedRequests: this.reasoningReportedCount
    };
  }
}

/** Adds one audit event per model request while preserving the provider interface. */
export class TrackedModelProvider implements ModelProvider {
  readonly id: string;

  constructor(
    private readonly provider: ModelProvider,
    private readonly purpose: string,
    private readonly accumulator: UsageAccumulator,
    private readonly onEvent: EventSink
  ) {
    this.id = provider.id;
  }

  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const requestId = randomUUID();
    let finalUsage: ModelUsage | undefined;
    let success = false;
    try {
      const response = await this.provider.complete({
        ...request,
        onUsage: async (usage) => {
          finalUsage = usage;
          await request.onUsage?.(usage);
        }
      }, signal);
      finalUsage = response.usage ?? finalUsage;
      success = true;
      return response;
    } finally {
      this.accumulator.add(finalUsage);
      await this.onEvent({
        type: "model_usage",
        requestId,
        model: request.model,
        purpose: this.purpose,
        success,
        ...(finalUsage ? { usage: finalUsage } : {})
      });
    }
  }
}

export function formatUsage(summary: {
  usage?: ModelUsage;
  requests?: number;
  unknownRequests?: number;
  usageRequests?: number;
  unknownUsageRequests?: number;
  cacheReportedRequests?: number;
  reasoningReportedRequests?: number;
}, language: "zh-CN" | "en" = "en"): string {
  const requests = summary.requests ?? summary.usageRequests ?? 0;
  const unknownRequests = summary.unknownRequests ?? summary.unknownUsageRequests ?? 0;
  if (!summary.usage) {
    if (language === "zh-CN") return requests ? `token:未知（${unknownRequests}/${requests} 个请求缺失）` : "token:未知";
    return requests ? `tokens:unknown (${unknownRequests}/${requests} requests missing)` : "tokens:unknown";
  }
  const usage = summary.usage;
  const knownRequests = requests - unknownRequests;
  const cacheReported = summary.cacheReportedRequests ?? 0;
  const reasoningReported = summary.reasoningReportedRequests ?? 0;
  const cacheTotal = (usage.cachedInputTokens ?? 0) + (usage.uncachedInputTokens ?? 0);
  const cacheHitRate = usage.cachedInputTokens !== undefined && usage.uncachedInputTokens !== undefined && cacheTotal > 0
    ? `${((usage.cachedInputTokens / cacheTotal) * 100).toFixed(1)}%`
    : undefined;
  const cache = hasCacheBreakdown(usage)
    ? language === "zh-CN"
      ? ` 缓存命中:${usage.cachedInputTokens ?? "未知"} 未命中:${usage.uncachedInputTokens ?? "未知"}${cacheHitRate ? ` 命中率:${cacheHitRate}` : ""}${cacheReported < knownRequests ? `（${cacheReported}/${knownRequests} 个已知请求上报）` : ""}`
      : ` cache-hit:${usage.cachedInputTokens ?? "unknown"} cache-miss:${usage.uncachedInputTokens ?? "unknown"}${cacheHitRate ? ` hit-rate:${cacheHitRate}` : ""}${cacheReported < knownRequests ? ` (${cacheReported}/${knownRequests} known requests reported)` : ""}`
    : language === "zh-CN" ? " 缓存:未上报" : " cache:not-reported";
  const reasoning = usage.reasoningTokens === undefined
    ? language === "zh-CN" ? " 推理:未上报" : " reasoning:not-reported"
    : language === "zh-CN"
      ? ` 推理:${usage.reasoningTokens}${reasoningReported < knownRequests ? `（${reasoningReported}/${knownRequests} 个已知请求上报）` : ""}`
      : ` reasoning:${usage.reasoningTokens}${reasoningReported < knownRequests ? ` (${reasoningReported}/${knownRequests} known requests reported)` : ""}`;
  if (language === "zh-CN") {
    const suffix = unknownRequests ? `，统计不完整；${unknownRequests}/${requests} 个请求缺失` : "";
    return `token:${usage.totalTokens}（输入:${usage.inputTokens}${cache} 输出:${usage.outputTokens}${reasoning}${suffix}）`;
  }
  const suffix = unknownRequests ? `, partial; ${unknownRequests}/${requests} requests missing` : "";
  return `tokens:${usage.totalTokens} (input:${usage.inputTokens}${cache} output:${usage.outputTokens}${reasoning}${suffix})`;
}
