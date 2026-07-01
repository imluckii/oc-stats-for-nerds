#!/usr/bin/env node
/**
 * oc-stats-for-nerds — standalone watcher
 *
 * Polls an OpenCode server for completed sessions and prints stats.
 * Use this when running OpenCode in headless/serve mode (e.g. with Paseo)
 * where TS plugins don't auto-load.
 *
 * Usage:
 *   node watcher.mjs --server http://localhost:4096
 *   node watcher.mjs --server http://localhost:4096 --once
 *   node watcher.mjs --server http://localhost:4096 --interval 2
 */

import { parseArgs } from "node:util"

const { values: args } = parseArgs({
  options: {
    server: { type: "string", default: "http://localhost:4096" },
    interval: { type: "string", default: "3" },
    once: { type: "boolean", default: false },
  },
})

const SERVER = args.server.replace(/\/$/, "")
const INTERVAL = parseInt(args.interval, 10) * 1000
const ONCE = args.once

// Track sessions we've already reported
const reported = new Set()

async function api(path) {
  const res = await fetch(`${SERVER}${path}`)
  if (!res.ok) return null
  return res.json()
}

function durMin(created, updated) {
  if (!created || !updated) return 0
  return ((updated - created) / 60000).toFixed(1)
}

function formatStats(session) {
  const tk = session.tokens || {}
  const model = session.model?.id || "?"
  const totalTokens = (tk.input || 0) + (tk.output || 0) + (tk.reasoning || 0)
  const cacheRead = tk.cache?.read || 0
  const genSec = ((session.time?.updated || 0) - (session.time?.created || 0)) / 1000
  const tps = genSec > 0 ? (tk.output || 0) / genSec : 0

  const lines = []
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  lines.push(`⚡ ${tps.toFixed(1)} tok/sec  (${(tk.output || 0).toLocaleString()} out / ${genSec.toFixed(1)}s)`)
  let tokenLine = `🎯 ${totalTokens.toLocaleString()} tokens  (${(tk.input || 0).toLocaleString()} in + ${(tk.output || 0).toLocaleString()} out`
  if (tk.reasoning) tokenLine += ` + ${tk.reasoning.toLocaleString()} reasoning`
  if (cacheRead) tokenLine += ` · ${cacheRead.toLocaleString()} cached`
  tokenLine += ")"
  lines.push(tokenLine)
  lines.push(`🤖 ${model} · ${durMin(session.time?.created, session.time?.updated)} min · $${(session.cost || 0).toFixed(4)}`)
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  return lines.join("\n")
}

async function check() {
  let sessions
  try {
    sessions = await api("/session")
  } catch {
    if (ONCE) console.error(`Cannot connect to ${SERVER}`)
    return
  }

  if (!sessions || !Array.isArray(sessions)) return

  for (const session of sessions) {
    // Skip already reported sessions
    if (reported.has(session.id)) continue

    // Only report sessions that have output (finished sessions)
    const output = session.tokens?.output || 0
    if (output === 0) continue

    // Mark as reported
    reported.add(session.id)

    const title = session.title?.slice(0, 50) || "untitled"
    console.log(`\n📊 ${title}`)
    console.log(formatStats(session))
  }
}

async function main() {
  console.log(`oc-stats-for-nerds watching ${SERVER}`)

  if (ONCE) {
    await check()
    return
  }

  // Poll loop
  while (true) {
    await check()
  }
}

main()
