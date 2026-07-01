# oc-stats-for-nerds

Shows token/speed/cost stats when an OpenCode session finishes.

## What it shows

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ 42.3 tok/sec  (1,204 out / 28.4s)
🎯 456,789 tokens  (454,585 in + 1,204 out · 340,221 cached)
⏱️  Time-to-First: 1.3s
🤖 glm-5.2 · 8 msgs · $0.0042
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

| Metric | Description |
|--------|-------------|
| tok/sec | Output tokens / generation time |
| Total tokens | Input + output + reasoning (+ cached) |
| Time-to-First | First assistant message duration (TUI plugin only) |
| Model | Model ID used |
| Cost | Dollar cost at provider rates |

## Two modes

### 1. TUI Plugin (interactive terminal)

For when you run `opencode` directly in a terminal. Auto-loads as a TS plugin.

**Install:**
```bash
cp index.ts ~/.config/opencode/plugins/oc-stats-for-nerds.ts
```

Restart OpenCode. After each response, a toast notification shows quick stats and the full block is logged.

### 2. Standalone Watcher (headless / Paseo / remote)

For when you run `opencode serve` and connect via [Paseo](https://github.com/nousresearch/paseo), the web UI, or any remote client. TS plugins don't auto-load in serve mode, so this script polls the server API instead.

**Install:**
```bash
# Clone and run
git clone https://github.com/imluckii/oc-stats-for-nerds.git
cd oc-stats-for-nerds

# One-shot: print stats for all sessions with output
node watcher.mjs --server http://localhost:4096 --once

# Watch: continuously poll for new completed sessions
node watcher.mjs --server http://localhost:4096 --interval 3
```

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--server` | `http://localhost:4096` | OpenCode server URL |
| `--interval` | `3` | Poll interval in seconds |
| `--once` | `false` | Print stats once and exit |

Works with any OpenCode server — local, remote, or Paseo-connected.

## Requirements

- [OpenCode](https://opencode.ai) (v1.17+)
- Node.js 18+ (for standalone watcher; no dependencies needed)

## License

MIT
