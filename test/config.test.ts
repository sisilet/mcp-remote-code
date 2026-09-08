import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildRemoteConfig,
  loadTargetsFromEnv,
  parseStartupConnection,
  parseStartupConnections,
  parseTargetsJson,
  validateStartupConnection,
} from "../src/config.js"

describe("config", () => {
  it("parses structured host/user/port JSON targets", () => {
    const targets = parseTargetsJson({
      targets: [
        {
          name: "phone",
          user: "root",
          host: "192.168.0.10",
          port: 8022,
          key: "~/.ssh/phone",
          path: "/mnt/android",
          optional: true,
        },
      ],
    })
    assert.equal(targets[0].name, "phone")
    assert.equal(targets[0].root, "/mnt/android")
    assert.equal(targets[0].optional, true)
    assert.match(targets[0].sshCommand, /ssh -i .+phone -p 8022 root@192\.168\.0\.10/)
  })

  it("parses local targets from JSON", () => {
    const targets = parseTargetsJson({
      targets: [
        {
          name: "mcp-remote-code",
          type: "local",
          path: "/Users/eric.f/projects/mcp-remote-code",
        },
      ],
    })
    assert.equal(targets[0].name, "mcp-remote-code")
    assert.equal(targets[0].type, "local")
    assert.equal(targets[0].root, "/Users/eric.f/projects/mcp-remote-code")
    assert.equal(targets[0].sshCommand, "")
  })

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

// D-C: no implicit user. A typo in the config must not silently connect as root.
describe("mandatory user (D-C)", () => {
  it("rejects a target without a user", () => {
    assert.throws(
      () => parseTargetsJson({ targets: [{ name: "box", host: "10.0.0.1", path: "/tmp" }] }),
      /"user" is required/
    )
  })

  it("accepts user@host in the host field", () => {
    const [c] = parseTargetsJson({
      targets: [{ name: "box", host: "alice@10.0.0.1", path: "/tmp" }],
    })
    assert.match(c.sshCommand, /alice@10\.0\.0\.1/)
  })

  it("accepts an explicit user field", () => {
    const [c] = parseTargetsJson({
      targets: [{ name: "box", user: "bob", host: "10.0.0.1", path: "/tmp" }],
    })
    assert.match(c.sshCommand, /bob@10\.0\.0\.1/)
  })
})

// F-13: structured entries must not round-trip through an ssh string. Building
// `ssh -i <path> user@host` and re-parsing loses any path containing a space.
describe("structured config is canonical (F-13)", () => {
  it("preserves a key path containing spaces", () => {
    const [t] = parseTargetsJson({
      targets: [{ name: "sp", user: "alice", host: "10.0.0.1", port: 2222,
                  key: "/tmp/my keys/id_ed25519", path: "/srv" }],
    })
    const c = buildRemoteConfig(t.sshCommand, t.root, { connection: t.connection })
    assert.equal(c.identity, "/tmp/my keys/id_ed25519")
    assert.equal(c.host, "10.0.0.1")
    assert.equal(c.user, "alice")
    assert.equal(c.port, 2222)
  })

  it("still supports the ssh-string form", () => {
    const [t] = parseTargetsJson({
      targets: [{ name: "s2", ssh: "ssh -p 2200 bob@10.0.0.2", path: "/srv" }],
    })
    const c = buildRemoteConfig(t.sshCommand, t.root, { connection: t.connection })
    assert.equal(c.user, "bob")
    assert.equal(c.host, "10.0.0.2")
    assert.equal(c.port, 2200)
  })

  it("keeps user@host in the host field working", () => {
    const [t] = parseTargetsJson({
      targets: [{ name: "s3", host: "carol@10.0.0.3", path: "/srv" }],
    })
    const c = buildRemoteConfig(t.sshCommand, t.root, { connection: t.connection })
    assert.equal(c.user, "carol")
    assert.equal(c.host, "10.0.0.3")
  })
})
