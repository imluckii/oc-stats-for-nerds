/**
 * oc-stats-for-nerds — TUI plugin
 *
 * Renders a live stats sidebar widget and injects final stats
 * into the footer after the agent finishes.
 *
 * Uses OpenCode's TUI slot system (sidebar_content) with SolidJS.
 */

import { createSignal, createMemo } from "solid-js"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

const StatsTuiPlugin: TuiPlugin = async (api) => {
  const [collapsed, setCollapsed] = api.kv.get("oc_stats_collapsed", false)
  const [showCollapsed, setShowCollapsed] = createSignal(collapsed)
  const [liveStats, setLiveStats] = createSignal<string | null>(null)
  const [finalStats, setFinalStats] = createSignal<string | null>(null)

  // Listen for events to update live stats
  api.event.on("session.idle", async (event) => {
    const sessionId = (event.properties as { id?: string }).id
    if (!sessionId) return

    try {
      const sessionRes = await api.client.session.get({ path: { id: sessionId } })
      const session = sessionRes.data
      if (!session) return

      const messagesRes = await api.client.session.messages({ path: { id: sessionId } })
      const messages = messagesRes.data || []

      const stats = computeStats(messages, session)
      if (stats.totalOutput === 0) return

      setFinalStats(formatInline(stats))
      setLiveStats(formatInline(stats))

      api.ui.toast({
        message: formatInline(stats),
        variant: "info",
        duration: 5000,
      })
    } catch {}
  })

  // Update live stats on message updates
  api.event.on("message.updated", (event) => {
    const sessionId = (event.properties as { sessionID?: string }).sessionID
    if (!sessionId) return

    const session = api.state.session.get(sessionId)
    if (!session) return

    const messages = api.state.session.messages(sessionId)
    if (!messages || messages.length === 0) return

    const stats = computeStats(
      messages.map((m) => ({ info: m, parts: [] })),
      session as unknown as SessionData,
    )
    if (stats.totalOutput > 0) {
      setLiveStats(formatInline(stats))
    }
  })

  // Register sidebar slot
  api.slots.register({
    order: 250,
    slots: {
      sidebar_content(props: { session_id: string }) {
        const theme = api.theme.current

        if (showCollapsed()) {
          return (
            <box
              flexDirection="row"
              gap={1}
              paddingBottom={1}
              paddingTop={1}
              onMouseDown={() => {
                setShowCollapsed(false)
                api.kv.set("oc_stats_collapsed", false)
              }}
            >
              <text style={{ fg: theme.textMuted }}>▸</text>
              <text style={{ fg: theme.textMuted, fontWeight: "bold" }}>Stats</text>
              {liveStats() && (
                <text style={{ fg: theme.textMuted }}>
                  {liveStats()!.split(" · ")[0]}
                </text>
              )}
            </box>
          )
        }

        const stats = createMemo(() => {
          const sid = props.session_id
          const session = api.state.session.get(sid)
          if (!session) return null
          const messages = api.state.session.messages(sid)
          if (!messages || messages.length === 0) return null
          return computeStats(
            messages.map((m: any) => ({ info: m, parts: [] })),
            session as any,
          )
        })

        const s = stats()
        if (!s || s.totalOutput === 0) return <box></box>

        const tps = s.tps
        const totalTokens = s.totalInput + s.totalOutput + s.totalReasoning

        return (
          <box flexDirection="column" paddingBottom={1} paddingTop={1}>
            {/* Header */}
            <box
              flexDirection="row"
              gap={1}
              onMouseDown={() => {
                setShowCollapsed(true)
                api.kv.set("oc_stats_collapsed", true)
              }}
            >
              <text style={{ fg: theme.textMuted }}>▾</text>
              <text style={{ fg: theme.text, fontWeight: "bold" }}>Stats</text>
            </box>

            {/* TPS */}
            <box flexDirection="row" gap={1}>
              <text style={{ fg: theme.textMuted }}>⚡</text>
              <text style={{ fg: tps > 50 ? theme.success : tps > 20 ? theme.warning : theme.error }}>
                {tps.toFixed(1)} tok/s
              </text>
            </box>

            {/* TTFT */}
            {s.firstTokenSec !== null && (
              <box flexDirection="row" gap={1}>
                <text style={{ fg: theme.textMuted }}>⏱</text>
                <text style={{ fg: theme.textMuted }}>
                  TTFT {s.firstTokenSec.toFixed(1)}s
                </text>
              </box>
            )}

            {/* Tokens */}
            <box flexDirection="row" gap={1}>
              <text style={{ fg: theme.textMuted }}>📊</text>
              <text style={{ fg: theme.textMuted }}>
                {totalTokens > 1000
                  ? `${(totalTokens / 1000).toFixed(1)}k tok`
                  : `${totalTokens} tok`}
              </text>
            </box>

            {/* Token breakdown */}
            <box flexDirection="row" gap={1}>
              <text style={{ fg: theme.textMuted }}>  </text>
              <text style={{ fg: theme.textMuted }}>
                {fmt(s.totalInput)} in · {fmt(s.totalOutput)} out
              </text>
            </box>

            {s.cacheRead > 0 && (
              <box flexDirection="row" gap={1}>
                <text style={{ fg: theme.textMuted }}>  </text>
                <text style={{ fg: theme.textMuted }}>
                  {fmt(s.cacheRead)} cached
                </text>
              </box>
            )}

            {/* Cost */}
            <box flexDirection="row" gap={1}>
              <text style={{ fg: theme.textMuted }}>💰</text>
              <text style={{ fg: theme.text }}>
                ${s.totalCost.toFixed(4)}
              </text>
            </box>

            {/* Model */}
            <box flexDirection="row" gap={1}>
              <text style={{ fg: theme.textMuted }}>🤖</text>
              <text style={{ fg: theme.textMuted }}>{s.model}</text>
            </box>
          </box>
        )
      },
    },
  })
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

// ── Stats computation (same as server.ts) ──

interface TokenInfo { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
interface SessionData { id: string; cost?: number; tokens?: TokenInfo; model?: { id: string }; time?: { created?: number; updated?: number } }
interface MessageInfo { role: string; modelID?: string; cost?: number; tokens?: Partial<TokenInfo>; time?: { created?: number; completed?: number } }

function durSec(t?: { created?: number; completed?: number }): number {
  if (!t?.created || !t?.completed) return 0
  return Math.max(0, (t.completed - t.created) / 1000)
}

function computeStats(messages: { info: MessageInfo }[], session: SessionData) {
  let totalOutput = 0, totalInput = 0, totalReasoning = 0, totalCost = 0
  let totalGenSec = 0, firstTokenSec: number | null = null
  let model = "?"

  const asst = messages.filter((m) => m.info.role === "assistant")
  asst.forEach((m, i) => {
    const tk = m.info.tokens || {}
    totalOutput += tk.output || 0; totalInput += tk.input || 0
    totalReasoning += tk.reasoning || 0; totalCost += m.info.cost || 0
    const gs = durSec(m.info.time); totalGenSec += gs
    if (i === 0 && gs > 0) firstTokenSec = gs
    if (model === "?" && m.info.modelID) model = m.info.modelID
  })

  const wallSec = session.time?.created && session.time?.updated
    ? Math.max(0, (session.time.updated - session.time.created) / 1000) : 0
  const tps = totalGenSec > 0 ? totalOutput / totalGenSec : 0
  const cacheRead = session.tokens?.cache?.read || 0

  return { totalOutput, totalInput, totalReasoning, totalCost, cacheRead, totalGenSec, firstTokenSec, model, msgCount: asst.length, tps, wallSec }
}

function formatInline(s: ReturnType<typeof computeStats>): string {
  let parts: string[] = []
  parts.push(`${s.tps.toFixed(0)} tok/s`)
  if (s.firstTokenSec !== null) parts.push(`TTFT ${s.firstTokenSec.toFixed(1)}s`)
  parts.push(`${fmt(s.totalInput)} in`)
  parts.push(`${fmt(s.totalOutput)} out`)
  if (s.cacheRead) parts.push(`${fmt(s.cacheRead)} cached`)
  parts.push(`$${s.totalCost.toFixed(4)}`)
  return parts.join(" · ")
}

export default { tui: StatsTuiPlugin }
