# Coder Bot

Feishu (Lark)  bot that bridges chat with Claude Code CLI. Spawns local Claude Code processes, supports multi-turn conversations, and provides smart permission approval — safe operations auto-approve while dangerous commands require explicit confirmation.

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
| `CLAUDE_PATH` | No | Path to Claude CLI, defaults to `claude` |
| `CLAUDE_CWD` | No | Default working directory, defaults to cwd |
| `CLAUDE_PERMISSION_MODE` | No | Permission mode, defaults to `default` |
| `DEBUG` | No | Set to `true` to enable debug logging |

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/new` | Start a new Claude session |
| `/new continue` | Resume the last Claude session (`--continue`) |
| `/resume` | List historical sessions and pick one to restore |
| `/resume <id>` | Resume a specific session by ID |
| `/cd <path>` | Change working directory and restart session |
| `/cwd` | Show current working directory |
| `/status` | Show current session status |
| `/allow` | Approve the latest permission request |
| `/allow all` | Approve all pending requests and auto-approve the rest of this turn |
| `/deny` | Deny the latest permission request |
| `/deny all` | Deny all pending permission requests |
| `/pending` | List pending permission requests |

Send any text to chat with Claude Code. You can also send images — they'll be forwarded to Claude as base64. Each Feishu chat gets its own isolated Claude process.

## Permission Handling

The bot uses a smart auto-approval strategy:

- **Auto-approved**: Read, Glob, Grep, Task, Write, Edit, and other safe tools
- **Auto-approved (Bash)**: Non-destructive commands like `ls`, `cat`, `git status`, `npm install`
- **Interactive (AskUserQuestion)**: Questions are shown in Feishu chat; the bot waits for your reply and passes it back to Claude
- **Requires confirmation**: `rm`, `sudo`, `chmod`, `kill`, `git push --force`, `curl | sh`, code execution, and unknown tools

Using `/allow all` approves all pending requests and auto-approves subsequent requests for the rest of the current turn (except `AskUserQuestion`, which always requires your input).

When a dangerous operation is detected, the bot sends a notification:

```
⚠️ Claude requests permission
Tool: Bash
Command: rm -rf node_modules

Reply /allow to approve · /deny to reject
```
