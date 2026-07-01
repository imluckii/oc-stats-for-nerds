import type { Plugin } from "@opencode-ai/plugin"

/**
 * oc-stats-for-nerds
 *
 * OpenCode plugin that shows token/speed/cost stats when a session
 * becomes idle (AI finishes responding).
 *
 * In TUI mode, this plugin is auto-loaded from:
 *   ~/.config/opencode/plugins/oc-stats-for-nerds.ts
 *
 * For headless/serve mode (Paseo, remote), use the standalone watcher:
 *   npx oc-stats-for-nerds --server http://localhost:4096
 */

export const StatsPlugin: Plugin = async ({ client }) => {
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

        const stats = aggregateStats(messages, session)
        if (stats.totalOutput === 0) return

        const block = formatStats(stats)

        // Toast with quick summary
        await client.tui.showToast({
          body: {
            message: `${stats.tps.toFixed(1)} tok/sec · ${stats.totalOutput.toLocaleString()} out · $${stats.totalCost.toFixed(4)}`,
            variant: "info",
          },
        })

        // Full stats in log
        await client.app.log({
          body: {
            service: "oc-stats-for-nerds",
            level: "info",
            message: block,
          },
        })
      } catch {
        // Silent fail — don't disrupt the session
      }
    },
  }
}

// ─── Stats logic ────────────────────────────────────────────

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
  model?: { id: string; providerID: string }
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

interface AggregatedStats {
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
}

function durSec(t?: { created?: number; completed?: number }): number {
  if (!t?.created || !t?.completed) return 0
  return Math.max(0, (t.completed - t.created) / 1000)
}

function aggregateStats(messages: SessionMessage[], session: SessionData): AggregatedStats {
  let totalOutput = 0
  let totalInput = 0
  let totalReasoning = 0
  let totalCost = 0
  let totalGenSec = 0
  let firstTokenSec: number | null = null
  let model = "?"

  const assistantMsgs = messages.filter((m) => m.info.role === "assistant")

  assistantMsgs.forEach((m, i) => {
    const tk = m.info.tokens || {}
    totalOutput += tk.output || 0
    totalInput += tk.input || 0
    totalReasoning += tk.reasoning || 0
    totalCost += m.info.cost || 0

    const genSec = durSec(m.info.time)
    totalGenSec += genSec
    if (i === 0 && genSec > 0) firstTokenSec = genSec
    if (model === "?" && m.info.modelID) model = m.info.modelID
  })

  const tps = totalGenSec > 0 ? totalOutput / totalGenSec : 0
  const cacheRead = session.tokens?.cache?.read || 0

  return {
    totalOutput, totalInput, totalReasoning, totalCost, cacheRead,
    totalGenSec, firstTokenSec, model,
    msgCount: assistantMsgs.length, tps,
  }
}

function formatStats(s: AggregatedStats): string {
  const totalTokens = s.totalInput + s.totalOutput + s.totalReasoning
  const lines: string[] = []
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  lines.push(`⚡ ${s.tps.toFixed(1)} tok/sec  (${s.totalOutput.toLocaleString()} out / ${s.totalGenSec.toFixed(1)}s)`)
  let tokenLine = `🎯 ${totalTokens.toLocaleString()} tokens  (${s.totalInput.toLocaleString()} in + ${s.totalOutput.toLocaleString()} out`
  if (s.totalReasoning) tokenLine += ` + ${s.totalReasoning.toLocaleString()} reasoning`
  if (s.cacheRead) tokenLine += ` · ${s.cacheRead.toLocaleString()} cached`
  tokenLine += ")"
  lines.push(tokenLine)
  if (s.firstTokenSec !== null) lines.push(`⏱️  Time-to-First: ${s.firstTokenSec.toFixed(1)}s`)
  lines.push(`🤖 ${s.model} · ${s.msgCount} msgs · $${s.totalCost.toFixed(4)}`)
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  return lines.join("\n")
}
