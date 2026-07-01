import type { Plugin } from "@opencode-ai/plugin"

/**
 * oc-stats-for-nerds — server plugin
 *
 * Event hooks that run in both TUI and headless/serve mode.
 * On session.idle, fetches final stats and logs them.
 */

const StatsServerPlugin: Plugin = async ({ client }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return

      const sessionId = (event.properties as { id?: string }).id
      if (!sessionId) return

      try {
        const sessionRes = await client.session.get({ path: { id: sessionId } })
        const session = sessionRes.data
        if (!session) return

        const messagesRes = await client.session.messages({ path: { id: sessionId } })
        const messages = messagesRes.data || []
        const stats = aggregateStats(messages as any, session as any)
        if (stats.totalOutput === 0) return

        await client.app.log({
          body: {
            service: "oc-stats-for-nerds",
            level: "info",
            message: formatStatsBlock(stats),
          },
        })
      } catch {}
    },
  }
}

export default { server: StatsServerPlugin }

// ── Shared stats logic ──

interface TokenInfo {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}
interface SessionData {
  id: string
  cost?: number
  tokens?: TokenInfo
  model?: { id: string }
  time?: { created?: number; updated?: number }
}
interface MessageInfo {
  role: string
  modelID?: string
  cost?: number
  tokens?: Partial<TokenInfo>
  time?: { created?: number; completed?: number }
}
interface SessionMessage {
  info: MessageInfo
  parts: unknown[]
}

export interface AggregatedStats {
  totalOutput: number
  totalInput: number
  totalReasoning: number
  totalCost: number
  cacheRead: number
  totalGenSec: number
  firstTokenSec: number | null
  model: string
  msgCount: number
  tps: number
  wallSec: number
}

function durSec(t?: { created?: number; completed?: number }): number {
  if (!t?.created || !t?.completed) return 0
  return Math.max(0, (t.completed - t.created) / 1000)
}

export function aggregateStats(
  messages: SessionMessage[],
  session: SessionData,
): AggregatedStats {
  let totalOutput = 0,
    totalInput = 0,
    totalReasoning = 0,
    totalCost = 0
  let totalGenSec = 0,
    firstTokenSec: number | null = null
  let model = "?"

  const asst = messages.filter((m) => m.info.role === "assistant")
  asst.forEach((m, i) => {
    const tk = m.info.tokens || {}
    totalOutput += tk.output || 0
    totalInput += tk.input || 0
    totalReasoning += tk.reasoning || 0
    totalCost += m.info.cost || 0
    const gs = durSec(m.info.time)
    totalGenSec += gs
    if (i === 0 && gs > 0) firstTokenSec = gs
    if (model === "?" && m.info.modelID) model = m.info.modelID
  })

  const wallSec =
    session.time?.created && session.time?.updated
      ? Math.max(0, (session.time.updated - session.time.created) / 1000)
      : 0
  const tps = totalGenSec > 0 ? totalOutput / totalGenSec : 0
  const cacheRead = session.tokens?.cache?.read || 0

  return {
    totalOutput,
    totalInput,
    totalReasoning,
    totalCost,
    cacheRead,
    totalGenSec,
    firstTokenSec,
    model,
    msgCount: asst.length,
    tps,
    wallSec,
  }
}

export function formatStatsBlock(s: AggregatedStats): string {
  const lines: string[] = []
  lines.push(`⚡ ${s.tps.toFixed(1)} tok/sec`)
  let t = `🎯 ${(s.totalInput + s.totalOutput + s.totalReasoning).toLocaleString()} tokens`
  t += ` (${s.totalInput.toLocaleString()} in · ${s.totalOutput.toLocaleString()} out`
  if (s.cacheRead) t += ` · ${s.cacheRead.toLocaleString()} cached`
  t += ")"
  lines.push(t)
  if (s.firstTokenSec !== null) lines.push(`⏱️ TTFT: ${s.firstTokenSec.toFixed(1)}s`)
  lines.push(`🤖 ${s.model} · $${s.totalCost.toFixed(4)}`)
  return lines.join("\n")
}

export function formatStatsInline(s: AggregatedStats): string {
  let parts: string[] = []
  parts.push(`${s.tps.toFixed(0)} tok/s`)
  if (s.firstTokenSec !== null) parts.push(`TTFT ${s.firstTokenSec.toFixed(1)}s`)
  parts.push(`${fmt(s.totalInput)} in`)
  parts.push(`${fmt(s.totalOutput)} out`)
  if (s.cacheRead) parts.push(`${fmt(s.cacheRead)} cached`)
  parts.push(`$${s.totalCost.toFixed(4)}`)
  return parts.join(" · ")
}

export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}
