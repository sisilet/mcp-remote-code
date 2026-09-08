import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import os from "os"
import path from "path"
import {
  checkHostKey,
  fingerprintOf,
  knownHostsName,
  lookupKnownHostKeys,
} from "../src/known-hosts.ts"

const KEY_A = Buffer.from("0000000b7373682d65643235353139aaaa", "hex")
const KEY_B = Buffer.from("0000000b7373682d65643235353139bbbb", "hex")

function withKnownHosts(lines: string, fn: () => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-"))
  const file = path.join(dir, "known_hosts")
  fs.writeFileSync(file, lines, { mode: 0o600 })
  const prev = process.env.MCP_KNOWN_HOSTS
  process.env.MCP_KNOWN_HOSTS = file
  try { fn() } finally {
    if (prev === undefined) delete process.env.MCP_KNOWN_HOSTS
    else process.env.MCP_KNOWN_HOSTS = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test("knownHostsName uses [host]:port only for non-22", () => {
  assert.equal(knownHostsName("h", 22), "h")
  assert.equal(knownHostsName("h", 0), "h")
  assert.equal(knownHostsName("h", 8022), "[h]:8022")
})

test("fingerprint is OpenSSH SHA256 form", () => {
  const fp = fingerprintOf(KEY_A)
  assert.ok(fp.startsWith("SHA256:"))
  assert.ok(!fp.endsWith("="))
})

test("unknown host is rejected, not silently accepted", () => {
  withKnownHosts("", () => {
    const r = checkHostKey("10.0.0.1", 22, KEY_A)
    assert.equal(r.ok, false)
    assert.equal(r.unknown, true)
    assert.equal(r.mismatch, undefined)
  })
})

test("matching key is accepted", () => {
  withKnownHosts(`10.0.0.1 ssh-ed25519 ${KEY_A.toString("base64")}\n`, () => {
    assert.equal(checkHostKey("10.0.0.1", 22, KEY_A).ok, true)
  })
})

test("known host offering a different key is a mismatch, not unknown", () => {
  withKnownHosts(`10.0.0.1 ssh-ed25519 ${KEY_A.toString("base64")}\n`, () => {
    const r = checkHostKey("10.0.0.1", 22, KEY_B)
    assert.equal(r.ok, false)
    assert.equal(r.mismatch, true)
    assert.equal(r.unknown, undefined)
  })
})

test("non-standard port entries are found", () => {
  withKnownHosts(`[10.0.0.2]:8022 ssh-ed25519 ${KEY_A.toString("base64")}\n`, () => {
    assert.equal(lookupKnownHostKeys("10.0.0.2", 8022).length, 1)
    assert.equal(checkHostKey("10.0.0.2", 8022, KEY_A).ok, true)
    // same host on the default port is a different entry
    assert.equal(checkHostKey("10.0.0.2", 22, KEY_A).unknown, true)
  })
})

test("missing known_hosts file yields no keys rather than throwing", () => {
  const prev = process.env.MCP_KNOWN_HOSTS
  process.env.MCP_KNOWN_HOSTS = "/nonexistent/dir/known_hosts"
  try {
    assert.deepEqual(lookupKnownHostKeys("h", 22), [])
  } finally {
    if (prev === undefined) delete process.env.MCP_KNOWN_HOSTS
    else process.env.MCP_KNOWN_HOSTS = prev
  }
})
