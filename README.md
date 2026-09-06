# cli-jarvis

`cj` is a local, tool-using personal AI assistant for macOS, Linux, and Windows. It accepts a natural-language task, lets an LLM select structured Tools, validates every call locally, and applies host-side risk policy before execution.

## Requirements

- Node.js 20 or newer
- A DeepSeek API Key

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
cj doctor
```

The default provider is DeepSeek `deepseek-v4-flash` in non-thinking mode. Non-secret settings and credentials are stored separately in the operating system's per-user application-data directory. Literal API Keys use an owner-only credential file; environment-variable references are also supported.

`cj doctor --offline` validates local configuration without making a model request.

## Use

```bash
cj "列出当前目录最大的五个文件"
cj "查找所有包含 TODO 的 TypeScript 文件"
cj "创建 notes.txt，写入今天的待办事项"
cj "查看当前 Git 状态"
```

Useful options:

```text
--json                  Emit versioned JSON Lines events
--verbose               Show detailed, redacted Tool results
--language zh-CN|en     Override the response language
--timeout 30s           Lower the configured task timeout
```

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
```

## Safety model

- Low-risk, read-only operations run automatically.
- Medium-risk, reversible workspace mutations are announced before execution.
- High-risk operations show a concise preview and require an explicit `y`/`n` confirmation.
- Pressing Enter rejects the operation; action IDs stay internal and are never typed by the user.
- High-risk operations fail closed without an interactive terminal.
- JSON mode is always non-interactive and can never approve a high-risk operation.
- `run_command` is always high risk and receives a minimal environment without LLM credentials.
- Paths are checked by resolved real path, so symlinks cannot silently bypass workspace authority.
- Sensitive files require explicit access, and recognized secrets are redacted by default.
- Tool-call arguments are validated as untrusted data.
- There is no `--yes`, permanent trust, automatic `sudo`, or project-local configuration.

The model is not the security boundary. Tool behavior, path checks, risk escalation, confirmation, timeouts, output limits, and audit logging are enforced by local code.

## History

```bash
cj history
cj history --json --limit 100
```

History is local JSONL metadata. It does not retain raw prompts, assistant responses, file contents, environment values, or API Keys.

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
