# Multi-Tool Support

Strata indexes conversation history from five AI coding assistants. It auto-detects which tools you have installed and merges their histories into a single searchable database. Every search result is labeled with the source tool, so you always know where a conversation came from.

## Supported Tools

| Tool | Parser ID | Storage Format | Storage Path | Auto-Detected |
|------|-----------|---------------|--------------|---------------|
| Claude Code | `claude-code` | JSONL (one line per message) | `~/.claude/projects/<encoded-path>/<sessionId>.jsonl` | Yes |
| OpenAI Codex CLI | `codex` | JSONL (event stream) | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Yes |
| Aider | `aider` | Markdown (H4 headings) | `<project>/.aider.chat.history.md` | Yes |
| Cline | `cline` | JSON (message array) | VS Code globalStorage `saoudrizwan.claude-dev/tasks/<taskId>/` | Yes |
| Gemini CLI | `gemini-cli` | JSON (v1 checkpoint or v2 session) | `~/.gemini/tmp/<project>/chats/` | Yes |

---

## Claude Code

**Parser ID:** `claude-code`

Claude Code is the default and primary supported tool. Strata was originally built around its conversation format.

**Storage path:**
```
~/.claude/projects/<encoded-path>/<sessionId>.jsonl
```

The `<encoded-path>` is a URL-encoded representation of your project's absolute path (e.g., `/home/user/myapp` becomes a directory name under `~/.claude/projects/`). Each session is a separate `.jsonl` file where every line is a JSON object with a `type` field (`user`, `assistant`, `progress`, or `file-history-snapshot`).

**What gets indexed:**
- User messages (text content, stripped of system reminders)
- Assistant messages (text content, tool names, tool input snippets)
- Metadata: session ID, project path, working directory, git branch, timestamps

**Example search filtered by tool:**
```bash
strata search "docker compose" --tool claude-code
```

---

## OpenAI Codex CLI

**Parser ID:** `codex`

Codex CLI stores sessions in a date-partitioned directory tree using JSONL event streams.

**Storage path:**
```
~/.codex/sessions/YYYY/MM/DD/rollout-<sessionId>.jsonl
```

**Format:** Each line is a JSON event with a `type` field:
- `thread.started` -- session start (contains `thread_id`)
- `item.completed` -- completed message or action, with `item.type` being one of:
  - `userMessage` -- user text input
  - `agentMessage` -- assistant text response
  - `commandExecution` -- shell commands with exit codes and output
  - `fileChange` -- file modifications with diffs
- `turn.started` / `turn.completed` -- turn boundaries with usage stats

The working directory is extracted from `<environment_context><cwd>...</cwd></environment_context>` tags embedded in user message content.

**Example search filtered by tool:**
```bash
strata search "API rate limiting" --tool codex
```

---

## Aider

**Parser ID:** `aider`

Aider uses a markdown-based chat history format stored alongside your project files.

**Storage path:**
```
<project-root>/.aider.chat.history.md
```

Strata scans well-known development directories for these files:
- `~/` (home directory)
- `~/projects/`, `~/repos/`, `~/src/`, `~/code/`, `~/dev/`, `~/workspace/`, `~/Documents/`

Each directory is scanned one level deep for `.aider.chat.history.md` files.

**Format:** Markdown with H4 headings for user messages:
```markdown
#### fix the login form validation

The issue is in `LoginForm.tsx`. The email regex pattern
was missing the TLD check...

#### now add unit tests for it

Here are the tests using vitest...
```

User messages start with `#### `. Everything between two `#### ` lines (or between `#### ` and EOF) is the assistant response. Aider tool usage is detected from inline patterns -- `<<<<<<< SEARCH` / `>>>>>>> REPLACE` blocks indicate edits, and fenced `bash`/`shell` blocks indicate commands.

**Example search filtered by tool:**
```bash
strata search "login validation" --tool aider
```

---

## Cline

**Parser ID:** `cline`

Cline is a VS Code extension (package: `saoudrizwan.claude-dev`) that stores conversations in VS Code's global storage.

**Storage path (varies by platform):**
```
# Windows
%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/

# macOS
~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/

# Linux
~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/
```

Each task directory contains:
- `api_conversation_history.json` -- primary conversation data (array of `{role, content}` messages)
- `task_metadata.json` -- optional metadata (task name, working directory, timestamps)
- `ui_messages.json` -- UI-facing message history (not parsed by Strata)

**Format:** The `api_conversation_history.json` file is a JSON array of messages. Each message has a `role` and `content` field. Content can be a string or an array of content blocks including `text`, `tool_use` (with `name` and `input`), and `tool_result` blocks.

**Example search filtered by tool:**
```bash
strata search "component refactor" --tool cline
```

---

## Gemini CLI

**Parser ID:** `gemini-cli`

Gemini CLI stores conversations in a temporary directory. Strata supports both the legacy (v1) and current (v2, >= 0.30) formats.

**Storage path:**
```
~/.gemini/tmp/<project>/chats/checkpoint-<tag>.json   # v1 (legacy)
~/.gemini/tmp/<project>/chats/session-<tag>.json      # v2 (current)
```

**v1 format (legacy):** A JSON array of `{role, parts}` objects. Parts can include `{text}`, `{functionCall}`, and `{functionResponse}` entries. Timestamps come from `createTime` fields.

**v2 format (current, >= 0.30):** A JSON object with `{sessionId, messages}`. Each message has:
- `type`: `"user"` or `"gemini"`
- `content`: string or array of `{text}` objects
- `toolCalls`: array of `{name, args, result}` objects
- `timestamp`: ISO timestamp string

Strata auto-detects the format: if the parsed JSON is an array, it uses v1 parsing; if it is an object with a `messages` field, it uses v2 parsing.

**Example search filtered by tool:**
```bash
strata search "database migration" --tool gemini-cli
```

---

## Auto-Detection

Strata uses a **parser registry** to manage all five parsers. At startup, each registered parser's `detect()` method is called, which checks whether its data directory exists on the local filesystem:

| Parser | Detection Check |
|--------|----------------|
| Claude Code | `~/.claude/projects/` exists |
| Codex CLI | `~/.codex/sessions/` exists |
| Aider | `.aider.chat.history.md` found in any scanned directory |
| Cline | VS Code globalStorage `saoudrizwan.claude-dev/tasks/` exists |
| Gemini CLI | `~/.gemini/tmp/` exists |

Only detected parsers participate in indexing. If you install a new tool later, Strata picks it up automatically on the next index build -- no configuration change needed.

You can verify which parsers are detected:
```bash
strata status
```

Output includes a line like:
```
Parsers: Claude Code (detected), Codex CLI (not found), Aider (detected), Cline (not found), Gemini CLI (detected)
```

---

## Custom Watch Directories

The `STRATA_EXTRA_WATCH_DIRS` environment variable lets you point the file watcher at additional directories beyond the default locations. This is useful when AI tool data is stored in a non-standard path (e.g., a synced folder, a Docker volume, or a custom Claude Code installation).

**Format:** Comma-separated list of paths.

```bash
export STRATA_EXTRA_WATCH_DIRS="/mnt/shared/.claude/projects,/home/user/custom-codex/sessions"
```

Each path is trimmed and added to the watcher alongside the default directories.

---

## Mixed Tool Usage

When you use multiple AI coding tools, Strata merges all their conversation histories into a single SQLite/FTS5 index. Every indexed document carries a `tool` field identifying its source parser.

**How it works:**

1. On index build, Strata iterates all detected parsers and calls `discover()` on each to find session files.
2. Each parser's `parse()` method converts sessions into the unified `ParsedSession` format, setting the `tool` field to its parser ID (e.g., `claude-code`, `codex`, `aider`).
3. Search results include the tool label, so you can distinguish where a conversation originated.

**Filtering by tool in search:**

Use the `--tool` flag on the CLI or the inline `tool:` filter syntax in MCP tool calls:

```bash
# CLI
strata search "error handling" --tool codex

# MCP tool call (inline filter)
search_history({ query: "error handling tool:aider" })
```

**Cross-tool search:**

Omit the tool filter to search across all tools simultaneously. This is the default behavior and the most common use case -- you want to find a solution regardless of which tool you used when you wrote it.

```bash
strata search "React hydration mismatch"
```

Results from different tools are ranked together by BM25 relevance, recency, and project affinity. The source tool is shown in each result but does not affect ranking.

---

## Related Documentation

- [TOOLS.md](./TOOLS.md) -- Full reference for all MCP tools
- [USE-CASES.md](./USE-CASES.md) -- Usage modes (personal, agentic, agent development)
- [DEPLOYMENT.md](./DEPLOYMENT.md) -- Running Strata as stdio, HTTP, Docker, or Cloud Run
