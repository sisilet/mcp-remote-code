import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  loadTargetsFromEnv,
  parseStartupConnection,
  parseStartupConnections,
  parseTargetsJson,
  validateStartupConnection,
} from "../src/config.js"

describe("config", () => {
  it("parses --ssh --key --path", () => {
    const startup = parseStartupConnection([
      "--ssh",
      "user@host.example",
      "--key",
      "~/.ssh/id_rsa",
      "--path",
      "/home/project",
      "--name",
      "dev",
    ])
    assert.equal(startup?.name, "dev")
    assert.match(startup?.sshCommand ?? "", /ssh -i .+id_rsa user@host\.example/)
    assert.equal(startup?.root, "/home/project")
  })

  it("parses JSON targets with ssh key and path fields", () => {
    const targets = parseTargetsJson([
      {
        name: "dev",
        ssh: "user@host.example",
        key: "~/.ssh/id_rsa",
        path: "/home/project",
      },
    ])
    assert.equal(targets[0].name, "dev")
    assert.match(targets[0].sshCommand, /ssh -i .+id_rsa user@host\.example/)
    assert.equal(targets[0].root, "/home/project")
  })

  it("parses user@host:/path shorthand on --remote", () => {
    const startup = parseStartupConnection([
      "--remote",
      "user@host:/home/project",
    ])
    assert.deepEqual(startup, {
      name: "target1",
      sshCommand: "ssh user@host",
      root: "/home/project",
    })
  })

  it("parses ssh options with :/path shorthand", () => {
    const startup = parseStartupConnection([
      "--remote",
      "ssh -i ~/.ssh/key user@host:/home/project",
    ])
    assert.equal(startup?.sshCommand, "ssh -i ~/.ssh/key user@host")
    assert.equal(startup?.root, "/home/project")
  })

  it("allows multiple shorthand --remote values", () => {
    const { connections } = parseStartupConnections([
      "--remote",
      "user@host:/home/project",
      "--remote",
      "user@host2:/home/projects",
    ])
    assert.equal(connections.length, 2)
    assert.equal(connections[0].root, "/home/project")
    assert.equal(connections[1].root, "/home/projects")
  })

  it("lets explicit --root override shorthand root", () => {
    const startup = parseStartupConnection([
      "--remote",
      "user@host:/ignored",
      "--root",
      "/home/project",
    ])
    assert.equal(startup?.root, "/home/project")
  })

  it("parses IPv6 shorthand", () => {
    const startup = parseStartupConnection([
      "--remote",
      "user@[2001:db8::1]:/home/project",
    ])
    assert.equal(startup?.sshCommand, "ssh user@[2001:db8::1]")
    assert.equal(startup?.root, "/home/project")
  })

  it("parses --remote and --root", () => {
    const startup = parseStartupConnection([
      "--remote",
      "ssh user@host",
      "--root",
      "/home/project",
    ])
    assert.deepEqual(startup, {
      name: "target1",
      sshCommand: "ssh user@host",
      root: "/home/project",
    })
  })

  it("accepts --workdir as root alias", () => {
    const startup = parseStartupConnection([
      "--remote",
      "ssh user@host",
      "--workdir",
      "/home/project",
    ])
    assert.equal(startup?.root, "/home/project")
  })

  it("allows multiple --remote blocks", () => {
    const { connections } = parseStartupConnections([
      "--remote",
      "ssh one@host",
      "--root",
      "/a",
      "--name",
      "alpha",
      "--remote",
      "ssh two@host",
      "--root",
      "/b",
      "--name",
      "beta",
    ])
    assert.equal(connections.length, 2)
    assert.equal(connections[0].name, "alpha")
    assert.equal(connections[1].name, "beta")
  })

  it("validates missing root", () => {
    assert.throws(
      () => validateStartupConnection({ name: "default", sshCommand: "ssh x@y", root: "" }),
      /Missing remote root/
    )
  })

  it("reads targets from MCP_REMOTE_CODE_TARGETS env", () => {
    const prev = process.env.MCP_REMOTE_CODE_TARGETS
    process.env.MCP_REMOTE_CODE_TARGETS = JSON.stringify({
      targets: [
        {
          name: "dev",
          ssh: "ssh user@host",
          root: "/home/project",
        },
      ],
    })
    try {
      const targets = loadTargetsFromEnv()
      assert.equal(targets?.length, 1)
      assert.equal(targets?.[0].name, "dev")
      assert.equal(targets?.[0].root, "/home/project")
    } finally {
      if (prev === undefined) delete process.env.MCP_REMOTE_CODE_TARGETS
      else process.env.MCP_REMOTE_CODE_TARGETS = prev
    }
  })

  it("parses bare targets array JSON", () => {
    const targets = parseTargetsJson([
      { name: "a", ssh: "ssh a@host", root: "/a" },
    ])
    assert.equal(targets.length, 1)
    assert.equal(targets[0].name, "a")
  })

  it("reads REMOTE_ROOT from environment", () => {
    const prevSsh = process.env.REMOTE_SSH
    const prevRoot = process.env.REMOTE_ROOT
    process.env.REMOTE_SSH = "ssh env@host"
    process.env.REMOTE_ROOT = "/env/root"
    try {
      const startup = parseStartupConnection([])
      assert.equal(startup?.sshCommand, "ssh env@host")
      assert.equal(startup?.root, "/env/root")
    } finally {
      if (prevSsh === undefined) delete process.env.REMOTE_SSH
      else process.env.REMOTE_SSH = prevSsh
      if (prevRoot === undefined) delete process.env.REMOTE_ROOT
      else process.env.REMOTE_ROOT = prevRoot
    }
  })
})
