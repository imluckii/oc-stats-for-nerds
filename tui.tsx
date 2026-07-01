/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, Show, onCleanup, createMemo } from "solid-js"

const PLUGIN_ID = "opencode-stats-for-nerds"

// ── Config ──
// All stats can be individually toggled via tui.json:
//   "plugin": [["opencode-stats-for-nerds", { "show": { "speed": false } }]]
// Defaults: everything shown.

interface StatVisibility {
  tokens: boolean
  cache: boolean
  total: boolean
  cost: boolean
  ttft: boolean
  speed: boolean
  sessionTime: boolean
  model: boolean
}

interface PluginOptions {
  show?: Partial<StatVisibility>
}

const DEFAULT_VISIBILITY: StatVisibility = {
  tokens: true,
  cache: true,
  total: true,
  cost: true,
  ttft: true,
  speed: true,
  sessionTime: true,
  model: true,
}

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

function fmtDuration(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
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
  totalInput: number
  totalOutput: number
  totalReasoning: number
  totalCacheRead: number
  totalCacheWrite: number
  grandTotal: number
  totalCost: number
  turnCount: number
  model: string
  // latest turn
  lastTtft: number | null
  lastTps: number
  // session active generation time (sum of all assistant durations)
  activeTimeMs: number
}

function computeStats(messages: RawMessage[], sessionCost: number): Stats | null {
  const assistants = messages
    .filter((m) => m.info?.role === "assistant" && m.info?.tokens)
    .map((m) => m)

  if (assistants.length === 0) return null

  let totalInput = 0
  let totalOutput = 0
  let totalReasoning = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let totalCost = 0
  let activeTimeMs = 0

  for (const m of assistants) {
    const tk = m.info.tokens!
    totalInput += tk.input || 0
    totalOutput += tk.output || 0
    totalReasoning += tk.reasoning || 0
    totalCacheRead += tk.cache?.read || 0
    totalCacheWrite += tk.cache?.write || 0
    totalCost += m.info.cost || 0

    // Sum actual generation durations
    if (m.info.time?.created && m.info.time?.completed) {
      activeTimeMs += m.info.time.completed - m.info.time.created
    }
  }

  const last = assistants[assistants.length - 1]
  const lastInfo = last.info
  const lastTk = lastInfo.tokens!

  // TTFT: created → first content part
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

  // Speed: latest turn only
  let lastTps = 0
  if (lastInfo.time?.created && lastInfo.time?.completed) {
    const durSec = (lastInfo.time.completed - lastInfo.time.created) / 1000
    if (durSec > 0) {
      lastTps = (lastTk.output || 0) / durSec
    }
  }

  return {
    totalInput,
    totalOutput,
    totalReasoning,
    totalCacheRead,
    totalCacheWrite,
    grandTotal:
      totalInput + totalOutput + totalReasoning + totalCacheRead + totalCacheWrite,
    totalCost: sessionCost || totalCost,
    turnCount: assistants.length,
    model: lastInfo.modelID || "unknown",
    lastTtft,
    lastTps,
    activeTimeMs,
  }
}

// ── Row component ──

function Row(props: { label: string; children: any; theme: any; width: number }) {
  const t = () => props.theme
  return (
    <box flexDirection="row">
      <text style={{ fg: t().textMuted }}>{pad("  " + props.label, props.width)}</text>
      {props.children}
    </box>
  )
}

// ── View ──

function StatsView(props: {
  api: Parameters<TuiPlugin>[0]
  sessionID: string
  visibility: StatVisibility
}) {
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

  const v = props.visibility
  const t = () => theme()
  const W = 13

  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" gap={1} onMouseDown={() => setCollapsed((c) => !c)}>
        <text style={{ fg: t().textMuted }}>{collapsed() ? "\u25B6" : "\u25BC"}</text>
        <text style={{ fg: t().text, fontWeight: "bold" }}>Stats for Nerds</text>
      </box>

      <Show when={!collapsed()}>
        <Show
          when={stats()}
          fallback={<text style={{ fg: t().textMuted }}>{"  waiting..."}</text>}
        >
          {(s) => (
            <box flexDirection="column">

              {/* Tokens */}
              <Show when={v.tokens}>
                <Row label="Tokens" theme={t()} width={W}>
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
                </Row>
              </Show>

              {/* Cache */}
              <Show when={v.cache && (s().totalCacheRead > 0 || s().totalCacheWrite > 0)}>
                <Row label="Cached" theme={t()} width={W}>
                  <text style={{ fg: t().text }}>
                    {"  " + fmt(s().totalCacheRead) + " read"}
                  </text>
                  <Show when={s().totalCacheWrite > 0}>
                    <text style={{ fg: t().textMuted }}>{" \u00B7 "}</text>
                    <text style={{ fg: t().text }}>
                      {fmt(s().totalCacheWrite) + " write"}
                    </text>
                  </Show>
                </Row>
              </Show>

              {/* Total */}
              <Show when={v.total}>
                <Row label="Total" theme={t()} width={W}>
                  <text style={{ fg: t().text }}>
                    {"  " + fmt(s().grandTotal)}
                  </text>
                </Row>
              </Show>

              {/* Separator */}
              <text style={{ fg: t().textMuted }}>{"  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"}</text>

              {/* Cost */}
              <Show when={v.cost}>
                <Row label="Cost" theme={t()} width={W}>
                  <text style={{ fg: t().text }}>
                    {"  $" + s().totalCost.toFixed(4)}
                  </text>
                </Row>
              </Show>

              {/* Session Time */}
              <Show when={v.sessionTime && s().activeTimeMs > 0}>
                <Row label="Gen Time" theme={t()} width={W}>
                  <text style={{ fg: t().text }}>
                    {"  " + fmtDuration(s().activeTimeMs)}
                  </text>
                </Row>
              </Show>

              {/* TTFT */}
              <Show when={v.ttft && s().lastTtft !== null}>
                <Row label="TTFT" theme={t()} width={W}>
                  <text style={{ fg: t().text }}>
                    {"  " + s().lastTtft!.toFixed(2) + "s"}
                  </text>
                </Row>
              </Show>

              {/* Speed */}
              <Show when={v.speed && s().lastTps > 0}>
                <Row label="Speed" theme={t()} width={W}>
                  <text
                    style={{
                      fg: s().lastTps > 50 ? t().success : s().lastTps > 15 ? t().warning : t().textMuted,
                    }}
                  >
                    {"  " + fmtTps(s().lastTps) + " tok/s"}
                  </text>
                </Row>
              </Show>

              {/* Model */}
              <Show when={v.model}>
                <Row label="Model" theme={t()} width={W}>
                  <text style={{ fg: t().textMuted }}>{"  " + s().model}</text>
                </Row>
              </Show>

            </box>
          )}
        </Show>
      </Show>
    </box>
  )
}

// ── Plugin ──

const tui: TuiPlugin = async (api, options) => {
  const opts = options as PluginOptions | undefined
  const visibility: StatVisibility = {
    ...DEFAULT_VISIBILITY,
    ...opts?.show,
  }

  api.slots.register({
    order: 200,
    slots: {
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        return (
          <StatsView
            api={api}
            sessionID={props.session_id}
            visibility={visibility}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
