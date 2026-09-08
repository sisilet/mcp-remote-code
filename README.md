# MCP Remote Code

[中文](./README.zh-CN.md)

MCP Remote Code is a **stdio** Model Context Protocol server for working with one or more remote machines over SSH. One local MCP process can hold multiple named targets, each with its own jailed root directory.

The remote host only needs an SSH daemon. The MCP server runs locally, connects with `ssh2`, and exposes remote file and shell tools to your MCP client (Cursor, Claude Desktop, etc.).

## Features

- **Stdio transport** — one MCP client spawns one process; no HTTP daemon or open port.
- **Multi-target** — connect multiple remotes in one process via repeated CLI flags or a JSON targets file.
- **Root jail** — file tools are restricted to each target's root (with `realpath` checks for symlinks).
- **Metadata and hashing** — `remote_stat` for file/directory properties; `remote_hash` (SHA-256) for quick content comparison.
- **Confirmed bash escape** — `remote_bash` runs in the root by default; `outside=true` plus a two-step `force` confirmation is required to acknowledge commands that may leave the jail.
- **File transfer** — `remote_pull` / `remote_push` with large-transfer confirmation.

## Requirements

- Node.js >= 20
- A reachable SSH server on the remote machine
- A POSIX-like remote shell for file tools

The remote machine does **not** need Node.js, MCP software, or an agent runtime.

## Install

```bash
npm install
npm run build
npm install -g .
```

Global command:

```bash
mcp-remote-code --remote "ssh user@host" --root /home/project
```

## Connection model

One SSH connection per target, with concurrency over channels (v3.0.0). SSH
multiplexes channels by design; this is what OpenSSH's `ControlMaster` does. The
previous 3+2 connection pool cost five handshakes and five remote `sshd`
processes per target.

Measured on a home LAN when this changed:

| Target | Connect before | after |
|---|---|---|
| Linux server (gigabit) | 462 ms | 116 ms |
| Synology DS220j (ARM, 512 MB) | 3597 ms | 400 ms |

`REMOTE_MAX_CHANNELS` (default 6) caps concurrent channels; OpenSSH's
`MaxSessions` defaults to 10 and counts SFTP sessions too, so the default leaves
headroom. Exceeding it yields "Channel open failure", which is retried.

The old `REMOTE_POOL_COMMAND_SIZE`, `REMOTE_POOL_FILE_SIZE` and
`REMOTE_POOL_STAGGER_MS` no longer apply and log a deprecation warning if set.

## Security model

**Host key verification** (default). The offered host key must already appear in
`~/.ssh/known_hosts`, matched with `ssh-keygen -F` so hashed entries and
`[host]:port` forms work. An unknown host or a changed key aborts the connection
with the fingerprint and the exact command to fix it. Per target:

```json
{ "name": "box", "host": "10.0.0.1", "hostKeyPolicy": "accept-new" }
```

- `verify` (default) — must be in known_hosts
- `accept-new` — record on first use, then verify (trust-on-first-use)
- `insecure` — accept anything, logs a warning. Equivalent to
  `-o StrictHostKeyChecking=no`.

**What the root jail does and does not cover.** The file tools (`remote_read`,
`remote_write`, `remote_edit`, `remote_patch`, `remote_push`, `remote_pull`,
`remote_stat`, `remote_hash`) resolve symlinks on the remote and refuse paths
outside the configured root. **`remote_bash` is not sandboxed**: only its working
directory is checked, and the command itself may reference any path the SSH user
can reach.

**Confirmation for commands outside the root.** When the MCP client supports
elicitation, a command whose working directory falls outside the root prompts
the *user*, and a decline refuses the command. When the client does not support
it, or it is switched off, the `outside`/`force` flags fall back to a model-side
acknowledgement — a speed bump, not an access control, since the model can
simply call twice. The tool says which of the two applied. Switch it off with
`MCP_ELICITATION=off`, or per target with `"elicitation": "off"`.

**The local mirror is scratch, not a checkout.** File tools stage content in a
local mirror directory. It is deleted and rebuilt whenever a target reconnects,
and it carries no freshness tracking, so nothing should treat it as a durable
copy of the remote tree.

**Secrets.** `password` and `sudoPassword` are stored in plaintext in the targets
file; the server warns on startup if that file is readable beyond the owner.
Prefer key auth and passwordless `sudo` (NOPASSWD) over both.

## Cursor / Claude Desktop configuration

Recommended: one shared targets file, referenced from mcp config:

```json
{
  "mcpServers": {
    "remote-code": {
      "command": "node",
      "args": [
        "/path/to/mcp-remote-code/build/index.js",
        "--config",
        "/Users/you/.mcp-remote-code/targets.json"
      ]
    }
  }
}
```

`~/.mcp-remote-code/targets.json` example:

```json
{
  "targets": [
    {
      "name": "alpha",
      "user": "user",
      "host": "host.example",
      "key": "~/.ssh/id_rsa",
      "path": "/home/project"
    },
    {
      "name": "phone",
      "user": "root",
      "host": "192.168.0.10",
      "port": 8022,
      "key": "~/.ssh/phone",
      "path": "/mnt/android",
      "optional": true
    },
    {
      "name": "workspace",
      "type": "local",
      "path": "/Users/you/projects/my-app"
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Target id for tool calls |
| `type` | no | `"local"` for a local directory; omit/`"ssh"` for remote |
| `host` + `user` | yes* | SSH destination (`ssh` string also accepted) |
| `path` | yes | Jail root (`root` / `workdir` aliases) |
| `key` | no | Identity file |
| `port` | no | SSH port (default 22) |
| `optional` | no | Soft-fail if this host is offline |
| `password` / `sudoPassword` | no | Auth secrets (prefer keys) |

\*Or use `"ssh": "user@host"` / `"ssh": "ssh -p 8022 user@host"` instead of `user`/`host`/`port`.

If `--config` is omitted and no CLI targets are given, the server loads `~/.mcp-remote-code/targets.json` automatically (legacy `~/.opencode/mcp-remote-code-targets.json` still works as fallback).

Legacy interleaved CLI flags still work:

```json
"args": [
  "/path/to/build/index.js",
  "--ssh", "user@host", "--key", "~/.ssh/id_rsa", "--path", "/home/project", "--name", "alpha"
]
```

Alternative: JSON env var:

```json
"env": {
  "MCP_REMOTE_CODE_TARGETS": "{\"targets\":[{\"ssh\":\"user@host\",\"key\":\"~/.ssh/id_rsa\",\"path\":\"/home/project\"}]}"
}
```

Legacy single-target environment variables (still supported):

| Variable | Meaning |
| --- | --- |
| `REMOTE_SSH` | SSH target (`user@host` or full `ssh ...`) |
| `REMOTE_KEY` | Identity file |
| `REMOTE_ROOT` / `REMOTE_PATH` | Remote root directory |
| `MCP_REMOTE_CODE_TARGETS` | JSON targets array/object |
| `REMOTE_PASSWORD` | SSH password |
| `REMOTE_SUDO_PASSWORD` | Password for sudo commands |

## CLI

```bash
mcp-remote-code --config ~/.mcp-remote-code/targets.json
```

| Flag | Meaning |
| --- | --- |
| `--config` | JSON targets file (recommended) |
| `--ssh` | SSH target (legacy; repeat for multiple targets) |
| `--key` | Identity file for the preceding `--ssh` |
| `--path` | Root directory for the preceding `--ssh` |
| `--remote` | Alias for `--ssh` |
| `--root` | Alias for `--path` |
| `--name` | Target name for the preceding `--ssh` |
| `--workdir` | Alias for `--path` |
| `--password` | SSH password |
| `--sudo-password` | Sudo password |

### Targets config file

Default path:

```text
~/.mcp-remote-code/targets.json
```

When multiple targets are connected, pass `target` on every tool call.

## Root jail (file tools)

All file tools are hard-restricted to `--root`:

- Relative paths are resolved under the root.
- Absolute paths must stay under the root after normalization.
- Existing paths are checked with remote `realpath` / `readlink -f` to block symlink escapes.
- There is **no** `force` escape for file tools.

## Bash (`remote_bash`)

| Call | Behavior |
| --- | --- |
| `remote_bash({ command })` | Runs with `cwd = root`. |
| `cwd` under root | Runs in that directory. |
| `outside: true` or `cwd` outside root | Two-step confirmation (`force: true` on second call within 10 minutes). |

**Important:** bash is **not** command-sandboxed. A command like `cat /etc/passwd` can still run without `outside` because the server does not parse command strings. The jail applies to file tools; bash confirmation is a policy gate, not a kernel sandbox.

## Tools

- `remote_stat`
- `remote_hash`
- `remote_bash`
- `remote_glob`
- `remote_grep`
- `remote_read`
- `remote_write`
- `remote_edit`
- `remote_patch`
- `remote_pull`
- `remote_push`

## Development

```bash
npm install
npm run lint
npm run build
npm test
npm run test:docker   # requires Docker
```

## License

MIT
