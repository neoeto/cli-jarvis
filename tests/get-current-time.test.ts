import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import { GetCurrentTimeTool } from "../src/tools/builtins/get-current-time.js";

function context() {
  return { workspaceRoot: process.cwd(), signal: new AbortController().signal };
}

afterEach(() => vi.useRealTimers());

describe("GetCurrentTimeTool", () => {
  it("uses the host local time zone by default and returns consistent timestamps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:34:56.789Z"));
    const tool = new GetCurrentTimeTool();
    const action = await tool.prepare(tool.parse({}), context());
    const result = await tool.execute(action, context());

    expect(action).toMatchObject({ riskLevel: "low", targets: [], effects: [], reversible: true });
    expect(result.data).toMatchObject({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      utc: "2026-01-15T12:34:56.789Z",
      unixSeconds: 1_768_480_496,
      unixMilliseconds: 1_768_480_496_789
    });
    expect(result.data?.dateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  });

  it("formats an explicitly requested IANA time zone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:34:56.789Z"));
    const tool = new GetCurrentTimeTool();
    const result = await tool.execute(await tool.prepare(tool.parse({ timeZone: "Asia/Shanghai" }), context()), context());

    expect(result.data).toEqual({
      timeZone: "Asia/Shanghai",
      dateTime: "2026-01-15T20:34:56.789+08:00",
      date: "2026-01-15",
      time: "20:34:56.789",
      utc: "2026-01-15T12:34:56.789Z",
      unixSeconds: 1_768_480_496,
      unixMilliseconds: 1_768_480_496_789
    });
  });

  it("uses daylight-saving offsets for the requested zone", async () => {
    vi.useFakeTimers();
    const tool = new GetCurrentTimeTool();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    const winter = await tool.execute(await tool.prepare(tool.parse({ timeZone: "America/New_York" }), context()), context());
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    const summer = await tool.execute(await tool.prepare(tool.parse({ timeZone: "America/New_York" }), context()), context());

    expect(winter.data?.dateTime).toBe("2026-01-15T07:00:00.000-05:00");
    expect(summer.data?.dateTime).toBe("2026-07-15T08:00:00.000-04:00");
  });

  it("rejects invalid time-zone and schema inputs", () => {
    const tool = new GetCurrentTimeTool();
    expect(() => tool.parse({ timeZone: "Not/AZone" })).toThrow("Unsupported IANA time zone");
    expect(() => tool.parse({ timeZone: 8 })).toThrow();
    expect(() => tool.parse({ timeZone: "UTC", extra: true })).toThrow();
  });

  it("is registered as a low-risk capability without effects", () => {
    const tool = new GetCurrentTimeTool();
    const registry = new ToolRegistry().register(tool);
    expect(registry.get("get_current_time")).toBe(tool);
    expect(tool.defaultRisk).toBe("low");
    expect(tool.possibleEffects).toEqual([]);
    expect(tool.definition.function.parameters).toMatchObject({ type: "object", additionalProperties: false });
  });
});
