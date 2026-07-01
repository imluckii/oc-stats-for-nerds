# opencode-stats-for-nerds

OpenCode TUI plugin that shows token usage, generation speed, and cost stats in the sidebar after each response.

## Install

```bash
opencode plugin opencode-stats-for-nerds
```

Restart OpenCode. A **Stats for Nerds** panel appears in the right sidebar.

## What it shows

```
▼ Stats for Nerds
  Tokens       13.4k in · 1.2k out · 2.0k thinking
  Cached       3.8k read · 2.7k write
  Total        23.2k
  ────────────────
  Cost         $0.0070
  Gen Time     2m 14s
  TTFT         1.35s
  Speed        42.3 tok/s
  Model        claude-sonnet-4
```

| Stat | Scope | Description |
|------|-------|-------------|
| **Tokens** | Cumulative | Input, output, and reasoning tokens across all turns |
| **Cached** | Cumulative | Prompt cache hits (read = reused, write = newly cached) |
| **Total** | Cumulative | Sum of all token types (current context window size) |
| **Cost** | Cumulative | Total session cost at provider rates |
| **Gen Time** | Cumulative | Total time the model spent generating (sum of all response durations) |
| **TTFT** | Last response | Time-to-first-token — how long before the model started outputting |
| **Speed** | Last response | Output tokens per second for the latest response |
| **Model** | Last response | Model ID used for the latest response |

Click the header to collapse/expand.

## Configuration

Disable any stat you don't want via your `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["opencode-stats-for-nerds", {
      "show": {
        "cache": false,
        "sessionTime": false,
        "model": false
      }
    }]
  ]
}
```

All options default to `true`. Available toggles:

| Key | Default | Controls |
|-----|---------|----------|
| `tokens` | `true` | Input/output/thinking row |
| `cache` | `true` | Cache read/write row |
| `total` | `true` | Grand total token count |
| `cost` | `true` | Session cost |
| `ttft` | `true` | Time-to-first-token |
| `speed` | `true` | Tokens per second |
| `sessionTime` | `true` | Total generation time |
| `model` | `true` | Model name |

## How it works

- Hooks into the `sidebar_content` TUI slot via `@opentui/solid`
- Reads token/cost data from `api.state.session.messages()`
- TTFT computed from message creation time to first content part
- Speed computed from output tokens / generation duration
- Updates after each assistant response completes
- Handles multi-turn sessions, multiple models, and reasoning tokens

## Requirements

- [OpenCode](https://opencode.ai) v1.17+

## License

MIT
