/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, Show, onCleanup, createMemo } from "solid-js"

type PluginOptions = Record<string, unknown>

interface SessionMessage {
  role: string
  modelID?: string
  providerID?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  time?: { created?: number; completed?: number }
}

interface SessionInfo {
  id: string
  cost?: number
  model?: { id: string }
  time?: { created?: number; updated?: number }
}

const PLUGIN_ID = "oc-stats-for-nerds"

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}k`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

function fmtTps(tps: number): string {
  if (tps >= 100) return tps.toFixed(0)
  if (tps >= 10) return tps.toFixed(1)
  return tps.toFixed(2)
}

function pad(str: string, width: number): string {
  if (str.length >= width) return str
  return str + " ".repeat(width - str.length)
}

interface Stats {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  cacheWrite: number
  contextSize: number
  totalCost: number
  model: string
  tps: number
  generating: boolean
}

function computeStats(
  messages: SessionMessage[],
  session: SessionInfo | undefined,
  tps: number,
  generating: boolean,
): Stats | null {
  const assistants = messages.filter((m) => m.role === "assistant")
  if (assistants.length === 0) return null

  const last = assistants[assistants.length - 1]
  if (!last.tokens) return null

  const tk = last.tokens
  const contextSize =
    (tk.input || 0) + (tk.output || 0) + (tk.reasoning || 0) +
    (tk.cache?.read || 0) + (tk.cache?.write || 0)

  let outputTokens = 0
  let reasoningTokens = 0
  for (const m of assistants) {
    outputTokens += m.tokens?.output || 0
    reasoningTokens += m.tokens?.reasoning || 0
  }

  return {
    inputTokens: tk.input || 0,
    outputTokens,
    reasoningTokens,
    cacheRead: tk.cache?.read || 0,
    cacheWrite: tk.cache?.write || 0,
    contextSize,
    totalCost: session?.cost ?? 0,
    model: last.modelID || "unknown",
    tps,
    generating,
  }
}

// ── TPS Tracker ──
// Tracks real generation time by listening to message.part.updated events.
// Starts a timer on first output token, measures actual throughput.

function createTpsTracker() {
  const [tps, setTps] = createSignal(0)
  const [generating, setGenerating] = createSignal(false)

  let genStartTime: number | null = null
  let genStartTokens: number = 0
  let lastUpdateTime: number = 0
  let lastOutputTokens: number = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function onPartUpdate(outputTokens: number) {
    const now = Date.now()

    // First token of a new generation
    if (genStartTime === null || !generating()) {
      genStartTime = now
      genStartTokens = outputTokens
      lastUpdateTime = now
      lastOutputTokens = outputTokens
      setGenerating(true)
    }

    // Compute instantaneous TPS from the last sample
    const dt = (now - lastUpdateTime) / 1000
    const dTokens = outputTokens - lastOutputTokens
    if (dt > 0 && dTokens > 0) {
      const instantTps = dTokens / dt
      // Smooth: blend instantaneous with current display
      const current = tps()
      const blended = current === 0 ? instantTps : current * 0.3 + instantTps * 0.7
      setTps(blended)
    }

    lastUpdateTime = now
    lastOutputTokens = outputTokens

    // Reset idle timer — if no update for 2s, stop generating
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      setGenerating(false)
      setTps(0)
      genStartTime = null
    }, 2000)
  }

  function onSessionIdle() {
    setGenerating(false)
    // Keep last known TPS displayed (frozen final value)
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      setTps(0)
      genStartTime = null
    }, 5000)
  }

  return { tps, generating, onPartUpdate, onSessionIdle }
}

// ── View Component ──

function StatsView(props: {
  api: Parameters<TuiPlugin>[0]
  sessionID: string
}) {
  const theme = () => props.api.theme.current
  const [collapsed, setCollapsed] = createSignal(false)
  const [tick, setTick] = createSignal(0)

  const tracker = createTpsTracker()

  const messages = createMemo(() => {
    tick() // dependency for re-render
    return props.api.state.session.messages(props.sessionID) as unknown as SessionMessage[] || []
  })

  const session = createMemo(() => {
    tick()
    return props.api.state.session.get(props.sessionID) as unknown as SessionInfo | undefined
  })

  const stats = createMemo(() => {
    return computeStats(messages(), session(), tracker.tps(), tracker.generating())
  })

  // Track output tokens for TPS
  let lastOutputCount = 0

  const stopPart = props.api.event.on("message.part.updated", (event) => {
    const sid = (event.properties as { sessionID?: string }).sessionID
    if (sid !== props.sessionID) return

    // Get current output tokens
    const msgs = props.api.state.session.messages(props.sessionID) as unknown as SessionMessage[] || []
    const assistants = msgs.filter((m) => m.role === "assistant")
    if (assistants.length === 0) return
    const last = assistants[assistants.length - 1]
    const currentOutput = last.tokens?.output || 0

    if (currentOutput > lastOutputCount) {
      tracker.onPartUpdate(currentOutput)
      lastOutputCount = currentOutput
      setTick(t => t + 1)
    }
  })

  const stopMsgUpdate = props.api.event.on("message.updated", (event) => {
    if ((event.properties as { sessionID?: string }).sessionID !== props.sessionID) return
    setTick(t => t + 1)
  })

  const stopIdle = props.api.event.on("session.idle", (event) => {
    const sid = (event.properties as { id?: string }).id ||
                (event.properties as { sessionID?: string }).sessionID
    if (sid !== props.sessionID) return
    tracker.onSessionIdle()
    lastOutputCount = 0
    setTick(t => t + 1)
  })

  // Reset on session change
  createEffect(() => {
    props.sessionID
    lastOutputCount = 0
    setTick(t => t + 1)
  })

  onCleanup(() => {
    stopPart()
    stopMsgUpdate()
    stopIdle()
  })

  const toggle = () => setCollapsed(v => !v)
  const t = theme()
  const s = stats()

  if (collapsed()) {
    return (
      <box flexDirection="column" paddingTop={1} paddingBottom={1}>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={toggle}
          onKeyDown={(e: any) => {
            if (e.name === "return" || e.name === "space") { e.preventDefault(); toggle() }
          }}
        >
          <text style={{ fg: t.textMuted }}>{"\u25B6"}</text>
          <text style={{ fg: t.text }}>Token Stats</text>
          {s && (
            <text style={{ fg: t.textMuted }}>
              {"  " + fmt(s.contextSize) + " ctx"}
            </text>
          )}
        </box>
      </box>
    )
  }

  if (!s) {
    return (
      <box flexDirection="column" paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} onMouseDown={toggle}>
          <text style={{ fg: t.textMuted }}>{"\u25BC"}</text>
          <text style={{ fg: t.text }}>Token Stats</text>
        </box>
        <text style={{ fg: t.textMuted }}>{"  awaiting response..."}</text>
      </box>
    )
  }

  const muted = { fg: t.textMuted }
  const normal = { fg: t.text }
  const label = (text: string) => <text style={muted}>{pad("  " + text, 14)}</text>

  // Color for TPS: green=faster, yellow=medium, dim=slow
  const tpsColor = s.tps > 50 ? t.success : s.tps > 15 ? t.warning : t.textMuted

  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1}>
      {/* Header */}
      <box
        flexDirection="row"
        gap={1}
        onMouseDown={toggle}
        onKeyDown={(e: any) => {
          if (e.name === "return" || e.name === "space") { e.preventDefault(); toggle() }
        }}
      >
        <text style={muted}>{"\u25BC"}</text>
        <text style={{ fg: t.text, fontWeight: "bold" }}>Token Stats</text>
        {s.generating && (
          <text style={{ fg: t.accent }}>{"  \u00B7"}</text>
        )}
        {s.generating && (
          <text style={{ fg: t.accent }}>generating</text>
        )}
      </box>

      {/* Context window */}
      <box flexDirection="row">
        {label("Context")}
        <text style={normal}>{fmt(s.contextSize)}</text>
        {s.cacheRead > 0 && (
          <text style={muted}>{" (" + fmt(s.cacheRead) + " cached)"}</text>
        )}
      </box>

      {/* Token breakdown */}
      <box flexDirection="row">
        {label("Input")}
        <text style={normal}>{s.inputTokens.toLocaleString()}</text>
      </box>
      <box flexDirection="row">
        {label("Output")}
        <text style={normal}>{s.outputTokens.toLocaleString()}</text>
      </box>
      {s.reasoningTokens > 0 && (
        <box flexDirection="row">
          {label("Reasoning")}
          <text style={normal}>{s.reasoningTokens.toLocaleString()}</text>
        </box>
      )}

      {/* Separator */}
      <text style={muted}>{"  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"}</text>

      {/* Speed */}
      <box flexDirection="row">
        {label("Speed")}
        {s.generating || s.tps > 0 ? (
          <text style={{ fg: tpsColor }}>{fmtTps(s.tps) + " tok/s"}</text>
        ) : (
          <text style={muted}>{"idle"}</text>
        )}
      </box>

      {/* Cost */}
      <box flexDirection="row">
        {label("Cost")}
        <text style={normal}>{"$" + s.totalCost.toFixed(4)}</text>
      </box>

      {/* Model */}
      <box flexDirection="row">
        {label("Model")}
        <text style={normal}>{s.model}</text>
      </box>
    </box>
  )
}

// ── Plugin ──

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200,
    slots: {
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        return <StatsView api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
