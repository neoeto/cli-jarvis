# cli-jarvis

`cj` is a local, tool-using personal AI assistant for macOS, Linux, and Windows. It accepts a natural-language task, lets an LLM select structured Tools, validates every call locally, and applies host-side risk policy before execution.

## Requirements

- Node.js 20 or newer
- An API key for DeepSeek or another OpenAI-compatible provider

## Install for development

```bash
npm install
npm run build
npm link
```

`npm link` exposes the `cj` executable globally. You can use `npm run dev --` instead when you do not want a global link.

## Configure

```bash
cj config
cj config tui
cj config list
cj config profile list
cj config profile add work --provider openai --base-url https://example.invalid/v1 --model example-model
cj config credential set-env openai OPENAI_API_KEY
cj config profile use work
cj doctor
```

The default provider is DeepSeek `deepseek-v4-flash` in non-thinking mode. Non-secret settings and credentials are stored separately in the operating system's per-user application-data directory. Literal API Keys use an owner-only credential file; environment-variable references are also supported.

`cj doctor --offline` validates local configuration without making a model request. Use `--profile <name>` for a one-off profile selection; no API key can be supplied on the command line.

`cj config tui` opens a full-screen keyboard settings interface in an 80×24-or-larger TTY. It manages profiles, credentials, language and limits, authorization roots, registered PATH tools, local extensions, memory enablement, and existing Skills trust records. Changes stay in memory until `Ctrl+S` applies them; `q` offers to save or discard. API Keys are always masked and never prefilled.

## Use

```bash
cj "列出当前目录最大的五个文件"
cj "查找所有包含 TODO 的 TypeScript 文件"
cj "创建 notes.txt，写入今天的待办事项"
cj "查看当前 Git 状态"
cj --dry-run "将旧报告移动到 archive 目录"
cj chat
```

`cj chat` 在 TTY 中启动多轮会话。输入 `/clear` 清空上下文，`/status` 查看会话状态与累计 Token 用量，`/tools` 查看可用工具，`/history` 查看脱敏审计历史，`/last` 查看最近任务，`/retry` 用新的 preview 和确认重新执行最近任务，`/cancel` 提示取消方式，`/exit` 退出。方向键可浏览输入历史；一次粘贴的多行内容会作为一个问题提交。`Ctrl+C` 首次取消当前模型请求或 Tool，再次退出会话。重试与原任务共享 Tool 调用上限，且绝不复用旧确认。`/clear` 不会重置会话累计用量。

Useful options:

```text
--json                  Emit versioned JSON Lines events
--verbose               Show reasoning and detailed, redacted Tool results
--language zh-CN|en     Override the response language
--timeout 30s           Lower the configured task timeout
--plain                 Use readable output without terminal styling
--no-color              Disable ANSI colors
--dry-run               Prepare and render Tool previews without executing them
--task-events           Include queued/planning/running/final lifecycle events
--profile NAME          Use a profile for this invocation without changing the default
```

Human-readable assistant replies are rendered for the terminal: headings, emphasis, lists, task checkboxes, blockquotes, links, fenced code blocks, and GFM tables are formatted instead of showing Markdown markers literally. In a terminal, replies have a separate **回答 / Answer** heading and normal-brightness body. Status, decisions, and successful Tool activity are indented and dimmed on stderr; failures and confirmation requests remain prominent. Provider-supplied `reasoning_content` is shown separately only with `--verbose`. Plain/no-color output retains text labels, and redirected stdout contains only replies. JSONL mode keeps event payloads for automation, including separate `assistant_progress` and `reasoning` events.

`cj chat` requires an interactive TTY and rejects piped or redirected input immediately; `cj <prompt...>` remains the single-task/script-compatible mode. Every agent turn must contain a Tool call: the model calls `finish_task` alone to deliver its final answer, or `ask_question` alone when a material clarification is needed. This prevents a prose question from being mistaken for a completed task. Both interactive `cj "..."` and `cj chat` pause for one `ask_question`, offer single-select or multi-select options plus free text, then continue the same task with the answer. JSON, redirected, and piped invocations fail with `INTERACTION_REQUIRED` after emitting the question event; they never guess an answer. A provider that sends ordinary text without a Tool call fails closed with `MODEL_RESPONSE_INVALID`. Human output waits for each model response to finish so text accompanying Tool calls can be classified as process information instead of an answer. JSONL mode continues to emit text deltas.

## Built-in Tools

| Tool | Capability |
|---|---|
| `list_files` | List directory entries and metadata |
| `search_files` | Search by name, extension, type, size, content, or modification time |
| `read_file` | Read bounded UTF-8 text ranges with secret redaction |
| `write_file` | Explicitly create, append, or overwrite a text file |
| `move_files` | Move or rename files and directories |
| `trash_files` | Move targets to the operating-system trash/recycle bin |
| `run_command` | Run an explicitly previewed process or shell command |
| `git` | Structured status, diff, log, add, and commit operations |
| `ask_question` | Pause one task for a material user clarification, with choices and free text |
| `finish_task` | End a task and provide its complete final answer |
| `get_current_time` | Read the current date and time from the host system clock, optionally in an IANA time zone |
| `search_web` | Search the public web through a configured Tavily account |

`get_current_time` is local, low-risk, and requires no configuration or network access. It defaults to the host's local IANA time zone; pass a value such as `Asia/Shanghai` to request another supported zone. Results include a local ISO date-time with UTC offset, UTC ISO time, date, time, and Unix timestamps.

`search_web` is disabled until configured. Run `cj config web-search configure` to save a Tavily key in the owner-only credential store or reference an environment variable (normally `TAVILY_API_KEY`). Each search sends its query and any domain filters to Tavily, displays that disclosure in the confirmation prompt, and requires explicit confirmation. The tool returns only result titles, snippets, and links; it does not fetch full pages, request images, or request a Tavily-generated answer. Tavily usage may consume API credits; see the [Tavily Search API documentation](https://docs.tavily.com/documentation/api-reference/endpoint/search).

Inspect the exact schemas and risk declarations with:

```bash
cj tools list
cj tools show run_command
cj tools doctor
```

## Local Tool extensions

Extensions are disabled by default. A manifest lives at the user configuration directory under `tools/<name>/cj-tool.json`; it declares the SDK version, module, declared permissions, risk floor, effects, platforms, and data flows. Enable an installed extension explicitly, then inspect it before use:

```bash
cj config plugin enable example_tool
cj tools doctor
```

The host wraps loaded SDK Tools with manifest/effect validation, authorization roots, confirmation, bounded execution, output limits, and audit logging. As with any code placed in a user's configuration directory, a local module runs with that user's operating-system permissions; only install modules you trust.

The versioned TypeScript contract is exported as `cli-jarvis/tools-sdk` (`TOOL_SDK_VERSION` is currently `1`).

## Agent Skills

CJ also supports standard local Agent Skills. A user-level Skill lives at `skills/<name>/SKILL.md` under CJ's configuration directory. A project can provide Skills in `.agents/skills/<name>/SKILL.md`, but CJ ignores them until you explicitly trust the exact current contents:

```bash
cj skills trust
cj skills list
cj skills show release_checklist
cj skills doctor
cj skills untrust
```

`SKILL.md` must begin with YAML frontmatter containing `name` and `description`. User Skills are available automatically; a trusted workspace Skill overrides a user Skill with the same name. CJ gives the model only the name, description, and source initially. It can call the low-risk `read_skill` Tool only when a Skill is relevant, including to read package-relative UTF-8 text resources such as `references/checklist.md`.

Skill packages cannot use symbolic links or escape their own directory. CJ redacts recognized secrets, applies output limits, and rejects a workspace Skill as soon as any package file changes until it is trusted again. A Skill is guidance, not a privileged plugin: it cannot override user requests or host policy, automatically execute scripts, bypass path authorization, or approve a high-risk Tool call.

## Safety model

- Low-risk, read-only operations run automatically.
- Medium-risk, reversible workspace mutations are announced before execution.
- High-risk operations show a concise preview and require an explicit `y`/`n` confirmation.
- Pressing Enter rejects the operation; action IDs stay internal and are never typed by the user.
- High-risk operations fail closed without an interactive terminal.
- JSON mode is always non-interactive and can never approve a high-risk operation.
- `run_command` is always high risk and receives a minimal environment without LLM credentials.
- Paths are checked by resolved real path, so symlinks cannot silently bypass workspace authority. `cj config roots <relative-dir...>` can narrow access, never expand it beyond the current workspace.
- Sensitive files require explicit access, and recognized secrets are redacted by default.
- Tool-call arguments are validated as untrusted data.
- There is no `--yes`, permanent trust, automatic `sudo`, or project-local configuration.

The model is not the security boundary. Tool behavior, path checks, risk escalation, confirmation, timeouts, output limits, and audit logging are enforced by local code.

## Preview, recovery, history, and memory

`--dry-run` prepares each action and sends a result to the model without calling a Tool's executor. A real follow-up run prepares the action again, so stale targets cannot be approved from a preview. Tools can return an explicit recovery hint, but `cj` never claims rollback happened unless a Tool actually did it.

```bash
cj history
cj history --verbose
cj history --tasks
cj history --session 1234abcd
cj history --events --limit 100
cj history --json --limit 100
cj history export ./cj-audit.jsonl
cj history export ./one-task.jsonl --task 1234abcd
cj history export ./one-chat.jsonl --session 1234abcd
cj history export ./one-chat.html --session 1234abcd
cj history prune --older-than 90
```

History is local JSONL metadata. It stores a short, redacted task title and provider-reported Token usage, but does not retain raw prompts, assistant responses, file contents, environment values, or API Keys. Creating the title makes one additional model request per task; failures fall back to a redacted prompt excerpt and do not block the task.
The default terminal view combines all turns of a chat session into one line while keeping standalone tasks separate. Use `--verbose` to include Token usage statistics, `--tasks` for every task/turn, `--session` for one chat's turns, or `--events` for the underlying event stream. JSONL remains event-level for automation compatibility.
With `--verbose`, Token totals include title generation, agent requests, and any uncached external CLI review requests. The display breaks input into cache-hit and cache-miss tokens when the provider reports that detail, shows the cache hit rate, and reports reasoning tokens as a subset of output tokens. Input equals cache-hit plus cache-miss for DeepSeek; reasoning is already included in output and is never added to the total again. Missing provider usage or breakdown fields are reported as unknown or partial rather than zero, and SDK/provider retries that are not surfaced separately may not be measurable.
Exporting to a `.html` filename (or using `--format html`) creates a standalone, human-readable page with chat and task summaries, Token usage, and collapsible redacted event details.

Long-term memory is off by default and separate from audit history. Only facts you explicitly add are stored; file contents, model output, command output, and credentials are never added automatically.

```bash
cj memory on
cj memory add "I prefer concise Chinese replies."
cj memory list
cj memory forget <id>
cj memory off
```

When enabled and relevant, the task emits the memory IDs and purpose used. The memory file is owner-only on POSIX platforms.

## Shell completion and diagnostics

Generate a completion script for the shell you use:

```bash
# Bash
eval "$(cj completion bash)"

# Zsh
eval "$(cj completion zsh)"

# Fish
cj completion fish | source
```

PowerShell:

```powershell
cj completion powershell | Out-String | Invoke-Expression
```

The generated script delegates candidate lookup to `cj`'s command tree, so it stays aligned with installed commands and options. It also completes configured profile names for `--profile`, registered Tool names after `cj tools show`, and PATH registration names after `cj tools unregister`. Candidate lookup is local and read-only; it does not call the model or execute external CLI business commands. Set `CJ_COMMAND` when the executable is not named `cj`, for example `CJ_COMMAND=/path/to/cj eval "$(/path/to/cj completion bash)"`.

The matching checked-in files are available under `completions/` for shell startup configuration. `cj version --diagnose` shows version, platform, active profile, and protected local-store health without printing credentials.

## Development

```bash
npm run typecheck
npm test
npm run build
```

The default suite uses deterministic fake model responses and local fake HTTP endpoints. A real DeepSeek smoke test is opt-in:

```bash
DEEPSEEK_API_KEY=... npm run test:live
```

PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = "..."
npm run test:live
```

See [DESIGN.md](./DESIGN.md) for the detailed architecture and accepted product decisions.

See [ROADMAP.md](./ROADMAP.md) for post-MVP feature planning, with improved interactive experience as the first milestone.

## PATH 工具注册

注册当前终端 PATH 中已有的可执行命令，无需编写 SDK 插件：

```bash
cj tools register kubectl
cj tools registrations
cj tools list
cj tools list --page 2 --page-size 20
cj tools doctor
cj tools unregister kubectl
```

`register` 仅接受一个命令名，不能传路径、固定参数、Shell alias、函数或内建命令。它会立刻按当前 PATH 顺序解析命令、采集帮助文档并用当前 Profile 审核能力。POSIX 支持有执行权限的脚本与二进制；Windows 支持 `.exe` 和 `.com`，不支持 `.cmd` 或 `.bat` 包装脚本。注册失败前不会写入配置；文档或模型审核失败时会保留注册，以便通过 `cj tools doctor` 检查并在之后重试。

每个任务、聊天回合、重试和 `cj tools refresh` 都会重新解析 PATH。路径顺序、符号链接目标、可执行文件或伴随文档变化都会使旧审核失效；命令暂时不在 PATH 中会显示为 `missing`，恢复后自动重新审核。生成后的 Tool 名以注册命令和子命令为身份，因此命令升级或 PATH 位置改变后保持稳定。

CJ 依次尝试 `--help` 和 `-h`，并只探测用法中明确列出的子命令。单次探测最多 3 秒和 64 KiB 输出，每个 CLI 最多 20 次探测和 256 KiB 文档。帮助在最小环境、关闭 stdin 的进程中读取，绝不运行业务示例。当前 Profile 的模型只审核经过本地检查和脱敏后的文档；只有参数映射清晰的叶子命令会成为 Tool。

若帮助较弱，可在当前 PATH 解析到的入口旁放置 `<command>.md` 或 `<command>.help.txt`。文档应写明实际调用语法、必填参数、值域、默认行为和限制。重复或可变参数、条件语法、任意参数透传与 Shell 语法在当前版本不支持。

```bash
cj tools refresh --force          # 重新采集并审核全部已注册命令
cj --profile work tools refresh   # 使用另一个 Profile 审核
cj tools show <generated-tool-name>
```

`tools list` 以表格展示能力，默认每页 20 项；可通过 `--page` 和 `--page-size`（1 到 100）查看指定页，表格底部会显示页码、总数和每页数量。`tools list`、`tools show`、`tools registrations` 和 `tools doctor` 只读取当前 PATH 与缓存，不会启动外部 CLI 或调用模型。审核缓存位于本地状态目录的 `external-cli-cache/`，与审计历史分离。所有批准后的外部 Tool 固定可执行文件和子命令路径、验证 argv，并继承确认、取消、超时、输出限制、脱敏和审计；每一次执行仍需要交互确认。
