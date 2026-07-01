/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, Show, onCleanup } from "solid-js"

type PluginOptions = {
  refreshMs?: number
}

// Matches the Message shape from api.state.session.messages()
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

const id = "oc-stats-for-nerds"

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

function tpsColor(tps: number, theme: TuiThemeCurrent) {
  if (tps > 50) return theme.success
  if (tps > 20) return theme.warning
  return theme.error
}

interface StatsSnapshot {
  contextTokens: number
  totalOutput: number
  totalInput: number
  cacheRead: number
  totalCost: number
  model: string
  tps: number
  ttft: number | null
  msgCount: number
}

function computeStats(
  messages: SessionMessage[],
  session: SessionInfo | undefined,
): StatsSnapshot | null {
  const assistants = messages.filter((m) => m.role === "assistant")
  if (assistants.length === 0) return null

  const last = assistants[assistants.length - 1]
  if (!last.tokens) return null

  // Context = current context window size (same as built-in widget)
  const tk = last.tokens
  const contextTokens =
    (tk.input || 0) + (tk.output || 0) + (tk.reasoning || 0) + (tk.cache?.read || 0) + (tk.cache?.write || 0)

  // Total output across all assistant messages
  let totalOutput = 0
  let totalInput = 0
  let cacheRead = 0
  for (const m of assistants) {
    totalOutput += m.tokens?.output || 0
    totalInput += m.tokens?.input || 0
    cacheRead += m.tokens?.cache?.read || 0
  }

  // Cost from session
  const totalCost = session?.cost ?? 0

  // Model from last message
  const model = last.modelID || "?"

  // TPS: compute from session wall-clock time if available
  // The state API doesn't expose per-message timing, so use session-level time
  let genSec = 0
  const sessionCreated = session?.time?.created
  const sessionUpdated = session?.time?.updated
  if (sessionCreated && sessionUpdated) {
    genSec = Math.max(0, (sessionUpdated - sessionCreated) / 1000)
  }
  const tps = genSec > 0 ? totalOutput / genSec : 0

  return {
    contextTokens,
    totalOutput,
    totalInput,
    cacheRead,
    totalCost,
    model,
    tps,
    ttft: null,
    msgCount: assistants.length,
  }
}

function formatInline(s: StatsSnapshot): string {
  const parts: string[] = []
  parts.push(`${s.tps.toFixed(0)} tok/s`)
  if (s.ttft !== null) parts.push(`TTFT ${s.ttft.toFixed(1)}s`)
  parts.push(`${fmt(s.contextTokens)} ctx`)
  parts.push(`${fmt(s.totalOutput)} out`)
  if (s.cacheRead > 0) parts.push(`${fmt(s.cacheRead)} cached`)
  parts.push(`$${s.totalCost.toFixed(4)}`)
  return parts.join(" · ")
}

// ── Sidebar View ──

function SidebarView(props: {
  api: Parameters<TuiPlugin>[0]
  options: PluginOptions | undefined
  sessionID: string
}) {
  const [stats, setStats] = createSignal<StatsSnapshot | null>(null)
  const [collapsed, setCollapsed] = createSignal(false)
  const theme = () => props.api.theme.current

  const compute = () => {
    const session = props.api.state.session.get(props.sessionID) as unknown as SessionInfo | undefined
    const messages = props.api.state.session.messages(props.sessionID) as unknown as SessionMessage[] | undefined
    if (!messages || messages.length === 0) return
    const s = computeStats(messages, session)
    if (s) setStats(s)
  }

  // Recompute on session change
  createEffect(() => {
    props.sessionID
    compute()
  })

  // Live update on message changes
  const stopUpdated = props.api.event.on("message.updated", (event) => {
    if ((event.properties as { sessionID?: string }).sessionID !== props.sessionID) return
    compute()
  })

  // Final stats toast on idle
  const stopIdle = props.api.event.on("session.idle", (event) => {
    const sid = (event.properties as { id?: string }).id || (event.properties as { sessionID?: string }).sessionID
    if (sid !== props.sessionID) return
    compute()
    const s = stats()
    if (s) {
      props.api.ui.toast({
        message: formatInline(s),
        variant: "success",
        duration: 6000,
      })
    }
  })

  onCleanup(() => {
    stopUpdated()
    stopIdle()
  })

  const toggleCollapsed = () => setCollapsed((v) => !v)

  return (
    <box
      flexDirection="column"
      paddingBottom={1}
      paddingTop={1}
      onMouseDown={toggleCollapsed}
      onKeyDown={(event: any) => {
        if (event.name === "return" || event.name === "space") {
          event.preventDefault()
          toggleCollapsed()
        }
      }}
    >
      <box flexDirection="row" gap={1}>
        <text style={{ fg: theme().textMuted }}>
          {collapsed() ? "▶" : "▼"}
        </text>
        <text style={{ fg: theme().text, fontWeight: "bold" }}>
          Stats for Nerds
        </text>
      </box>

      <Show when={!collapsed()} fallback={<box></box>}>
        <Show
          when={stats()}
          fallback={<text style={{ fg: theme().textMuted }}>  waiting for data…</text>}
        >
          {(s) => {
            const data = s()
            return (
              <box flexDirection="column">
                {/* Context tokens (same metric as built-in) */}
                <box flexDirection="row" gap={1}>
                  <text style={{ fg: theme().textMuted }}>  📊</text>
                  <text style={{ fg: theme().text }}>
                    {fmt(data.contextTokens)} ctx tokens
                  </text>
                </box>

                {/* TPS */}
                <box flexDirection="row" gap={1}>
                  <text style={{ fg: theme().textMuted }}>  ⚡</text>
                  <text style={{ fg: tpsColor(data.tps, theme()) }}>
                    {data.tps.toFixed(1)} tok/s
                  </text>
                </box>

                {/* TTFT */}
                <Show when={data.ttft !== null}>
                  <box flexDirection="row" gap={1}>
                    <text style={{ fg: theme().textMuted }}>  ⏱</text>
                    <text style={{ fg: theme().textMuted }}>
                      TTFT {data.ttft!.toFixed(1)}s
                    </text>
                  </box>
                </Show>

                {/* Output tokens */}
                <box flexDirection="row" gap={1}>
                  <text style={{ fg: theme().textMuted }}>  📤</text>
                  <text style={{ fg: theme().textMuted }}>
                    {fmt(data.totalOutput)} generated
                  </text>
                </box>

                {/* Cache */}
                <Show when={data.cacheRead > 0}>
                  <box flexDirection="row" gap={1}>
                    <text style={{ fg: theme().textMuted }}>  📥</text>
                    <text style={{ fg: theme().textMuted }}>
                      {fmt(data.cacheRead)} cached
                    </text>
                  </box>
                </Show>

                {/* Cost */}
                <box flexDirection="row" gap={1}>
                  <text style={{ fg: theme().textMuted }}>  💰</text>
                  <text style={{ fg: theme().text }}>
                    ${data.totalCost.toFixed(4)}
                  </text>
                </box>

                {/* Model */}
                <box flexDirection="row" gap={1}>
                  <text style={{ fg: theme().textMuted }}>  🤖</text>
                  <text style={{ fg: theme().textMuted }}>{data.model}</text>
                </box>
              </box>
            )
          }}
        </Show>
      </Show>
    </box>
  )
}

// ── Plugin ──

const tui: TuiPlugin = async (api, options) => {
  api.slots.register({
    order: 200,
    slots: {
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        return (
          <SidebarView
            api={api}
            options={options as PluginOptions | undefined}
            sessionID={props.session_id}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
