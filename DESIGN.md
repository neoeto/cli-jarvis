# CJ CLI Personal AI Assistant — MVP Detailed Design

Status: MVP implemented; this document remains the architecture contract  
Target runtime: Node.js + TypeScript  
Target platforms: macOS, Linux, Windows  
Default provider: DeepSeek (`deepseek-v4-flash`, non-thinking mode)

## 1. Product definition

`cj` is a local CLI agent. A user gives it a natural-language task, the model selects from registered Tools, and the local host validates and executes those Tool calls.

The model is a planner and Tool caller. It is never the security boundary. The CLI host owns validation, workspace access, confirmation, time limits, audit logging, and process execution.

### 1.1 MVP goals

- Start a task with `cj <natural-language request>`.
- Continue interactively only when clarification or approval is required.
- Support local file and developer workflows on macOS, Linux, and Windows.
- Use structured Tools before falling back to generic command execution.
- Make every material side effect visible before it occurs.
- Prevent a model response from bypassing local safety policy.
- Keep Provider and Tool implementations replaceable.

### 1.2 Non-goals

- A persistent chat UI or daemon.
- Cross-task memory.
- Third-party plugins or MCP integration.
- Browser, email, calendar, or cloud-service automation.
- Automatic privilege elevation.
- Project-local configuration.
- Telemetry or automatic crash uploads.
- A general-purpose sandbox against a fully compromised local account.

## 2. User experience

### 2.1 Command surface

```text
cj <prompt...>                 Run a single task
cj chat                        Run an interactive multi-turn session
cj config                     Configure an LLM provider interactively
cj config tui                 Open the full-screen application settings interface
cj config list                Show configuration with secrets redacted
cj tools list                 List registered Tools
cj tools show <name>          Show Tool schema, behavior, and risk metadata
cj tools register <command>   Register and immediately review one PATH executable
cj tools unregister <command> Remove one PATH executable registration
cj tools registrations        Show PATH registrations and cached review state
cj skills list                List available local Agent Skills
cj skills trust               Trust this workspace's .agents/skills content
cj skills show <name>         Show a Skill's metadata and redacted instructions
cj skills doctor              Validate Skills and workspace trust state
cj history                    Show local audit history
cj doctor                     Validate runtime, configuration, and provider access
cj --help
cj --version
```

Global options:

```text
--json                         Emit stable machine-readable events
--verbose                      Include detailed Tool inputs and outputs, still redacted
--language <zh-CN|en>          Override the configured display language
--timeout <duration>           Lower the task timeout; cannot exceed policy maximum
--plain                        Use readable output without terminal styling
--no-color                     Disable ANSI colors
```

There is deliberately no global `--yes`, permanent trust switch, or automatic `sudo` option.

### 2.1.1 PATH Tool registrations

External command support is opt-in and stores command names, never directories or arbitrary shell text. `cj tools register <command>` resolves the name using the current process PATH, collects bounded `--help`/`-h` documentation, and asks the active Profile to map documented leaf capabilities to structured Tool schemas. A registration follows PATH at each task boundary; a changed entry path, symlink target, executable, or companion documentation invalidates its cached review before it can execute.

Only POSIX executable files and Windows `.exe`/`.com` executables are supported. Shell aliases, functions, builtins, path values, command arguments, and Windows `.cmd`/`.bat` wrappers are excluded. External capabilities run a reviewed absolute executable path with fixed subcommands and validated argv. They always retain high risk, confirmation, cancellation, output limits, redaction, audit, and pre-execution fingerprint validation.

### 2.1.2 Agent Skills

Skills are local, standard `SKILL.md` instruction packages rather than executable Tool plugins. CJ discovers user Skills at `$CJ_CONFIG_DIR/skills/<name>/SKILL.md`; a workspace may supply `.agents/skills/<name>/SKILL.md` only after `cj skills trust` records a content fingerprint. A trusted workspace package overrides a same-named user package, while any package file change revokes that workspace trust until it is renewed.

The system prompt includes only each available Skill's name, description, and source. When relevant, the model calls the low-risk `read_skill` Tool to fetch the redacted `SKILL.md` or a bounded UTF-8 resource inside that same package. Package paths cannot escape their real directory or contain symbolic links. Skills cannot auto-run scripts or weaken the host's path, confirmation, timeout, output, or audit controls.

### 2.2 Output model

Human output is a stream of semantic events rather than raw model text:

```text
Understanding task…
→ search_files: Find files larger than 10 MiB under the current directory
✓ Found 7 files (183.4 MiB total)
→ trash_files: Move 7 files to the operating-system trash [confirmation required]
...
✓ Task completed
```

`--json` emits one JSON object per line with a versioned event type. Prompts and confirmations use the input language when detectable, otherwise the configured language.

Human-readable assistant messages are rendered as terminal Markdown after the complete response arrives. CommonMark/GFM headings, emphasis, lists, task checkboxes, blockquotes, links, fenced code, and tables receive terminal styling; JSONL keeps the original model text and deltas unchanged.

### 2.3 Interaction rules

- Read-only, unambiguous steps may run immediately.
- Reversible workspace mutations are announced before execution.
- High-risk operations pause for explicit confirmation.
- Ambiguous high-risk requests must be clarified rather than guessed.
- `Ctrl+C` aborts the current task and prevents new Tool calls.
- In a non-interactive terminal, any required confirmation fails closed.
- Every model turn contains one or more Tool calls. The model calls `finish_task` alone to end a task, and calls `ask_question` alone when it needs a material clarification; the host renders the latter and returns the answer to the same task. Non-interactive use fails with `INTERACTION_REQUIRED`.

## 3. System architecture

```text
User prompt
    │
    ▼
CLI / event renderer
    │
    ▼
Agent runtime ───────────────► Provider adapter ─────► DeepSeek API
    │                              │
    │ Tool call                    │ normalized messages/tool calls
    ▼                              │
Tool registry                      │
    │                              │
    ▼                              │
Policy engine ◄────────────────────┘
    │ validate / authorize / prepare / confirm
    ▼
Tool executor ─────► filesystem / processes / git
    │
    ├──────────────► audit log
    └──────────────► Tool result back to agent runtime
```

### 3.1 Trust boundaries

Untrusted inputs:

- User prompts.
- Model text and Tool-call arguments.
- File contents and command output.
- Repository instructions encountered inside the workspace.

Trusted components:

- Tool manifests shipped with `cj`.
- JSON Schema validation in the host.
- Path, environment, timeout, and confirmation enforcement in the host.
- The in-memory prepared-action store.

No prompt instruction can override host policy.

## 4. Proposed source layout

```text
src/
  cli/
    index.ts
    commands/
      run.ts
      config.ts
      tools.ts
      history.ts
      doctor.ts
    renderers/
      human.ts
      jsonl.ts
  agent/
    runtime.ts
    messages.ts
    limits.ts
    system-prompt.ts
  providers/
    types.ts
    openai-compatible.ts
    deepseek.ts
  tools/
    types.ts
    registry.ts
    builtins/
      list-files.ts
      search-files.ts
      read-file.ts
      write-file.ts
      move-files.ts
      trash-files.ts
      run-command.ts
      git.ts
  policy/
    engine.ts
    paths.ts
    confirmation.ts
    sensitive-data.ts
    environment.ts
  config/
    schema.ts
    paths.ts
    store.ts
    auth-store.ts
  audit/
    events.ts
    store.ts
  shared/
    errors.ts
    redact.ts
    abort.ts
tests/
  unit/
  integration/
  fixtures/
  live/
```

The package exposes only the `cj` executable in the MVP. Internal modules remain separable so a Tool SDK or MCP bridge can be added later without changing the Agent runtime.

## 5. Provider layer

### 5.1 Provider interface

```ts
export interface ModelProvider {
  readonly id: string;

  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

export interface ModelRequest {
  model: string;
  messages: AgentMessage[];
  tools: ModelToolDefinition[];
  toolChoice: "auto" | "none" | "required";
}

export type ModelResponse =
  | { kind: "message"; content: string; usage?: TokenUsage }
  | { kind: "tool_calls"; calls: ModelToolCall[]; content?: string; usage?: TokenUsage };
```

Provider-specific payloads are normalized at this boundary. The rest of the system does not depend on OpenAI SDK response types.

### 5.2 DeepSeek adapter

Default configuration:

```json
{
  "provider": "deepseek",
  "baseURL": "https://api.deepseek.com",
  "model": "deepseek-v4-flash",
  "thinking": false,
  "api": "chat-completions"
}
```

The adapter uses OpenAI-compatible Chat Completions and supports streaming only for user-visible assistant text. Tool-call arguments are accumulated completely before validation.

Model arguments are always parsed as untrusted JSON and validated against the registered Tool schema. Unknown Tools, unknown fields, malformed JSON, or invalid values are returned to the model as structured errors and are never executed.

### 5.3 Message handling

The per-task transcript, and the multi-turn session transcript used by `cj chat`, live only in memory. A session commits a turn's normalized messages only after that turn succeeds. They contain:

- The system policy prompt.
- The user request and clarification answers.
- Assistant messages and normalized Tool calls.
- Redacted Tool outputs needed for the next reasoning step.

It is discarded when the process exits. The audit log is separate and is never replayed as model context.

## 6. Agent runtime

### 6.1 Loop

```text
1. Build system prompt, Tool definitions, and initial user message.
2. Request the next model response with `tool_choice: required`.
3. Reject ordinary text without a Tool call with `MODEL_RESPONSE_INVALID`.
4. If it contains Tool calls:
   a. Process calls in response order.
   b. Resolve the Tool from the trusted registry.
   c. Validate arguments.
   d. Ask the Tool to prepare an action preview.
   e. Apply host policy and obtain confirmation when required.
   f. Execute the prepared action.
   g. Redact and append the Tool result.
5. On `finish_task`, render its `answer` and finish; otherwise repeat until a limit is reached.
```

Multiple Tool calls returned in one model response are deliberately executed sequentially in the MVP. This produces deterministic prompts, confirmations, and audit order.

### 6.2 Limits

- A configurable positive maximum number of executed operational Tool calls per task (default: 20); the terminal `finish_task` call does not consume this quota.
- Maximum wall time 5 minutes per task.
- Provider and Tool calls receive a shared `AbortSignal`.
- The runtime does not automatically increase either limit.
- A Tool-validation failure counts as a model turn but not as an executed Tool call.
- Repeated invalid calls are capped to prevent an infinite correction loop.

### 6.3 Clarification

The model asks a question only when a missing answer materially changes targets or side effects. It calls the low-risk `ask_question` Tool alone rather than ending ordinary text with a question. It calls the low-risk `finish_task` Tool alone to deliver the final answer. The host requests `tool_choice: required`; ordinary text without a Tool call fails closed with `MODEL_RESPONSE_INVALID`, so prose questions cannot silently terminate tasks. The host emits a first-class clarification event, presents up to eight single- or multi-select choices plus a free-text alternative, and returns the structured answer to the model as a Tool result. Answers are never written to audit history. In a non-interactive terminal this Tool emits its request event then fails closed with `INTERACTION_REQUIRED`.

## 7. Tool contract

### 7.1 Manifest and lifecycle

```ts
export type RiskLevel = "low" | "medium" | "high";

export type EffectKind =
  | "read"
  | "write"
  | "move"
  | "trash"
  | "delete"
  | "process"
  | "network"
  | "git";

export interface ToolManifest<I> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  defaultRisk: RiskLevel;
  possibleEffects: EffectKind[];
}

export interface Tool<I, P, O> {
  manifest: ToolManifest<I>;

  prepare(input: I, context: ToolContext): Promise<PreparedAction<P>>;

  execute(action: PreparedAction<P>, context: ToolContext): Promise<ToolResult<O>>;
}

export interface PreparedAction<P> {
  id: string;
  toolName: string;
  riskLevel: RiskLevel;
  summary: string;
  targets: string[];
  effects: EffectKind[];
  reversible?: boolean;
  payload: P;
  expiresAt: string;
}

export interface ToolResult<O = unknown> {
  success: boolean;
  message: string;
  effects: string[];
  data?: O;
}
```

Atomicity, rollback, partial completion, and recovery are Tool-specific. The host does not invent recovery behavior. A Tool may add optional structured details, but `success`, `message`, and the actual effect summary are mandatory.

### 7.2 Prepared actions

Prepared actions are created and retained in host memory. The confirmation UI displays only trusted fields returned by the Tool, and execution accepts only an existing, unexpired prepared-action ID.

The host never reconstructs an action from model arguments after confirmation. If a Tool detects that its targets are stale, it rejects execution and requires a new preview.

### 7.3 Risk policy

| Level | Meaning | Default handling |
|---|---|---|
| `low` | Read-only, bounded, no external side effect | Execute automatically |
| `medium` | Reversible mutation inside the authorized workspace | Announce, then execute |
| `high` | Irreversible, external, arbitrary process, or privilege-sensitive | Preview and require confirmation |

The Tool determines the operation semantics. For example, `trash_files` promises to move targets to the platform trash; a future `delete_files` Tool could promise permanent deletion. The Agent contains no special-case deletion policy.

`run_command` is always elevated to `high` by host policy because an arbitrary executable can have undeclared effects. This override cannot be weakened by the model or Tool arguments.

### 7.4 Initial built-in Tools

| Tool | Purpose | Baseline risk |
|---|---|---|
| `list_files` | List paths and metadata | Low |
| `search_files` | Search by name, size, type, or text | Low |
| `read_file` | Read text or a bounded file summary | Low, elevated for sensitive files |
| `write_file` | Create or modify files | Medium or high based on prepared effects |
| `move_files` | Move or rename files | Medium or high based on targets |
| `trash_files` | Move files to operating-system trash | Tool-declared preview required |
| `run_command` | Start a program with structured arguments or explicit shell mode | Always high |
| `git` | Inspect or mutate Git state through explicit operations | Operation-specific |
| `get_current_time` | Read the host system clock in its local or a requested IANA time zone | Low |
| `search_web` | Query a configured Tavily web-search account; returns bounded titles, snippets, and links | High; confirm every query |

Tool names and schemas remain English-only. User-facing summaries are localized.

## 8. Policy engine

### 8.1 Workspace boundary

The workspace root is the real path of the directory from which `cj` starts.

For every filesystem target:

1. Resolve it against the workspace root.
2. Resolve symlinks and existing parent paths to real paths.
3. Check containment using platform-aware path rules.
4. Treat a symlink that resolves outside the root as external access.

External reads require explicit authorization. External writes or destructive actions require a high-risk confirmation. Automatic privilege elevation is forbidden.

Windows comparisons account for drive letters, UNC paths, separator normalization, and case-insensitive filesystems. POSIX paths remain case-sensitive.

### 8.2 Confirmation

A high-risk prompt includes:

- Tool name and plain-language behavior.
- Exact executable and arguments for `run_command`, with recognized secret values redacted.
- Working directory.
- Target count and bounded target list.
- Declared side effects and reversibility.
- Environment variable names passed to a child process, never values.

The user confirms with a standard interactive `y`/`n` prompt. Enter defaults to reject, and a piped stdin, `--json` mode, or model message cannot approve it. Confirmation applies only to the prepared action currently held in memory; action IDs remain internal.

### 8.3 Non-interactive behavior

If stdin or stdout is not an interactive terminal and an action requires confirmation:

- Do not execute it.
- Emit the preview `confirmation_requested` JSON event and a stable confirmation error when `--json` is enabled.
- Exit with the dedicated confirmation-required status code.

### 8.4 Child-process environment

`run_command` builds a fresh environment from a minimal allowlist such as `PATH`, locale, terminal type, and required operating-system variables. It excludes provider keys, tokens, passwords, and `cj` credential paths.

Additional variables must be explicitly requested by the Tool, displayed by name during preview, and approved. Secret values are never rendered or logged.

### 8.5 Sensitive-data boundary

The policy engine blocks automatic model transmission of:

- `.env` and recognized credential files.
- Private keys and common authentication stores.
- Values matching common API-key, bearer-token, or password patterns.
- Credential-related environment variables.

When a task genuinely requires such content, the CLI names the source and purpose and requests confirmation. Tool outputs are redacted before model context, terminal display, and audit logging.

Sensitive detection is defense in depth, not a guarantee that arbitrary secrets will always be recognized.

## 9. Configuration and credentials

### 9.1 Platform paths

Use the operating system's per-user application-data convention:

- macOS: `~/Library/Application Support/cj/`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/cj/` for config and `${XDG_STATE_HOME:-~/.local/state}/cj/` for history
- Windows: `%APPDATA%\\cj\\`

Logical files:

```text
config.json       Non-secret settings
auth.json         Provider credentials
history.jsonl     Redacted audit events
```

There is no project-local configuration in the MVP.

### 9.2 Configuration schema

```json
{
  "version": 1,
  "provider": {
    "id": "deepseek",
    "baseURL": "https://api.deepseek.com",
    "model": "deepseek-v4-flash",
    "thinking": false
  },
  "language": "zh-CN",
  "limits": {
    "maxToolCalls": 20,
    "taskTimeoutMs": 300000
  }
}
```

Safety limits may be lowered by user configuration but not raised beyond compiled policy maximums in the MVP.

### 9.3 Credential storage

`cj config` can persist a literal API Key in `auth.json`, following the Pi/OpenCode model:

```json
{
  "version": 1,
  "providers": {
    "deepseek": {
      "type": "api_key",
      "key": "<literal secret>"
    }
  }
}
```

It may alternatively persist an environment-variable reference instead of a literal value.

Security behavior:

- Create files atomically.
- On POSIX, require owner-only `0600` permissions.
- On Windows, place the file under the per-user application-data directory, inspect its ACL, and warn or refuse use when it is broadly readable.
- Refuse to print secrets through `config list`, logs, errors, or verbose output.
- Never use a hard-coded application key for reversible obfuscation.

## 10. Audit and observability

The local JSONL audit stream records:

- Timestamp and generated task ID.
- CLI version and platform.
- Working directory.
- Provider and model.
- User request hash plus an optional short redacted summary, not raw content.
- Tool name, risk level, redacted argument summary, confirmation result, duration, and outcome.
- Exit status and normalized error code.

It does not record API Keys, environment values, file bodies, complete command output, or full model responses.

`cj history` renders these events locally. Nothing is uploaded by `cj`.

## 11. Error model and exit codes

Errors are normalized at subsystem boundaries:

```ts
type CjErrorCode =
  | "CONFIG_INVALID"
  | "AUTH_MISSING"
  | "PROVIDER_UNAVAILABLE"
  | "MODEL_RESPONSE_INVALID"
  | "TOOL_NOT_FOUND"
  | "TOOL_INPUT_INVALID"
  | "PATH_NOT_AUTHORIZED"
  | "SENSITIVE_DATA_BLOCKED"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_REJECTED"
  | "TOOL_FAILED"
  | "LIMIT_EXCEEDED"
  | "ABORTED";
```

Suggested process exit codes:

| Code | Meaning |
|---:|---|
| 0 | Task completed |
| 1 | General task or Tool failure |
| 2 | CLI usage or configuration error |
| 3 | Authentication or provider failure |
| 4 | Policy denial or confirmation required |
| 130 | User interruption |

Human output explains recovery. JSONL output includes the stable symbolic error code.

## 12. Security properties and limitations

The design guarantees that:

- Model-generated Tool names and arguments are schema-validated.
- The model cannot directly invoke an executable or filesystem API.
- Every execution passes through host policy.
- High-risk prepared actions cannot run without local interactive confirmation.
- `run_command` cannot silently inherit the LLM credential.
- Symlink traversal cannot silently expand workspace authority.
- Sensitive sources are blocked from automatic cloud transmission.

The design does not protect against:

- Malware already running as the same operating-system user.
- A malicious built-in Tool shipped by the application itself.
- Secrets that are not recognized by the sensitive-data detector.
- Side effects performed remotely by the configured LLM provider.
- Operating-system compromise or administrator access.

## 13. Testing strategy

### 13.1 Unit tests

- Tool-call JSON parsing and schema validation.
- Risk escalation and confirmation rules.
- Real-path containment, symlink escape, Windows path handling, and UNC paths.
- Redaction of keys, tokens, credentials, and environment values.
- Config migration and permission validation.
- Agent limits, abort propagation, and repeated invalid-call handling.
- Stable JSONL event and error schemas.

### 13.2 Integration tests

Use temporary workspaces and a deterministic fake Provider:

- Read-only search completes without confirmation.
- A reversible write is announced and executed.
- A high-risk action cannot execute before confirmation.
- A changed or expired prepared action is rejected.
- Non-interactive mode fails closed.
- External paths and symlink escapes require authorization.
- `run_command` is always high-risk and receives a sanitized environment.
- Tool failures are reported using Tool-provided semantics.
- `Ctrl+C` prevents subsequent Tool calls.
- Audit output contains no injected test secrets.

### 13.3 Live DeepSeek tests

Live tests are opt-in and skipped without credentials. They verify:

- Basic text completion.
- One Tool call.
- A multi-step Tool loop.
- Malformed or hallucinated argument recovery.
- Chinese and English prompts.
- Streaming text followed by a Tool call, if supported by the adapter.

Live tests must use harmless temporary-directory Tools and enforce a small token budget.

### 13.4 Cross-platform CI

Run unit and integration suites on current macOS, Ubuntu, and Windows runners. Platform-specific trash behavior is tested behind an adapter; tests never use the user's real trash or files.

## 14. MVP acceptance scenarios

The MVP is acceptable when all of the following work:

1. A fresh user can run `cj config`, save DeepSeek settings, and pass `cj doctor`.
2. `cj "列出当前目录最大的五个文件"` returns correct results without mutation.
3. A file-edit request produces a visible action event and correct output.
4. A request needing `run_command` displays the exact process and cannot run before confirmation.
5. A Tool-declared high-risk operation cannot run through piped input or `--json` mode.
6. An out-of-workspace symlink cannot bypass path authorization.
7. A fake model response with invalid Tool arguments produces no local side effect.
8. API Keys never appear in `config list`, verbose output, error output, model context fixtures, or history.
9. The same functional suite passes on macOS, Linux, and Windows.

## 15. Implementation sequence

1. Bootstrap TypeScript package, CLI parser, build, lint, and three-platform CI.
2. Implement versioned config/auth stores, redaction, and `cj config` / `cj doctor`.
3. Define Provider interface and DeepSeek Chat Completions adapter.
4. Define Tool registry, schemas, prepared actions, and fake test Tools.
5. Implement policy engine: paths, risk, confirmations, environment, and sensitive data.
6. Implement the Agent loop and semantic event renderers.
7. Add read-only filesystem Tools, then mutation Tools, then `run_command` and Git.
8. Add audit history and failure/abort handling.
9. Add live DeepSeek smoke tests and complete cross-platform acceptance testing.

The first implementation slice should be a harmless vertical path: configure DeepSeek, ask a prompt, let the model call `list_files`, validate the arguments, execute it in a temporary workspace, return the Tool result, and render the final answer. All mutation Tools should wait until that path is tested end to end.
