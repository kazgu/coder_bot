# Coder Bot

Feishu (Lark) bot that bridges chat with AI coding agents — Claude Code CLI and OpenAI Codex. Spawns local agent processes, supports multi-turn conversations, and provides smart permission approval. Each Feishu chat gets its own isolated agent process, and users can switch between backends on the fly.

## Quick Start

```bash
# Install dependencies
npm install

# Configure
cp .env.example .env
# Fill in FEISHU_APP_ID and FEISHU_APP_SECRET

# Start
npx tsx --env-file=.env src/index.ts
```

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — for the Claude backend
- [Codex CLI](https://github.com/openai/codex) (`npm install -g @openai/codex`) — for the Codex backend

At least one of the two must be installed.

## Feishu Setup

1. Create an app on [Feishu Open Platform](https://open.feishu.cn)
2. Enable bot capability
3. Add permissions: `im:message`, `im:message:send_as_bot`, `im:resource` (for image downloads)
4. Publish the app

No callback URL needed — the SDK connects via WebSocket automatically.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FEISHU_APP_ID` | Yes | Feishu app ID |
| `FEISHU_APP_SECRET` | Yes | Feishu app secret |
| `DEFAULT_BACKEND` | No | Default agent backend: `claude` or `codex`, defaults to `claude` |
| `CLAUDE_PATH` | No | Path to Claude CLI, defaults to `claude` |
| `CODEX_PATH` | No | Path to Codex CLI, defaults to `codex` |
| `CODEX_MODEL` | No | Model for Codex (e.g. `o3`, `o4-mini`) |
| `CODEX_PERMISSION_MODE` | No | Permission mode for Codex, defaults to `CLAUDE_PERMISSION_MODE` |
| `CLAUDE_CWD` | No | Default working directory, defaults to cwd |
| `CLAUDE_PERMISSION_MODE` | No | Permission mode, defaults to `default` |
| `DEBUG` | No | Set to `true` to enable debug logging |

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/claude` | Switch to Claude backend |
| `/codex` | Switch to Codex backend |
| `/new` | Start a new session |
| `/new continue` | Resume the last Claude session (`--continue`) |
| `/resume` | List historical sessions and pick one to restore (Claude only) |
| `/resume <id>` | Resume a specific session by ID (Claude only) |
| `/cd <path>` | Change working directory and restart session |
| `/cwd` | Show current working directory |
| `/status` | Show current session status and backend |
| `/allow` | Approve the latest permission request |
| `/allow all` | Approve all pending requests and auto-approve the rest of this turn |
| `/deny` | Deny the latest permission request |
| `/deny all` | Deny all pending permission requests |
| `/pending` | List pending permission requests |

Send any text to chat with the active agent. You can also send images — they'll be forwarded to Claude as base64 (Codex does not support images). Each Feishu chat gets its own isolated agent process.

## Permission Handling

### Claude

The bot uses a smart auto-approval strategy:

- **Auto-approved**: Read, Glob, Grep, Task, Write, Edit, and other safe tools
- **Auto-approved (Bash)**: Non-destructive commands like `ls`, `cat`, `git status`, `npm install`
- **Interactive (AskUserQuestion)**: Questions are shown in Feishu chat; the bot waits for your reply and passes it back to Claude
- **Requires confirmation**: `rm`, `sudo`, `chmod`, `kill`, `git push --force`, `curl | sh`, code execution, and unknown tools

### Codex

Permission behavior is controlled by Codex's native `approval-policy`, which is mapped from the permission mode config. When Codex sends an `ElicitRequest` for command approval, the bot presents it in Feishu and waits for `/allow` or `/deny`.

Using `/allow all` approves all pending requests and auto-approves subsequent requests for the rest of the current turn (except `AskUserQuestion`, which always requires your input).

When a dangerous operation is detected, the bot sends a notification:

```
⚠️ Claude requests permission
Tool: Bash
Command: rm -rf node_modules

Reply /allow to approve · /deny to reject
```
