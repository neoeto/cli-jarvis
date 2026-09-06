import { spawn } from "node:child_process";

export interface ProcessRunOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
  maxOutputBytes?: number;
}

export interface ProcessRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

function appendBounded(current: Buffer, chunk: Buffer, maximum: number): { value: Buffer; truncated: boolean } {
  if (current.length >= maximum) return { value: current, truncated: true };
  const remaining = maximum - current.length;
  return {
    value: Buffer.concat([current, chunk.subarray(0, remaining)]),
    truncated: chunk.length > remaining
  };
}

export function minimalProcessEnvironment(additional: Record<string, string> = {}): NodeJS.ProcessEnv {
  const common = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR", "FORCE_COLOR"];
  const platform = process.platform === "win32"
    ? ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]
    : ["TMPDIR"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...common, ...platform]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...additional };
}

export async function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  if (options.signal.aborted) throw options.signal.reason ?? new Error("Aborted");
  const maximum = options.maxOutputBytes ?? 512 * 1024;
  return new Promise<ProcessRunResult>((resolve, reject) => {
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stop = (): void => {
      if (!child.killed) {
        child.kill("SIGTERM");
        forceTimer ??= setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 1_000);
      }
    };
    const onAbort = (): void => stop();
    options.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);

    child.stdout.on("data", (raw: Buffer | string) => {
      const next = appendBounded(stdout, Buffer.isBuffer(raw) ? raw : Buffer.from(raw), maximum);
      stdout = next.value;
      truncated ||= next.truncated;
    });
    child.stderr.on("data", (raw: Buffer | string) => {
      const next = appendBounded(stderr, Buffer.isBuffer(raw) ? raw : Buffer.from(raw), maximum);
      stderr = next.value;
      truncated ||= next.truncated;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal.removeEventListener("abort", onAbort);
      if (options.signal.aborted) {
        reject(options.signal.reason ?? new Error("Aborted"));
        return;
      }
      resolve({
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        truncated
      });
    });
  });
}

export function platformShellInvocation(command: string): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return { executable: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
  }
  const configured = process.env.SHELL;
  const executable = configured && /\/(?:ba|z)?sh$/.test(configured) ? configured : "/bin/sh";
  return { executable, args: ["-c", command] };
}
