import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/store.js";
import { getAppPaths } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";

const execFileAsync = promisify(execFile);
const created: string[] = [];
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
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("cj CLI end to end", () => {
  it("runs prompt -> model -> list_files -> model and writes a redacted audit", async () => {
    let requestCount = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the request before responding.
      }
      requestCount += 1;
      const delta = requestCount === 1
        ? { role: "assistant", content: "列出目录文件" }
        : requestCount === 2
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-list",
                type: "function",
                function: { name: "list_files", arguments: '{"path":".","recursive":false}' }
              }
            ]
          }
        : { role: "assistant", content: "找到 hello.txt" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: `chatcmpl-${requestCount}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-v4-flash",
          choices: [{ index: 0, finish_reason: requestCount === 2 ? "tool_calls" : "stop", delta }]
        })}\n\ndata: [DONE]\n\n`
      );
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const workspace = await mkdtemp(path.join(os.tmpdir(), "cj-e2e-workspace-"));
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "cj-e2e-config-"));
    created.push(workspace, configDirectory);
    await writeFile(path.join(workspace, "hello.txt"), "hello");
    const store = new ConfigStore(getAppPaths({ CJ_CONFIG_DIR: configDirectory }));
    await store.saveConfig({
      ...defaultConfig,
      provider: { ...defaultConfig.provider, baseURL: `http://127.0.0.1:${address.port}` }
    });
    await store.saveAuth({
      version: 1,
      providers: { deepseek: { type: "api_key", key: "e2e-secret-key" } }
    });

    const entry = path.resolve("src/cli/index.ts");
    const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const childEnvironment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      PATHEXT: process.env.PATHEXT,
      CJ_CONFIG_DIR: configDirectory,
      NO_COLOR: "1"
    };
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxImport, entry, "--json", "列出当前目录文件"],
      { cwd: workspace, env: childEnvironment, timeout: 15_000 }
    );

    expect(stderr).toBe("");
    expect(requestCount).toBe(3);
    const events = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "model_usage", "task_title", "status", "tool_start", "tool_result", "assistant_delta", "assistant", "usage_summary"
    ]));
    expect(stdout).toContain("hello.txt");
    expect(stdout).toContain("找到 hello.txt");
    const audit = await readFile(store.paths.historyFile, "utf8");
    expect(audit).not.toContain("列出当前目录文件");
    expect(audit).not.toContain("e2e-secret-key");
    expect(audit).toContain("task_finished");

    const history = await execFileAsync(
      process.execPath,
      ["--import", tsxImport, entry, "history", "--json", "--limit", "100"],
      { cwd: workspace, env: childEnvironment, timeout: 15_000 }
    );
    expect(history.stderr).toBe("");
    expect(history.stdout).not.toContain("No history");
    const historyRecords = history.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(historyRecords.some((record) => record.event === "task_finished")).toBe(true);
  });

  it("fails closed before a high-risk Tool in a non-interactive process", async () => {
    let requestCount = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the request before responding.
      }
      requestCount += 1;
      const marker = "created-by-forbidden-command.txt";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "chatcmpl-high-risk",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-v4-flash",
          choices: requestCount === 1 ? [{ index: 0, finish_reason: "stop", delta: { role: "assistant", content: "高风险命令" } }] : [
            {
              index: 0,
              finish_reason: "tool_calls",
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-command",
                    type: "function",
                    function: {
                      name: "run_command",
                      arguments: JSON.stringify({
                        command: process.execPath,
                        args: ["-e", `require('node:fs').writeFileSync('${marker}', 'bad')`]
                      })
                    }
                  }
                ]
              }
            }
          ]
        })}\n\ndata: [DONE]\n\n`
      );
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const workspace = await mkdtemp(path.join(os.tmpdir(), "cj-e2e-workspace-"));
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "cj-e2e-config-"));
    created.push(workspace, configDirectory);
    const store = new ConfigStore(getAppPaths({ CJ_CONFIG_DIR: configDirectory }));
    await store.saveConfig({
      ...defaultConfig,
      provider: { ...defaultConfig.provider, baseURL: `http://127.0.0.1:${address.port}` }
    });
    await store.saveAuth({
      version: 1,
      providers: { deepseek: { type: "api_key", key: "e2e-secret-key" } }
    });

    const entry = path.resolve("src/cli/index.ts");
    const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    let failure: (Error & { code?: number; stdout?: string; stderr?: string }) | undefined;
    try {
      await execFileAsync(
        process.execPath,
        ["--import", tsxImport, entry, "--json", "运行一个高风险命令"],
        {
          cwd: workspace,
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CJ_CONFIG_DIR: configDirectory },
          timeout: 15_000
        }
      );
    } catch (error) {
      failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    }

    expect(failure?.code).toBe(4);
    expect(failure?.stderr).toBe("");
    const output = failure?.stdout ?? "";
    expect(output).toContain('"type":"confirmation_requested"');
    expect(output).toContain('"code":"CONFIRMATION_REQUIRED"');
    await expect(readFile(path.join(workspace, "created-by-forbidden-command.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});
