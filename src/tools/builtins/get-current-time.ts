import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PreparedAction, Tool, ToolContext, ToolResult } from "../types.js";

function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

const inputSchema = z.object({
  timeZone: z.string().trim().min(1).max(100)
    .refine(isSupportedTimeZone, "Unsupported IANA time zone")
    .optional()
}).strict();

type GetCurrentTimeInput = z.infer<typeof inputSchema>;

interface GetCurrentTimePayload {
  timeZone: string;
}

export interface CurrentTimeData {
  /** The effective, runtime-normalized IANA time-zone identifier. */
  timeZone: string;
  /** ISO-8601 local date-time in the effective time zone, including its UTC offset. */
  dateTime: string;
  /** Local calendar date in YYYY-MM-DD form. */
  date: string;
  /** Local clock time in HH:mm:ss.SSS form. */
  time: string;
  /** UTC ISO-8601 timestamp. */
  utc: string;
  /** Unix timestamp rounded down to whole seconds. */
  unixSeconds: number;
  /** Unix timestamp in milliseconds. */
  unixMilliseconds: number;
}

function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function effectiveTimeZone(requested: string | undefined): string {
  const timeZone = requested ?? hostTimeZone();
  return new Intl.DateTimeFormat("en-CA", { timeZone }).resolvedOptions().timeZone || "UTC";
}

function requiredPart(parts: ReadonlyMap<string, string>, name: string): string {
  const value = parts.get(name);
  if (value === undefined) throw new Error(`Current-time formatter did not return ${name}`);
  return value;
}

function normalizeOffset(timeZoneName: string): string {
  const match = /^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::?(?<minutes>\d{2}))?)?$/.exec(timeZoneName);
  if (!match?.groups) throw new Error(`Current-time formatter returned an unsupported UTC offset: ${timeZoneName}`);
  if (!match.groups.sign) return "+00:00";
  return `${match.groups.sign}${match.groups.hours!.padStart(2, "0")}:${match.groups.minutes ?? "00"}`;
}

function formatCurrentTime(now: Date, timeZone: string): CurrentTimeData {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    calendar: "iso8601",
    numberingSystem: "latn",
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
    timeZoneName: "longOffset"
  });
  const parts = new Map(
    formatter.formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const year = requiredPart(parts, "year");
  const month = requiredPart(parts, "month");
  const day = requiredPart(parts, "day");
  const hour = requiredPart(parts, "hour");
  const minute = requiredPart(parts, "minute");
  const second = requiredPart(parts, "second");
  const millisecond = requiredPart(parts, "fractionalSecond");
  const offset = normalizeOffset(requiredPart(parts, "timeZoneName"));
  const date = `${year}-${month}-${day}`;
  const time = `${hour}:${minute}:${second}.${millisecond}`;

  return {
    timeZone,
    dateTime: `${date}T${time}${offset}`,
    date,
    time,
    utc: now.toISOString(),
    unixSeconds: Math.floor(now.getTime() / 1_000),
    unixMilliseconds: now.getTime()
  };
}

export class GetCurrentTimeTool implements Tool<GetCurrentTimeInput, GetCurrentTimePayload, CurrentTimeData> {
  readonly defaultRisk = "low" as const;
  readonly possibleEffects = [] as const;
  readonly definition = {
    type: "function" as const,
    function: {
      name: "get_current_time",
      description: "Get the current date and time from the host system clock. Optionally provide an IANA time-zone identifier such as Asia/Shanghai; otherwise the host local time zone is used. Returns local ISO date-time with offset, UTC ISO time, date, time, and Unix timestamps.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          timeZone: { type: "string", minLength: 1, maxLength: 100, description: "Optional IANA time-zone identifier, for example Asia/Shanghai" }
        }
      }
    }
  };

  parse(input: unknown): GetCurrentTimeInput {
    return inputSchema.parse(input);
  }

  async prepare(input: GetCurrentTimeInput, context: ToolContext): Promise<PreparedAction<GetCurrentTimePayload>> {
    const timeZone = effectiveTimeZone(input.timeZone);
    return {
      id: randomUUID(),
      toolName: "get_current_time",
      riskLevel: "low",
      summary: context.language === "zh-CN"
        ? `获取 ${timeZone} 的当前日期和时间`
        : `Get the current date and time in ${timeZone}`,
      targets: [],
      effects: [],
      reversible: true,
      payload: { timeZone },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }

  async execute(action: PreparedAction<GetCurrentTimePayload>, context: ToolContext): Promise<ToolResult<CurrentTimeData>> {
    if (context.signal.aborted) throw context.signal.reason;
    const data = formatCurrentTime(new Date(), action.payload.timeZone);
    return {
      success: true,
      message: context.language === "zh-CN"
        ? `已获取 ${data.timeZone} 的当前日期和时间`
        : `Retrieved the current date and time in ${data.timeZone}`,
      effects: [],
      data
    };
  }
}
