/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, Show, onCleanup, createMemo } from "solid-js"

const PLUGIN_ID = "opencode-stats-for-nerds"

// ── Config ──

interface StatVisibility {
  tokens: boolean
  cache: boolean
  context: boolean
  cost: boolean
  genTime: boolean
  thinkTime: boolean
  ttft: boolean
  speed: boolean
  activity: boolean
  changes: boolean
  model: boolean
}

interface PluginOptions {
  show?: Partial<StatVisibility>
}

const DEFAULT_VISIBILITY: StatVisibility = {
  tokens: true,
  cache: true,
  context: true,
  cost: true,
  genTime: true,
  thinkTime: false,
  ttft: true,
  speed: true,
  activity: false,
  changes: true,
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
  time?: { start?: number; end?: number }
}

interface MessageInfo {
  role: string
  modelID?: string
  providerID?: string
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

interface FileChange {
  file: string
  additions: number
  deletions: number
}

interface Stats {
  // cumulative tokens
  totalInput: number
  totalOutput: number
  totalReasoning: number
  totalCacheRead: number
  totalCacheWrite: number
  // context window (last message, NOT cumulative)
  contextUsed: number
  contextLimit: number
  contextPercent: number
  // cost
  totalCost: number
  // timing
  activeTimeMs: number
  thinkTimeMs: number
  lastTtft: number | null
  lastTps: number
  // activity
  stepCount: number
  toolCallCount: number
  // files
  fileChanges: FileChange[]
  totalAdditions: number
  totalDeletions: number
  // model
  model: string
  providerID: string
  turnCount: number
}

function findContextLimit(
  api: Parameters<TuiPlugin>[0],
  modelID: string | undefined,
  providerID: string | undefined,
): number {
  if (!modelID || !providerID) return 0
  const providers = api.state.provider
  const provider = providers.find((p: any) => p.id === providerID)
  if (!provider) return 0
  const model = (provider as any).models?.[modelID]
  if (!model) return 0
  return model.limit?.context || 0
}

function computeStats(
  messages: RawMessage[],
  sessionCost: number,
  fileChanges: FileChange[],
  contextLimit: number,
): Stats | null {
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
  let thinkTimeMs = 0
  let stepCount = 0
  let toolCallCount = 0

  for (const m of assistants) {
    const tk = m.info.tokens!
    totalInput += tk.input || 0
    totalOutput += tk.output || 0
    totalReasoning += tk.reasoning || 0
    totalCacheRead += tk.cache?.read || 0
    totalCacheWrite += tk.cache?.write || 0
    totalCost += m.info.cost || 0

    if (m.info.time?.created && m.info.time?.completed) {
      activeTimeMs += m.info.time.completed - m.info.time.created
    }

    // Count parts
    if (m.parts) {
      for (const p of m.parts) {
        if (p.type === "step-start") stepCount++
        if (p.type === "tool") toolCallCount++
        if (p.type === "reasoning" && p.time?.start && p.time?.end) {
          thinkTimeMs += p.time.end - p.time.start
        }
      }
    }
  }

  // Context window = last message's full token set
  const last = assistants[assistants.length - 1]
  const lastInfo = last.info
  const lastTk = lastInfo.tokens!
  const contextUsed =
    (lastTk.input || 0) + (lastTk.output || 0) + (lastTk.reasoning || 0) +
    (lastTk.cache?.read || 0) + (lastTk.cache?.write || 0)

  const contextPercent = contextLimit > 0 ? Math.round((contextUsed / contextLimit) * 100) : 0

  // TTFT
  let lastTtft: number | null = null
  if (lastInfo.time?.created && last.parts) {
    for (const p of last.parts) {
      if ((p.type === "text" || p.type === "reasoning") && p.time) {
        const t = p.time.start || (p.time as any)
        if (typeof t === "number") {
          const delta = t - lastInfo.time.created
          if (delta > 0) {
            lastTtft = delta / 1000
            break
          }
        }
      }
    }
  }

  // Speed
  let lastTps = 0
  if (lastInfo.time?.created && lastInfo.time?.completed) {
    const durSec = (lastInfo.time.completed - lastInfo.time.created) / 1000
    if (durSec > 0) {
      lastTps = (lastTk.output || 0) / durSec
    }
  }

  // Files
  let totalAdditions = 0
  let totalDeletions = 0
  for (const f of fileChanges) {
    totalAdditions += f.additions || 0
    totalDeletions += f.deletions || 0
  }

  return {
    totalInput,
    totalOutput,
    totalReasoning,
    totalCacheRead,
    totalCacheWrite,
    contextUsed,
    contextLimit,
    contextPercent,
    totalCost: sessionCost || totalCost,
    activeTimeMs,
    thinkTimeMs,
    lastTtft,
    lastTps,
    stepCount,
    toolCallCount,
    fileChanges,
    totalAdditions,
    totalDeletions,
    model: lastInfo.modelID || "unknown",
    providerID: lastInfo.providerID || "",
    turnCount: assistants.length,
  }
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

    // Find model info for context limit
    let ctxLimit = 0
    const lastAssistant = [...msgs].reverse().find((m) => m.info?.role === "assistant")
    if (lastAssistant) {
      ctxLimit = findContextLimit(
        props.api,
        lastAssistant.info.modelID,
        lastAssistant.info.providerID,
      )
    }

    const diff = props.api.state.session.diff(props.sessionID) as unknown as FileChange[] || []
    return computeStats(msgs, session?.cost ?? 0, diff, ctxLimit)
  })

  const v = props.visibility
  const t = () => theme()
  const W = 13

  // Context percent color
  const ctxColor = (pct: number) => {
    if (pct > 80) return t().error
    if (pct > 50) return t().warning
    return t().text
  }

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

              {/* ── Tokens ── */}
              <Show when={v.tokens}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  Tokens", W)}</text>
                  <text style={{ fg: t().text }}>{"  " + fmt(s().totalInput) + " in"}</text>
                  <text style={{ fg: t().textMuted }}>{" \u00B7 "}</text>
                  <text style={{ fg: t().text }}>{fmt(s().totalOutput) + " out"}</text>
                  <Show when={s().totalReasoning > 0}>
                    <text style={{ fg: t().textMuted }}>{" \u00B7 "}</text>
                    <text style={{ fg: t().text }}>{fmt(s().totalReasoning) + " thinking"}</text>
                  </Show>
                </box>
              </Show>

              {/* ── Cache ── */}
              <Show when={v.cache && (s().totalCacheRead > 0 || s().totalCacheWrite > 0)}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  Cached", W)}</text>
                  <text style={{ fg: t().text }}>{"  " + fmt(s().totalCacheRead) + " read"}</text>
                  <Show when={s().totalCacheWrite > 0}>
                    <text style={{ fg: t().textMuted }}>{" \u00B7 "}</text>
                    <text style={{ fg: t().text }}>{fmt(s().totalCacheWrite) + " write"}</text>
                  </Show>
                </box>
              </Show>

              {/* ── Context ── */}
              <Show when={v.context && s().contextLimit > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  Context", W)}</text>
                  <text style={{ fg: ctxColor(s().contextPercent) }}>
                    {"  " + fmt(s().contextUsed) + " / " + fmt(s().contextLimit)}
                  </text>
                  <text style={{ fg: t().textMuted }}>
                    {" (" + s().contextPercent + "%)"}
                  </text>
                </box>
              </Show>

              {/* ── Separator ── */}
              <text style={{ fg: t().textMuted }}>{"  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"}</text>

              {/* ── Cost ── */}
              <Show when={v.cost}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  Cost", W)}</text>
                  <text style={{ fg: t().text }}>{"  $" + s().totalCost.toFixed(4)}</text>
                </box>
              </Show>

              {/* ── Gen Time ── */}
              <Show when={v.genTime && s().activeTimeMs > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  Gen Time", W)}</text>
                  <text style={{ fg: t().text }}>{"  " + fmtDuration(s().activeTimeMs)}</text>
                </box>
              </Show>

              {/* ── Think Time ── */}
              <Show when={v.thinkTime && s().thinkTimeMs > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  Think Time", W)}</text>
                  <text style={{ fg: t().text }}>{"  " + fmtDuration(s().thinkTimeMs)}</text>
                </box>
              </Show>

              {/* ── TTFT ── */}
              <Show when={v.ttft && s().lastTtft !== null}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  TTFT", W)}</text>
                  <text style={{ fg: t().text }}>{"  " + s().lastTtft!.toFixed(2) + "s"}</text>
                </box>
              </Show>

              {/* ── Speed ── */}
              <Show when={v.speed && s().lastTps > 0}>
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

              {/* ── Separator ── */}
              <text style={{ fg: t().textMuted }}>{"  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"}</text>

              {/* ── Activity ── */}
              <Show when={v.activity && (s().stepCount > 0 || s().toolCallCount > 0)}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  Activity", W)}</text>
                  <text style={{ fg: t().text }}>
                    {"  " + s().stepCount + " steps"}
                  </text>
                  <Show when={s().toolCallCount > 0}>
                    <text style={{ fg: t().textMuted }}>{" \u00B7 "}</text>
                    <text style={{ fg: t().text }}>{s().toolCallCount + " tools"}</text>
                  </Show>
                </box>
              </Show>

              {/* ── Changes ── */}
              <Show when={v.changes && s().fileChanges.length > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  Changes", W)}</text>
                  <text style={{ fg: t().success }}>{"  +" + s().totalAdditions}</text>
                  <text style={{ fg: t().textMuted }}>{" "}</text>
                  <text style={{ fg: t().error }}>{"-" + s().totalDeletions}</text>
                  <text style={{ fg: t().textMuted }}>
                    {" \u00B7 " + s().fileChanges.length + " files"}
                  </text>
                </box>
              </Show>

              {/* ── Model ── */}
              <Show when={v.model}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  Model", W)}</text>
                  <text style={{ fg: t().textMuted }}>{"  " + s().model}</text>
                </box>
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
