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
cj config list
cj config profile list
cj config profile add work --provider openai --base-url https://example.invalid/v1 --model example-model
cj config credential set-env openai OPENAI_API_KEY
cj config profile use work
cj doctor
```

The default provider is DeepSeek `deepseek-v4-flash` in non-thinking mode. Non-secret settings and credentials are stored separately in the operating system's per-user application-data directory. Literal API Keys use an owner-only credential file; environment-variable references are also supported.

`cj doctor --offline` validates local configuration without making a model request. Use `--profile <name>` for a one-off profile selection; no API key can be supplied on the command line.

## Use

```bash
cj "列出当前目录最大的五个文件"
cj "查找所有包含 TODO 的 TypeScript 文件"
cj "创建 notes.txt，写入今天的待办事项"
cj "查看当前 Git 状态"
cj --dry-run "将旧报告移动到 archive 目录"
cj chat
```

`cj chat` 在 TTY 中启动多轮会话。输入 `/clear` 清空上下文，`/status` 查看会话状态，`/tools` 查看可用工具，`/history` 查看脱敏审计历史，`/last` 查看最近任务，`/retry` 用新的 preview 和确认重新执行最近任务，`/cancel` 提示取消方式，`/exit` 退出。方向键可浏览输入历史；一次粘贴的多行内容会作为一个问题提交。`Ctrl+C` 首次取消当前模型请求或 Tool，再次退出会话。重试与原任务共享 Tool 调用上限，且绝不复用旧确认。

Useful options:

```text
--json                  Emit versioned JSON Lines events
--verbose               Show detailed, redacted Tool results
--language zh-CN|en     Override the response language
--timeout 30s           Lower the configured task timeout
--plain                 Use readable output without terminal styling
--no-color              Disable ANSI colors
--dry-run               Prepare and render Tool previews without executing them
--task-events           Include queued/planning/running/final lifecycle events
--profile NAME          Use a profile for this invocation without changing the default
```

Human-readable assistant replies are rendered for the terminal: headings, emphasis, lists, task checkboxes, blockquotes, links, fenced code blocks, and GFM tables are formatted instead of showing Markdown markers literally. JSONL mode keeps the original event payloads for automation.

`cj chat` requires an interactive TTY and rejects piped or redirected input immediately; `cj <prompt...>` remains the single-task/script-compatible mode. Streamed replies render completed Markdown blocks progressively; unfinished code fences stay buffered so terminal layout remains intact.

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
cj history --events --limit 100
cj history --json --limit 100
cj history export ./cj-audit.jsonl
cj history export ./one-task.jsonl --task 1234abcd
cj history export ./one-chat.jsonl --session 1234abcd
cj history export ./one-chat.html --session 1234abcd
cj history prune --older-than 90
```

History is local JSONL metadata. It does not retain raw prompts, assistant responses, file contents, environment values, or API Keys.
The default terminal view is one line per task; use `--events` for the underlying event stream. JSONL remains event-level for automation compatibility.
Exporting to a `.html` filename (or using `--format html`) creates a standalone, human-readable page with task summaries and collapsible redacted event details.

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

Source the relevant file from `completions/` (`cj.bash`, `cj.zsh`, `cj.fish`, or `cj.ps1`) to enable basic completion. `cj version --diagnose` shows version, platform, active profile, and protected local-store health without printing credentials.

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
