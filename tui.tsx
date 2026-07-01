/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { createSignal, Show, onCleanup, createMemo } from "solid-js"

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
  const s = String(str)
  if (s.length >= width) return s
  return s + " ".repeat(width - s.length)
}

interface Stats {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  contextSize: number
  totalCost: number
  model: string
}

function computeStats(
  messages: SessionMessage[],
  session: SessionInfo | undefined,
): Stats | null {
  const assistants = messages.filter((m) => m.role === "assistant")
  if (assistants.length === 0) return null
  const last = assistants[assistants.length - 1]
  if (!last.tokens) return null

  const tk = last.tokens
  const contextSize =
    (tk.input || 0) + (tk.output || 0) + (tk.reasoning || 0) +
    (tk.cache?.read || 0) + (tk.cache?.write || 0)

  let totalOutput = 0
  let totalReasoning = 0
  for (const m of assistants) {
    totalOutput += m.tokens?.output || 0
    totalReasoning += m.tokens?.reasoning || 0
  }

  return {
    inputTokens: tk.input || 0,
    outputTokens: totalOutput,
    reasoningTokens: totalReasoning,
    cacheRead: tk.cache?.read || 0,
    contextSize,
    totalCost: session?.cost ?? 0,
    model: last.modelID || "unknown",
  }
}

// ── View Component ──
// IMPORTANT: SolidJS rules — component function runs ONCE.
// Signals must be read inside JSX {} for reactivity.
// Use <Show> for conditionals, never early return.

function StatsView(props: {
  api: Parameters<TuiPlugin>[0]
  sessionID: string
}) {
  const theme = () => props.api.theme.current

  const [collapsed, setCollapsed] = createSignal(false)
  const [tps, setTps] = createSignal(0)
  const [generating, setGenerating] = createSignal(false)
  const [version, setVersion] = createSignal(0)

  // TPS tracking
  let lastSampleTime = 0
  let lastSampleTokens = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function refresh() {
    const msgs = props.api.state.session.messages(props.sessionID) as unknown as SessionMessage[] || []
    const assistants = msgs.filter((m) => m.role === "assistant")
    if (!assistants.length) return

    const last = assistants[assistants.length - 1]
    const currentOutput = last.tokens?.output || 0

    // Detect new tokens being generated
    if (currentOutput > lastSampleTokens) {
      const now = Date.now()
      if (lastSampleTime > 0) {
        const dt = (now - lastSampleTime) / 1000
        const dTokens = currentOutput - lastSampleTokens
        if (dt > 0.05 && dTokens > 0) {
          const instant = dTokens / dt
          setTps((prev) => (prev === 0 ? instant : prev * 0.3 + instant * 0.7))
        }
      }
      lastSampleTime = now
      lastSampleTokens = currentOutput
      setGenerating(true)

      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => setGenerating(false), 2000)
    }

    setVersion((v) => v + 1)
  }

  // Live event subscriptions
  const stopPart = props.api.event.on("message.part.updated", (event) => {
    const sid = (event.properties as { sessionID?: string }).sessionID
    if (sid !== props.sessionID) return
    refresh()
  })

  const stopMsg = props.api.event.on("message.updated", (event) => {
    const sid = (event.properties as { sessionID?: string }).sessionID
    if (sid !== props.sessionID) return
    refresh()
  })

  const stopIdle = props.api.event.on("session.idle", (event) => {
    const sid = (event.properties as { id?: string }).id ||
                (event.properties as { sessionID?: string }).sessionID
    if (sid !== props.sessionID) return
    setGenerating(false)
    lastSampleTime = 0
    lastSampleTokens = 0
    setVersion((v) => v + 1)
  })

  // Periodic refresh — keeps TPS display live and decays when idle
  const interval = setInterval(() => {
    if (!generating()) {
      setTps((prev) => (prev > 1 ? prev * 0.85 : 0))
    }
    setVersion((v) => v + 1)
  }, 300)

  onCleanup(() => {
    stopPart()
    stopMsg()
    stopIdle()
    clearInterval(interval)
    if (idleTimer) clearTimeout(idleTimer)
  })

  // Stats memo — re-evaluates when version() changes
  const stats = createMemo<Stats | null>(() => {
    version()
    const msgs = props.api.state.session.messages(props.sessionID) as unknown as SessionMessage[] || []
    const session = props.api.state.session.get(props.sessionID) as unknown as SessionInfo | undefined
    return computeStats(msgs, session)
  })

  const toggle = () => setCollapsed((v) => !v)

  // Single return with <Show> — NO early returns
  return (
    <Show
      when={!collapsed()}
      fallback={
        <box flexDirection="column" paddingTop={1} paddingBottom={1}>
          <box
            flexDirection="row"
            gap={1}
            onMouseDown={toggle}
            onKeyDown={(e: any) => {
              if (e.name === "return" || e.name === "space") { e.preventDefault(); toggle() }
            }}
          >
            <text style={{ fg: theme().textMuted }}>{"\u25B6"}</text>
            <text style={{ fg: theme().text }}>Token Stats</text>
            <Show when={stats()}>
              {(s) => (
                <text style={{ fg: theme().textMuted }}>
                  {"  " + fmt(s().contextSize) + " ctx"}
                </text>
              )}
            </Show>
          </box>
        </box>
      }
    >
      {/* Expanded view */}
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
          <text style={{ fg: theme().textMuted }}>{"\u25BC"}</text>
          <text style={{ fg: theme().text, fontWeight: "bold" }}>Token Stats</text>
          <Show when={generating()}>
            <text style={{ fg: theme().accent }}>{" \u00B7 generating"}</text>
          </Show>
        </box>

        {/* Stats content */}
        <Show
          when={stats()}
          fallback={<text style={{ fg: theme().textMuted }}>{"  awaiting response..."}</text>}
        >
          {(s) => {
            const labelStyle = () => ({ fg: theme().textMuted })
            const valStyle = () => ({ fg: theme().text })

            return (
              <box flexDirection="column">
                {/* Context */}
                <box flexDirection="row">
                  <text style={labelStyle()}>{pad("  Context", 12)}</text>
                  <text style={valStyle()}>{fmt(s().contextSize)}</text>
                  <Show when={s().cacheRead > 0}>
                    <text style={labelStyle()}>{" (" + fmt(s().cacheRead) + " cached)"}</text>
                  </Show>
                </box>

                {/* Input */}
                <box flexDirection="row">
                  <text style={labelStyle()}>{pad("  Input", 12)}</text>
                  <text style={valStyle()}>{s().inputTokens.toLocaleString()}</text>
                </box>

                {/* Output */}
                <box flexDirection="row">
                  <text style={labelStyle()}>{pad("  Output", 12)}</text>
                  <text style={valStyle()}>{s().outputTokens.toLocaleString()}</text>
                </box>

                {/* Reasoning */}
                <Show when={s().reasoningTokens > 0}>
                  <box flexDirection="row">
                    <text style={labelStyle()}>{pad("  Reasoning", 12)}</text>
                    <text style={valStyle()}>{s().reasoningTokens.toLocaleString()}</text>
                  </box>
                </Show>

                {/* Separator */}
                <text style={labelStyle()}>{"  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"}</text>

                {/* Speed */}
                <box flexDirection="row">
                  <text style={labelStyle()}>{pad("  Speed", 12)}</text>
                  <Show
                    when={tps() > 0.5}
                    fallback={<text style={labelStyle()}>{"idle"}</text>}
                  >
                    <text
                      style={{
                        fg: tps() > 50 ? theme().success : tps() > 15 ? theme().warning : theme().textMuted,
                      }}
                    >
                      {fmtTps(tps()) + " tok/s"}
                    </text>
                  </Show>
                </box>

                {/* Cost */}
                <box flexDirection="row">
                  <text style={labelStyle()}>{pad("  Cost", 12)}</text>
                  <text style={valStyle()}>{"$" + s().totalCost.toFixed(4)}</text>
                </box>

                {/* Model */}
                <box flexDirection="row">
                  <text style={labelStyle()}>{pad("  Model", 12)}</text>
                  <text style={valStyle()}>{s().model}</text>
                </box>
              </box>
            )
          }}
        </Show>
      </box>
    </Show>
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
