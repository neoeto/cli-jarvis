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

## Agent Skills

CJ also supports standard local Agent Skills. A user-level Skill lives at `skills/<name>/SKILL.md` under CJ's configuration directory. A project can provide Skills in `.cj/skills/<name>/SKILL.md`, but CJ ignores them until you explicitly trust the exact current contents:

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

The generated script delegates candidate lookup to `cj`'s command tree, so it stays aligned with installed commands and options. It also completes configured profile names for `--profile` and registered Tool names after `cj tools show`. Candidate lookup is local and read-only; it does not call the model or execute external CLI business commands. Set `CJ_COMMAND` when the executable is not named `cj`, for example `CJ_COMMAND=/path/to/cj eval "$(/path/to/cj completion bash)"`.

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

## External CLI directories

Register existing executables or file symlinks without writing an SDK plugin:

```bash
mkdir -p "$HOME/my-cli-tools"
ln -s /absolute/path/to/my-cli "$HOME/my-cli-tools/my-cli"
cj config cli-dir add "$HOME/my-cli-tools"
cj config cli-dir list
cj tools refresh
cj tools list
cj tools doctor
```

Adding a directory authorizes bounded help probes of its executables and documentation review using the selected model. Only direct files are discovered; subdirectories and system PATH are not scanned. POSIX executable scripts/binaries and Windows native `.exe`/`.com` files are supported. Windows `.cmd`/`.bat` wrappers are reported as unsupported. Duplicate real targets are deduplicated; same-named executables at different paths receive distinct Tool names.

Before each task, chat turn, and retry, `cj` checks for additions, removals and changes. It tries `--help`, then `-h` when needed, and probes subcommands explicitly listed in command sections. Each probe has a 3-second timeout and 64 KiB combined output budget (32 KiB per stream); each CLI has at most 20 probes and a 256 KiB document budget. Help probes run with closed stdin and a minimal environment. They never execute business examples.

Local checks reject empty, version-only or unreadable help. The current profile's model then reviews whether each capability has a clear purpose, invocation syntax, required arguments, option values and a usable syntax/example. Documentation is redacted before being sent to the provider. Only approved leaf commands with supported, unambiguous parameter mappings become Tools. Unsupported or insufficiently documented capabilities remain unavailable; other capabilities can still pass.

To supplement weak help, place `my-cli.md` or `my-cli.help.txt` alongside the executable or symlink. For example:

```text
Greet a person by name.
Usage: my-cli --name NAME
--name NAME: required string; the person to greet.
Example: my-cli --name Alice
```

Use actual syntax and describe required arguments, accepted values, defaults, limitations and output. A generic shared `README.md` is not automatically attributed to every executable. Supplementary text is collected once and can document any explicitly discovered and probed child command. Repeatable/variadic arguments, conditional parameter grammars, arbitrary command passthrough and shell syntax are not supported in this first version.

```bash
cj tools refresh --force          # Recollect help and review, ignoring old decisions
cj --profile work tools refresh   # Use another configured model profile
cj tools show <generated-tool-name>
cj config cli-dir remove "$HOME/my-cli-tools"
```

`tools list`, `tools show` and `tools doctor` inspect current files and validated cached decisions without starting executables or contacting a model. Diagnostics distinguish pending, approved, partially approved, rejected, unsupported and failed candidates. Review/network errors leave the affected CLI unavailable and can be retried with `tools refresh`; they do not disable built-in Tools.

Reviews are cached in the local state directory under `external-cli-cache/`, separately from audit history. Executable contents, symlink target, companion documentation, model configuration and review-rule version determine reuse. Changes invalidate approval; dependencies outside the executable and companion files require `--force`. Long-running sessions refresh the configured directory list at each task boundary. Removing a directory or executable revokes its generated Tools at the next boundary.

Approved external Tools always require execution confirmation, use fixed executable/subcommand paths and validated argv, and inherit process cancellation, timeouts, output limits, redaction and audit logging. Documentation approval assesses callability, not business correctness or trustworthiness. Existing `run_command` behavior is unchanged.
