import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../src/agent/runtime.js";
import { CjError } from "../src/shared/errors.js";
import { SearchWebTool } from "../src/tools/builtins/search-web.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ModelProvider, ModelResponse } from "../src/providers/types.js";

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

afterEach(() => vi.unstubAllGlobals());

function enabledContext(maxOutputBytes?: number) {
  return {
    workspaceRoot: process.cwd(),
    signal: new AbortController().signal,
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    webSearch: { enabled: true, resolveApiKey: vi.fn().mockResolvedValue("tvly-test-secret") }
  };
}

describe("SearchWebTool", () => {
  it("uses safe Tavily defaults and normalizes result data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      results: [{ title: "  Example  ", url: "https://example.com/a", content: " A useful\n  snippet " }]
    }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = new SearchWebTool();
    const context = enabledContext();
    const action = await tool.prepare(tool.parse({ query: "  web facts " }), context);
    const result = await tool.execute(action, context);

    expect(action.riskLevel).toBe("high");
    expect(action.effects).toEqual(["network"]);
    expect(action.targets).toEqual(["https://api.tavily.com/search"]);
    expect(fetchMock).toHaveBeenCalledWith("https://api.tavily.com/search", expect.objectContaining({
      method: "POST",
      headers: { authorization: "Bearer tvly-test-secret", "content-type": "application/json" }
    }));
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      query: "web facts", max_results: 5, search_depth: "basic", topic: "general",
      include_domains: [], exclude_domains: [], include_answer: false, include_images: false, include_raw_content: false
    });
    expect(result.data).toEqual({
      query: "web facts",
      results: [{ title: "Example", snippet: "A useful snippet", url: "https://example.com/a" }],
      truncated: false
    });
  });

  it("rejects invalid parameters and conflicting domain filters", () => {
    const tool = new SearchWebTool();
    expect(() => tool.parse({ query: "x", unknown: true })).toThrow();
    expect(() => tool.parse({ query: "x", maxResults: 11 })).toThrow();
    expect(() => tool.parse({ query: "x", includeDomains: ["Example.com"], excludeDomains: ["example.com"] })).toThrow(/both included and excluded/);
    expect(() => tool.parse({ query: "x", includeDomains: ["example.com", "EXAMPLE.COM"] })).toThrow(/unique/);
  });

  it("returns empty results and bounds large snippets", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ results: [] }))
      .mockResolvedValueOnce(response({ results: [{ title: "Example", url: "https://example.com", content: "x".repeat(20_000) }] }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = new SearchWebTool();
    const emptyContext = enabledContext();
    const empty = await tool.execute(await tool.prepare(tool.parse({ query: "none" }), emptyContext), emptyContext);
    expect(empty.data).toEqual({ query: "none", results: [], truncated: false });

    const constrainedContext = enabledContext(700);
    const bounded = await tool.execute(await tool.prepare(tool.parse({ query: "large" }), constrainedContext), constrainedContext);
    expect(bounded.data?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bounded.data))).toBeLessThanOrEqual(700);
  });

  it("fails safely when disabled, unauthenticated, unavailable, invalid, or aborted", async () => {
    const tool = new SearchWebTool();
    const disabled = { workspaceRoot: process.cwd(), signal: new AbortController().signal, webSearch: { enabled: false, resolveApiKey: vi.fn() } };
    const action = await tool.prepare(tool.parse({ query: "test" }), disabled);
    await expect(tool.execute(action, disabled)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(disabled.webSearch.resolveApiKey).not.toHaveBeenCalled();

    const missing = { ...enabledContext(), webSearch: { enabled: true, resolveApiKey: vi.fn().mockRejectedValue(new CjError("AUTH_MISSING", "No credentials")) } };
    await expect(tool.execute(action, missing)).rejects.toMatchObject({ code: "AUTH_MISSING" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: "tvly-test-secret" }, 401)));
    await expect(tool.execute(action, enabledContext())).rejects.toMatchObject({ code: "TOOL_FAILED", message: "Tavily search failed with HTTP 401" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));
    await expect(tool.execute(action, enabledContext())).rejects.toMatchObject({ code: "TOOL_FAILED", message: "Tavily returned an invalid JSON response" });

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const aborted = { ...enabledContext(), signal: controller.signal };
    await expect(tool.execute(action, aborted)).rejects.toThrow("cancelled");
  });
});

class SearchProvider implements ModelProvider {
  readonly id = "test";
  calls = 0;
  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    return this.calls === 1
      ? { kind: "tool_calls", calls: [{ id: "search", name: "search_web", arguments: '{"query":"current weather"}' }] }
      : { kind: "message", content: "done" };
  }
}

describe("search_web runtime authorization", () => {
  it("requires interactive confirmation and never fetches in non-interactive mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AgentRuntime({
      provider: new SearchProvider(), model: "test", registry: new ToolRegistry().register(new SearchWebTool()),
      workspaceRoot: process.cwd(), language: "en", maxToolCalls: 2, signal: new AbortController().signal,
      interactive: false, webSearch: { enabled: true, resolveApiKey: vi.fn().mockResolvedValue("tvly-test-secret") }
    });
    await expect(runtime.run("search")).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
