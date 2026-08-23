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

## Cursor / Claude Desktop configuration

Put all targets in `mcp.json` / `claude_desktop_config.json` so every agent shares the same config:

```json
{
  "mcpServers": {
    "remote-code": {
      "command": "node",
      "args": [
        "/path/to/mcp-remote-code/build/index.js",
        "--ssh", "user@host",
        "--key", "~/.ssh/id_rsa",
        "--path", "/home/project",
        "--name", "alpha",
        "--ssh", "user@host2",
        "--key", "~/.ssh/id_rsa",
        "--path", "/home/projects",
        "--name", "beta"
      ]
    }
  }
}
```

| Flag | Meaning |
| --- | --- |
| `--ssh` | `user@host` (repeat to add another target) |
| `--key` | Identity file (`-i`) for the preceding `--ssh` |
| `--path` | Remote jail root for the preceding `--ssh` |
| `--name` | Optional target name |

Aliases still supported: `--remote` (same as `--ssh`, also accepts `user@host:/path` shorthand), `--root` / `--workdir` (same as `--path`).

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
mcp-remote-code --ssh user@host --key ~/.ssh/id_rsa --path /home/project
```

| Flag | Meaning |
| --- | --- |
| `--ssh` | SSH target (repeat for multiple targets) |
| `--key` | Identity file for the preceding `--ssh` |
| `--path` | Root directory for the preceding `--ssh` |
| `--remote` | Alias for `--ssh` |
| `--root` | Alias for `--path` |
| `--name` | Target name for the preceding `--ssh` |
| `--config` | JSON file with a `targets` array |
| `--workdir` | Alias for `--path` |
| `--password` | SSH password |
| `--sudo-password` | Sudo password |

### Targets config file

Default path when no CLI targets are given:

```text
~/.opencode/mcp-remote-code-targets.json
```

Example:

```json
{
  "targets": [
    {
      "name": "dev",
      "ssh": "user@host.example",
      "key": "~/.ssh/id_rsa",
      "path": "/home/project"
    }
  ]
}
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
