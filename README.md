# oc-stats-for-nerds

OpenCode TUI plugin that shows token usage, generation speed, and cost stats in the sidebar after each response.

## Install

```bash
opencode plugin oc-stats-for-nerds
```

Restart OpenCode. A **Token Stats** panel appears in the right sidebar.

## What it shows

```
▼ Token Stats
  Context    29.2k  (12k cached)
  Input      13,420
  Output     1,204
  Thinking   2,034
  ─────────────
  Duration   28.4s
  Speed      42.3 tok/s
  ─────────────
  Total out  8,432
  Total cost $0.03
  Turns      6
  Model      claude-sonnet-4
```

| Section | Metrics |
|---------|---------|
| **Last Response** | Context window size, input/output/thinking tokens, cache hits |
| **Performance** | Generation duration (from timestamps), tokens per second |
| **Session** | Total output tokens, total cost, turn count, model |

Click the header to collapse/expand.

## How it works

- Hooks into the `sidebar_content` TUI slot via `@opentui/solid`
- Reads token/cost data from `api.state.session.messages()`
- Computes TPS from message `time.created` / `time.completed` timestamps
- Updates after each assistant response completes (`session.idle`, `message.updated`)
- Handles multi-turn sessions, multiple models, and reasoning tokens

## Requirements

- [OpenCode](https://opencode.ai) v1.17+

## License

MIT
