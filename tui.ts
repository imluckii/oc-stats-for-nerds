/**
 * oc-stats-for-nerds — TUI plugin
 *
 * - Live sidebar widget (collapsible) showing tok/s, tokens, TTFT, cost, model
 * - Footer stats injection via home_footer slot beside the run-duration text
 * - Toast with final stats on session.idle
 */

import { createSignal, createMemo, type JSX } from "solid-js"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { aggregateStats, formatStatsInline, fmt, type AggregatedStats } from "./server"

// ── Types ──

interface SessionData {
  id: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  model?: { id: string }
  time?: { created?: number; updated?: number }
}
interface MessageInfo {
  role: string
  modelID?: string
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number }
  time?: { created?: number; completed?: number }
}

// ── Plugin ──

const StatsTuiPlugin: TuiPlugin = async (api) => {
  const theme = api.theme.current

  // State signals
  const [collapsed, setCollapsed] = createSignal(
    Boolean(api.kv.get("oc_stats_collapsed", false)),
  )
  const [liveStats, setLiveStats] = createSignal<AggregatedStats | null>(null)
  const [finalStats, setFinalStats] = createSignal<AggregatedStats | null>(null)

  function computeFromSession(sessionId: string): AggregatedStats | null {
    const session = api.state.session.get(sessionId) as unknown as SessionData | undefined
    if (!session) return null
    const msgs = api.state.session.messages(sessionId) as unknown as MessageInfo[] | undefined
    if (!msgs || msgs.length === 0) return null
    return aggregateStats(
      msgs.map((m) => ({ info: m, parts: [] })),
      session,
    )
  }

  // Live updates on message.updated
  api.event.on("message.updated", (event) => {
    const sessionId = (event.properties as { sessionID?: string }).sessionID
    if (!sessionId) return
    const stats = computeFromSession(sessionId)
    if (stats && stats.totalOutput > 0) {
      setLiveStats(stats)
    }
  })

  // Final stats on session.idle
  api.event.on("session.idle", (event) => {
    const sessionId = (event.properties as { id?: string }).id
    if (!sessionId) return
    const stats = computeFromSession(sessionId)
    if (!stats || stats.totalOutput === 0) return
    setFinalStats(stats)
    setLiveStats(stats)
    api.ui.toast({
      message: formatStatsInline(stats),
      variant: "success",
      duration: 6000,
    })
  })

  // ── Sidebar widget (collapsible) ──

  api.slots.register({
    order: 250,
    slots: {
      sidebar_content(props: { session_id: string }) {
        return <SidebarWidget
          sessionId={props.session_id}
          collapsed={collapsed()}
          liveStats={liveStats()}
          finalStats={finalStats()}
          theme={theme}
          onToggle={() => {
            const next = !collapsed()
            setCollapsed(next)
            api.kv.set("oc_stats_collapsed", next)
          }}
          computeFromSession={computeFromSession}
        />
      },
    },
  })

  // ── Footer stats injection ──

  api.slots.register({
    order: 50,
    slots: {
      home_footer() {
        const stats = finalStats() ?? liveStats()
        if (!stats) return <box></box>
        return <FooterStats stats={stats} theme={theme} />
      },
    },
  })
}

export default { tui: StatsTuiPlugin }

// ── Components ──

function SidebarWidget(props: {
  sessionId: string
  collapsed: boolean
  liveStats: AggregatedStats | null
  finalStats: AggregatedStats | null
  theme: any
  onToggle: () => void
  computeFromSession: (id: string) => AggregatedStats | null
}): JSX.Element {
  // If collapsed, show minimal header
  if (props.collapsed) {
    return (
      <box
        flexDirection="row"
        gap={1}
        paddingBottom={1}
        paddingTop={1}
        onMouseDown={props.onToggle}
      >
        <text style={{ fg: props.theme.textMuted }}>▸</text>
        <text style={{ fg: props.theme.textMuted, fontWeight: "bold" }}>Stats</text>
        {props.liveStats && (
          <text style={{ fg: props.theme.textMuted }}>
            {props.liveStats.tps.toFixed(0)} tok/s
          </text>
        )}
      </box>
    )
  }

  // Compute stats from the session or use live/final
  const s =
    props.finalStats ??
    props.liveStats ??
    props.computeFromSession(props.sessionId)

  if (!s || s.totalOutput === 0) {
    return (
      <box
        flexDirection="column"
        paddingBottom={1}
        paddingTop={1}
      >
        <box flexDirection="row" gap={1} onMouseDown={props.onToggle}>
          <text style={{ fg: props.theme.textMuted }}>▾</text>
          <text style={{ fg: props.theme.text, fontWeight: "bold" }}>Stats</text>
        </box>
        <text style={{ fg: props.theme.textMuted }}>  waiting…</text>
      </box>
    )
  }

  const totalTokens = s.totalInput + s.totalOutput + s.totalReasoning

  return (
    <box flexDirection="column" paddingBottom={1} paddingTop={1}>
      {/* Header — click to collapse */}
      <box flexDirection="row" gap={1} onMouseDown={props.onToggle}>
        <text style={{ fg: props.theme.textMuted }}>▾</text>
        <text style={{ fg: props.theme.text, fontWeight: "bold" }}>Stats</text>
      </box>

      {/* TPS */}
      <box flexDirection="row" gap={1}>
        <text style={{ fg: props.theme.textMuted }}>⚡</text>
        <text
          style={{
            fg:
              s.tps > 50
                ? props.theme.success
                : s.tps > 20
                  ? props.theme.warning
                  : props.theme.error,
          }}
        >
          {s.tps.toFixed(1)} tok/s
        </text>
      </box>

      {/* TTFT */}
      {s.firstTokenSec !== null && (
        <box flexDirection="row" gap={1}>
          <text style={{ fg: props.theme.textMuted }}>⏱</text>
          <text style={{ fg: props.theme.textMuted }}>
            TTFT {s.firstTokenSec.toFixed(1)}s
          </text>
        </box>
      )}

      {/* Token count */}
      <box flexDirection="row" gap={1}>
        <text style={{ fg: props.theme.textMuted }}>📊</text>
        <text style={{ fg: props.theme.text }}>
          {fmt(totalTokens)} tokens
        </text>
      </box>

      {/* Token breakdown */}
      <box flexDirection="row" gap={1}>
        <text style={{ fg: props.theme.textMuted }}>  </text>
        <text style={{ fg: props.theme.textMuted }}>
          {fmt(s.totalInput)} in · {fmt(s.totalOutput)} out
        </text>
      </box>

      {/* Cache */}
      {s.cacheRead > 0 && (
        <box flexDirection="row" gap={1}>
          <text style={{ fg: props.theme.textMuted }}>  </text>
          <text style={{ fg: props.theme.textMuted }}>
            {fmt(s.cacheRead)} cached
          </text>
        </box>
      )}

      {/* Cost */}
      <box flexDirection="row" gap={1}>
        <text style={{ fg: props.theme.textMuted }}>💰</text>
        <text style={{ fg: props.theme.text }}>${s.totalCost.toFixed(4)}</text>
      </box>

      {/* Model */}
      <box flexDirection="row" gap={1}>
        <text style={{ fg: props.theme.textMuted }}>🤖</text>
        <text style={{ fg: props.theme.textMuted }}>{s.model}</text>
      </box>
    </box>
  )
}

function FooterStats(props: { stats: AggregatedStats; theme: any }): JSX.Element {
  const s = props.stats
  return (
    <box flexDirection="row" gap={1}>
      <text style={{ fg: props.theme.textMuted }}>·</text>
      <text style={{ fg: props.theme.textMuted }}>
        {s.tps.toFixed(0)} tok/s
      </text>
      {s.firstTokenSec !== null && (
        <>
          <text style={{ fg: props.theme.textMuted }}>·</text>
          <text style={{ fg: props.theme.textMuted }}>
            TTFT {s.firstTokenSec.toFixed(1)}s
          </text>
        </>
      )}
      <text style={{ fg: props.theme.textMuted }}>·</text>
      <text style={{ fg: props.theme.textMuted }}>
        {fmt(s.totalInput)} in · {fmt(s.totalOutput)} out
      </text>
      {s.cacheRead > 0 && (
        <>
          <text style={{ fg: props.theme.textMuted }}>·</text>
          <text style={{ fg: props.theme.textMuted }}>
            {fmt(s.cacheRead)} cached
          </text>
        </>
      )}
      <text style={{ fg: props.theme.textMuted }}>·</text>
      <text style={{ fg: props.theme.text }}>${s.totalCost.toFixed(4)}</text>
    </box>
  )
}
