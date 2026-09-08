#!/usr/bin/env node
/**
 * Smoke test the built server against the REAL configured targets, without
 * Claude Desktop. Run after every build that touches connection handling:
 *   node scripts/smoke.mjs
 *
 * Exercises connect -> exec -> file read -> jail enforcement -> clean close,
 * per target, and reports one line each. Exit 1 if any required target fails.
 * Targets marked "optional" in the config may fail without failing the run.
 */
import { readFile } from "fs/promises"
import os from "os"
import path from "path"

const { ConnectionManager } = await import("../build/connection-manager.js")
const { parseTargetsJson } = await import("../build/config.js")
const { resolveUnderRoot } = await import("../build/root-jail.js")

const configPath =
  process.argv[2] || path.join(os.homedir(), ".mcp-remote-code", "targets.json")
const startups = parseTargetsJson(JSON.parse(await readFile(configPath, "utf-8")))

const mgr = new ConnectionManager()
let failures = 0
const rows = []

for (const startup of startups) {
  const t0 = Date.now()
  const row = { name: startup.name, optional: !!startup.optional }
  try {
    await mgr.connectStartup(startup)
    const conn = mgr.get(startup.name)
    row.connect = `${Date.now() - t0}ms`

    // 1. exec round trip
    const echo = await conn.sshPool.exec("echo __SMOKE_OK__", { retry: true, timeout: 15000 })
    row.exec = echo.stdout.includes("__SMOKE_OK__") ? "ok" : `BAD(${echo.exitCode})`

    // 2. UTF-8 integrity through the output path (P-5 regression guard)
    const utf = await conn.sshPool.exec("printf '測試中文字符'", { retry: true, timeout: 15000 })
    row.utf8 = utf.stdout.trim() === "測試中文字符" ? "ok" : `MANGLED(${utf.stdout.trim()})`

    // 3. root jail: the root itself must resolve (regression guard for root "/")
    const inside = await resolveUnderRoot(conn.config.remoteWorkdir, ".", conn.sshPool)
    row.jailIn = inside.error ? `FAIL(${inside.error})` : "ok"

    // 4. root jail: escape must be refused
    const outside = await resolveUnderRoot(conn.config.remoteWorkdir, "/etc/passwd", conn.sshPool)
    const rootIsSlash = conn.config.remoteWorkdir === "/"
    row.jailOut = rootIsSlash
      ? "n/a (root=/)"
      : outside.error
        ? "refused"
        : "LEAKED"

    if (row.exec !== "ok" || row.utf8 !== "ok" || row.jailIn !== "ok" || row.jailOut === "LEAKED") {
      throw new Error("assertion failed")
    }
    row.status = "PASS"
  } catch (err) {
    row.status = "FAIL"
    row.error = (err?.message || String(err)).split("\n")[0].slice(0, 80)
    if (!row.optional) failures++
  }
  rows.push(row)
}

await mgr.closeAll?.().catch?.(() => {})

const pad = (s, n) => String(s ?? "").padEnd(n)
console.log("\n" + pad("target", 14) + pad("status", 7) + pad("connect", 10) +
            pad("exec", 6) + pad("utf8", 6) + pad("jail-in", 9) + pad("jail-out", 14) + "error")
console.log("-".repeat(100))
for (const r of rows) {
  console.log(
    pad(r.name, 14) + pad(r.status + (r.optional && r.status === "FAIL" ? "*" : ""), 7) +
    pad(r.connect, 10) + pad(r.exec, 6) + pad(r.utf8, 6) +
    pad(r.jailIn, 9) + pad(r.jailOut, 14) + (r.error || "")
  )
}
console.log("\n* optional target, does not fail the run")
console.log(failures === 0 ? "SMOKE: PASS" : `SMOKE: FAIL (${failures} required target(s))`)
process.exit(failures === 0 ? 1 * 0 : 1)
