import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CjError } from "../../shared/errors.js";
import type { PreparedAction, Tool, ToolContext, ToolResult } from "../types.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const MAX_SNIPPET_CHARS = 2_000;

const domainSchema = z.string().trim().min(1).max(253);
const inputSchema = z.object({
  query: z.string().trim().min(1).max(800),
  maxResults: z.number().int().min(1).max(10).default(5),
  searchDepth: z.enum(["basic", "advanced"]).default("basic"),
  topic: z.enum(["general", "news"]).default("general"),
  includeDomains: z.array(domainSchema).max(20).default([]),
  excludeDomains: z.array(domainSchema).max(20).default([])
}).strict().superRefine((input, issue) => {
  const include = new Set(input.includeDomains.map((domain) => domain.toLowerCase()));
  const seenInclude = new Set<string>();
  const seenExclude = new Set<string>();
  for (const [index, domain] of input.includeDomains.entries()) {
    const normalized = domain.toLowerCase();
    if (seenInclude.has(normalized)) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["includeDomains", index], message: "Domains must be unique" });
    seenInclude.add(normalized);
  }
  for (const [index, domain] of input.excludeDomains.entries()) {
    const normalized = domain.toLowerCase();
    if (seenExclude.has(normalized)) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["excludeDomains", index], message: "Domains must be unique" });
    seenExclude.add(normalized);
    if (include.has(normalized)) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["excludeDomains", index], message: "A domain cannot be both included and excluded" });
  }
});

type SearchWebInput = z.infer<typeof inputSchema>;
type SearchWebPayload = SearchWebInput;

export interface WebSearchResult {
  title: string;
  snippet: string;
  url: string;
}

export interface SearchWebData {
  query: string;
  results: WebSearchResult[];
  truncated: boolean;
}

const tavilyResponseSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.string().url(),
    content: z.string()
  }).passthrough())
}).passthrough();

function normalizeSnippet(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > MAX_SNIPPET_CHARS ? compact.slice(0, MAX_SNIPPET_CHARS) : compact;
}

function boundData(query: string, source: WebSearchResult[], initiallyTruncated: boolean, maxBytes: number): SearchWebData {
  const results = source.map((result) => ({ ...result }));
  let returnedQuery = query;
  let truncated = initiallyTruncated;
  while (true) {
    const data = { query: returnedQuery, results, truncated };
    if (Buffer.byteLength(JSON.stringify(data)) <= maxBytes || results.length === 0) return data;
    truncated = true;
    const last = results.at(-1)!;
    if (last.snippet.length > 0) {
      last.snippet = last.snippet.slice(0, Math.floor(last.snippet.length / 2));
    } else {
      results.pop();
    }
    if (results.length === 0 && Buffer.byteLength(JSON.stringify({ query: returnedQuery, results, truncated })) > maxBytes) {
      returnedQuery = returnedQuery.slice(0, Math.floor(returnedQuery.length / 2));
    }
  }
}

export class SearchWebTool implements Tool<SearchWebInput, SearchWebPayload, SearchWebData> {
  readonly defaultRisk = "high" as const;
  readonly possibleEffects = ["network"] as const;
  readonly definition = {
    type: "function" as const,
    function: {
      name: "search_web",
      description: "Search the public web through the configured Tavily service. Sends the query and optional domain filters to Tavily; returns only result titles, snippets, and URLs. Every search requires user confirmation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 800, description: "Search query sent to Tavily" },
          maxResults: { type: "integer", minimum: 1, maximum: 10, default: 5 },
          searchDepth: { type: "string", enum: ["basic", "advanced"], default: "basic" },
          topic: { type: "string", enum: ["general", "news"], default: "general" },
          includeDomains: { type: "array", maxItems: 20, items: { type: "string", minLength: 1 }, description: "Only return results from these domains" },
          excludeDomains: { type: "array", maxItems: 20, items: { type: "string", minLength: 1 }, description: "Do not return results from these domains" }
        }
      }
    }
  };

  parse(input: unknown): SearchWebInput {
    return inputSchema.parse(input);
  }

  async prepare(input: SearchWebInput, context: ToolContext): Promise<PreparedAction<SearchWebPayload>> {
    return {
      id: randomUUID(),
      toolName: "search_web",
      riskLevel: "high",
      summary: context.language === "zh-CN"
        ? `通过 Tavily 搜索网络：${input.query}`
        : `Search the web with Tavily: ${input.query}`,
      targets: [TAVILY_SEARCH_URL],
      effects: ["network"],
      reversible: true,
      payload: input,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }

  async execute(action: PreparedAction<SearchWebPayload>, context: ToolContext): Promise<ToolResult<SearchWebData>> {
    if (!context.webSearch?.enabled) {
      throw new CjError("CONFIG_INVALID", "Web search is disabled; run cj config web-search configure to enable Tavily");
    }
    if (context.signal.aborted) throw context.signal.reason;
    const apiKey = await context.webSearch.resolveApiKey();
    let response: Response;
    try {
      response = await fetch(TAVILY_SEARCH_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          query: action.payload.query,
          max_results: action.payload.maxResults,
          search_depth: action.payload.searchDepth,
          topic: action.payload.topic,
          include_domains: action.payload.includeDomains,
          exclude_domains: action.payload.excludeDomains,
          include_answer: false,
          include_images: false,
          include_raw_content: false
        }),
        signal: context.signal
      });
    } catch (error) {
      if (context.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw context.signal.reason ?? error;
      throw new CjError("TOOL_FAILED", "Web search request to Tavily failed", { cause: error });
    }
    if (!response.ok) throw new CjError("TOOL_FAILED", `Tavily search failed with HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new CjError("TOOL_FAILED", "Tavily returned an invalid JSON response", { cause: error });
    }
    const parsed = tavilyResponseSchema.safeParse(body);
    if (!parsed.success) throw new CjError("TOOL_FAILED", "Tavily returned an invalid search response");
    const initiallyTruncated = parsed.data.results.length > action.payload.maxResults || parsed.data.results.some(
      (result) => result.content.replace(/\s+/g, " ").trim().length > MAX_SNIPPET_CHARS
    );
    const source = parsed.data.results.slice(0, action.payload.maxResults).map((result) => ({
      title: result.title.trim(),
      snippet: normalizeSnippet(result.content),
      url: result.url
    }));
    const data = boundData(action.payload.query, source, initiallyTruncated, context.maxOutputBytes ?? 512 * 1024);
    return {
      success: true,
      message: context.language === "zh-CN"
        ? `Tavily 已返回 ${data.results.length} 条网络搜索结果${data.truncated ? "（结果已截断）" : ""}`
        : `Tavily returned ${data.results.length} web search result(s)${data.truncated ? " (truncated)" : ""}`,
      effects: ["Searched the web through Tavily"],
      data
    };
  }
}
