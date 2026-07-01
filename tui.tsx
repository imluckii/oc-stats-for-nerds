/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, Show, onCleanup, createMemo } from "solid-js"

const PLUGIN_ID = "oc-stats-for-nerds"

// ── Helpers ──

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}k`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtTps(n: number): string {
  if (n >= 100) return n.toFixed(0)
  if (n >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

function pad(str: string, width: number): string {
  const s = String(str)
  return s.length >= width ? s : s + " ".repeat(width - s.length)
}

// ── Types ──

interface PartData {
  type: string
  time?: number
}

interface MessageInfo {
  role: string
  modelID?: string
  cost?: number
  tokens?: {
    total?: number
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  time?: { created?: number; completed?: number }
}

interface RawMessage {
  info: MessageInfo
  parts?: PartData[]
}

interface Stats {
  // cumulative across all assistant turns
  totalInput: number
  totalOutput: number
  totalReasoning: number
  totalCacheRead: number
  totalCacheWrite: number
  grandTotal: number
  totalCost: number
  turnCount: number
  model: string
  // latest turn only
  lastTtft: number | null
  lastTps: number
}

function computeStats(messages: RawMessage[], sessionCost: number): Stats | null {
  const assistants = messages
    .filter((m) => m.info?.role === "assistant" && m.info?.tokens)
    .map((m) => m)

  if (assistants.length === 0) return null

  // Cumulative totals
  let totalInput = 0
  let totalOutput = 0
  let totalReasoning = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let totalCost = 0

  for (const m of assistants) {
    const tk = m.info.tokens!
    totalInput += tk.input || 0
    totalOutput += tk.output || 0
    totalReasoning += tk.reasoning || 0
    totalCacheRead += tk.cache?.read || 0
    totalCacheWrite += tk.cache?.write || 0
    totalCost += m.info.cost || 0
  }

  // Latest turn for TTFT and speed
  const last = assistants[assistants.length - 1]
  const lastInfo = last.info
  const lastTk = lastInfo.tokens!

  // TTFT: time from message created to first content part emitted
  let lastTtft: number | null = null
  if (lastInfo.time?.created && last.parts) {
    for (const p of last.parts) {
      if ((p.type === "text" || p.type === "reasoning") && p.time) {
        const delta = p.time - lastInfo.time.created
        if (delta > 0) {
          lastTtft = delta / 1000
          break
        }
      }
    }
  }

  // Speed: output tokens / generation duration
  let lastTps = 0
  if (lastInfo.time?.created && lastInfo.time?.completed) {
    const durSec = (lastInfo.time.completed - lastInfo.time.created) / 1000
    if (durSec > 0) {
      lastTps = (lastTk.output || 0) / durSec
    }
  }

  const grandTotal =
    totalInput + totalOutput + totalReasoning + totalCacheRead + totalCacheWrite

  return {
    totalInput,
    totalOutput,
    totalReasoning,
    totalCacheRead,
    totalCacheWrite,
    grandTotal,
    totalCost: sessionCost || totalCost,
    turnCount: assistants.length,
    model: lastInfo.modelID || "unknown",
    lastTtft,
    lastTps,
  }
}

// ── View ──

function StatsView(props: { api: Parameters<TuiPlugin>[0]; sessionID: string }) {
  const theme = () => props.api.theme.current
  const [collapsed, setCollapsed] = createSignal(false)
  const [tick, setTick] = createSignal(0)

  const stop1 = props.api.event.on("message.updated", (e: any) => {
    if (e.properties?.sessionID !== props.sessionID) return
    setTick((v) => v + 1)
  })
  const stop2 = props.api.event.on("session.idle", (e: any) => {
    const sid = e.properties?.id || e.properties?.sessionID
    if (sid !== props.sessionID) return
    setTick((v) => v + 1)
  })

  onCleanup(() => { stop1(); stop2() })

  const stats = createMemo<Stats | null>(() => {
    tick()
    const msgs = props.api.state.session.messages(props.sessionID) as unknown as RawMessage[] || []
    const session = props.api.state.session.get(props.sessionID) as any
    return computeStats(msgs, session?.cost ?? 0)
  })

  const t = () => theme()
  const W = 8

  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" gap={1} onMouseDown={() => setCollapsed((v) => !v)}>
        <text style={{ fg: t().textMuted }}>{collapsed() ? "\u25B6" : "\u25BC"}</text>
        <text style={{ fg: t().text, fontWeight: "bold" }}>Stats for Nerds</text>
      </box>

      <Show when={!collapsed()}>
        <Show
          when={stats()}
          fallback={<text style={{ fg: t().textMuted }}>{"  waiting for response..."}</text>}
        >
          {(s) => (
            <box flexDirection="column">

              {/* ── Tokens (cumulative) ── */}
              <box flexDirection="row">
                <text style={{ fg: t().textMuted }}>{pad("  Tokens", W)}</text>
                <text style={{ fg: t().text }}>
                  {"  " + fmt(s().totalInput) + " in"}
                </text>
                <text style={{ fg: t().textMuted }}>{" \u00B7 "}</text>
                <text style={{ fg: t().text }}>
                  {fmt(s().totalOutput) + " out"}
                </text>
                <Show when={s().totalReasoning > 0}>
                  <text style={{ fg: t().textMuted }}>{" \u00B7 "}</text>
                  <text style={{ fg: t().text }}>
                    {fmt(s().totalReasoning) + " thinking"}
                  </text>
                </Show>
              </box>

              {/* ── Cache (cumulative) ── */}
              <Show when={s().totalCacheRead > 0 || s().totalCacheWrite > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  Cache", W)}</text>
                  <text style={{ fg: t().text }}>
                    {"  " + fmt(s().totalCacheRead) + " read"}
                  </text>
                  <Show when={s().totalCacheWrite > 0}>
                    <text style={{ fg: t().textMuted }}>{" \u00B7 "}</text>
                    <text style={{ fg: t().text }}>
                      {fmt(s().totalCacheWrite) + " write"}
                    </text>
                  </Show>
                </box>
              </Show>

              {/* ── Total ── */}
              <box flexDirection="row">
                <text style={{ fg: t().textMuted }}>{pad("  Total", W)}</text>
                <text style={{ fg: t().text }}>
                  {"  " + fmt(s().grandTotal)}
                </text>
              </box>

              {/* ── Separator ── */}
              <text style={{ fg: t().textMuted }}>{"  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"}</text>

              {/* ── Cost (cumulative) ── */}
              <box flexDirection="row">
                <text style={{ fg: t().textMuted }}>{pad("  Cost", W)}</text>
                <text style={{ fg: t().text }}>
                  {"  $" + s().totalCost.toFixed(4)}
                </text>
              </box>

              {/* ── TTFT (latest turn) ── */}
              <Show when={s().lastTtft !== null}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  TTFT", W)}</text>
                  <text style={{ fg: t().text }}>
                    {"  " + s().lastTtft!.toFixed(2) + "s"}
                  </text>
                </box>
              </Show>

              {/* ── Speed (latest turn) ── */}
              <Show when={s().lastTps > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  Speed", W)}</text>
                  <text
                    style={{
                      fg: s().lastTps > 50 ? t().success : s().lastTps > 15 ? t().warning : t().textMuted,
                    }}
                  >
                    {"  " + fmtTps(s().lastTps) + " tok/s"}
                  </text>
                </box>
              </Show>

              {/* ── Model ── */}
              <box flexDirection="row">
                <text style={{ fg: t().textMuted }}>{pad("  Model", W)}</text>
                <text style={{ fg: t().textMuted }}>{"  " + s().model}</text>
              </box>

            </box>
          )}
        </Show>
      </Show>
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
