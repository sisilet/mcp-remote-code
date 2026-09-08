import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildServerInstructions } from "../src/server-instructions.js"

describe("server instructions", () => {
  it("includes connection and jail details", () => {
    const text = buildServerInstructions([
      {
        name: "dev",
        host: "host.example",
        user: "user",
        port: 22,
        workdir: "/home/project",
        platform: "linux",
        isGitRepo: false,
        connected: true,
      },
    ])

    assert.match(text, /dev: user@host\.example:22/)
    assert.match(text, /root=\/home\/project/)
    assert.match(text, /remote_stat/)
    assert.match(text, /remote_hash/)
    assert.match(text, /outside=true/)
    assert.match(text, /Agent policy/)
    assert.match(text, /Do NOT use file tools/)
    assert.match(text, /Do NOT use remote_bash/)
    assert.match(text, /ONLY writable workspace/)
  })

  it("mentions target parameter for multiple remotes", () => {
    const text = buildServerInstructions([
      {
        name: "alpha",
        host: "a",
        user: "u",
        port: 22,
        workdir: "/a",
        platform: "linux",
        isGitRepo: false,
        connected: true,
      },
      {
        name: "beta",
        host: "b",
        user: "u",
        port: 22,
        workdir: "/b",
        platform: "linux",
        isGitRepo: false,
        connected: true,
      },
    ])
    assert.match(text, /Connected targets \(2\/2\)/)
    assert.match(text, /target parameter/)
  })

  it("lists offline targets without blocking online ones", () => {
    const text = buildServerInstructions(
      [
        {
          name: "genie",
          host: "a",
          user: "u",
          port: 22,
          workdir: "/a",
          platform: "linux",
          isGitRepo: false,
          connected: true,
        },
      ],
      [{ name: "galaxy-s26", error: "connect ECONNREFUSED" }]
    )
    assert.match(text, /Connected targets \(1\/2\)/)
    assert.match(text, /Offline targets \(1\)/)
    assert.match(text, /galaxy-s26: connect ECONNREFUSED/)
    assert.match(text, /auto-retry|automatic reconnect|throttled/i)
  })
})
