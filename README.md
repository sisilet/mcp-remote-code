# 🌐 MCP Remote Code

[🌏 中文](./README.zh-CN.md)

MCP Remote Code is a standalone Model Context Protocol server for working with
remote machines over SSH. Its main focus is agent-style remote development, not
only remote server administration.

The core tools are the ones coding agents normally rely on when working in a
local repository:

- `remote_glob`
- `remote_grep`
- `remote_read`
- `remote_write`
- `remote_edit`
- `remote_patch`

Many existing SSH MCP servers expose a remote shell, and sometimes file
download/upload helpers. That is useful for operations work, but it forces
agents to manipulate source files through ad-hoc shell pipelines. MCP Remote
Code instead exposes native agent-style file tools, modeled after OpenCode's
built-in glob, grep, read, write, edit, and patch tools, so editing a remote
project feels much closer to editing a local one.

The remote host stays clean: it only needs an SSH daemon. The MCP server runs
locally, maintains persistent SSH/SFTP connections with `ssh2`, and exposes
remote operations as namespaced MCP tools.

## 💡 Motivation

The primary motivation is the same as the original
[OpenCode remote plugin](https://github.com/zz6zz666/opencode-remote-code):
some important development machines are old, locked down, or specialized enough
that installing an agent runtime is not realistic.

This is common on remote VMs, lab machines, EDA workstations, embedded Linux
targets, and legacy servers. They may not have a modern Node.js, may not permit
long-running agent processes, and may not be suitable for extra language server
or indexing daemons. Agents still need stable ways to run commands, search
code, inspect files, edit files, apply patches, and move artifacts.

The OpenCode plugin proved the remote-development workflow, but it is bound to
the OpenCode ecosystem and deliberately masquerades the remote machine as the
agent's local workspace. In that model, the runtime environment is fully remote:
the agent cannot naturally see or use local directories.

The MCP server has two different goals:

- detach the SSH remote-development tools from a single client ecosystem; and
- support workflows where local and remote work need to cooperate.

For example, an analog IC engineer might keep design notes locally, query local
gm/ID lookup tables, and iterate sizing scripts on the local workstation, while
asking the agent to run Spectre verification and simulation iterations on a
remote EDA machine. A pure "remote shell only" MCP server is too low-level for
that workflow, and a fully remote-masquerading plugin cannot naturally use the
local workspace. This project is designed for that middle ground.

## ✨ Features

- Multi-machine connection manager.
- Saved machine templates in `~/.opencode/mcp-remote-code-configs.json`.
- On-demand SSH connections with `remote_connect`.
- Startup auto-connect from CLI flags or environment variables.
- Persistent SSH command and SFTP connection pools.
- Remote command execution, glob, grep, read, write, edit, and patch tools.
- Explicit absolute-path file transfer tools:
  - `remote_pull`: remote file/directory to local absolute path.
  - `remote_push`: local file/directory to remote absolute path.
- Large-transfer preflight warnings with second-call `force` confirmation.
- Streamable HTTP transport for current MCP clients.
- Legacy HTTP+SSE compatibility for older MCP clients.

## 📋 Requirements

- Node.js >= 20.
- A reachable SSH server on each remote machine.
- A POSIX-like remote shell for file tools.

The remote machine does not need Node.js, MCP software, an agent, `rsync`, or
`sshpass`.

## 🚀 Install

From a checkout:

```bash
npm install
npm run build
npm install -g .
```

When installed globally, the command is:

```bash
mcp-remote-code
```

## ▶️ Start The Server

Default local daemon:

```bash
mcp-remote-code
```

Custom bind address:

```bash
mcp-remote-code --port 3000 --host 127.0.0.1
```

Security note: this server has no built-in authentication. Keep the default
`127.0.0.1` binding unless you place it behind your own trusted network
boundary. Do not expose it directly to the internet.

## 🔌 MCP Endpoints

| Endpoint | Purpose |
| --- | --- |
| `http://127.0.0.1:3000/sse` | Compatible endpoint. Accepts Streamable HTTP POST/GET/DELETE and legacy SSE GET. |
| `http://127.0.0.1:3000/mcp` | Streamable HTTP endpoint for current MCP clients. |
| `http://127.0.0.1:3000/message` | Legacy HTTP+SSE message endpoint. |
| `http://127.0.0.1:3000/health` | Health and status JSON. |

Most MCP clients can use:

```json
{
  "mcpServers": {
    "remote-code": {
      "url": "http://127.0.0.1:3000/sse"
    }
  }
}
```

## 🖥️ Machine Configs

Saved machine templates live at:

```text
~/.opencode/mcp-remote-code-configs.json
```

Add a machine from an MCP client:

```text
remote_add_config(
  name: "dev",
  ssh: "ssh -oHostKeyAlgorithms=+ssh-rsa user@host",
  workdir: "/home/project",
  password: "optional-password"
)
```

Connect later:

```text
remote_connect(machine: "dev")
```

Passwords in saved templates are stored in the local JSON config file. Use
file-system permissions appropriate for your machine.

## ⚡ Startup Auto-Connect

You can connect a machine as the daemon starts. Startup connections are not
saved as templates.

```bash
mcp-remote-code \
  --remote "ssh -i ~/.ssh/id_rsa user@host" \
  --workdir /home/project \
  --name dev
```

Environment variable form:

```bash
export REMOTE_SSH='ssh user@host'
export REMOTE_WORKDIR='/home/project'
export REMOTE_NAME='dev'
mcp-remote-code
```

Supported startup variables:

| Variable | Meaning |
| --- | --- |
| `REMOTE_SSH` | SSH command string. |
| `REMOTE_WORKDIR` | Remote working directory. |
| `REMOTE_NAME` | Connection name, default `default`. |
| `REMOTE_PASSWORD` | SSH password. |
| `REMOTE_SUDO_PASSWORD` | Password used for sudo commands. |

## 🔑 SSH Command Support

The SSH command string must start with `ssh`. Common OpenSSH-style options are
parsed:

- `-p <port>` or `-p<port>`
- `-i <identity_file>` or `-i<identity_file>`
- `-l <user>` or `-l<user>`
- `-o Key=Value`

Recognized `-o` values include:

- `Port`
- `User`
- `IdentityFile`
- `HostKeyAlgorithms`
- `StrictHostKeyChecking=no`

This server does not spawn the external `ssh` binary. Advanced OpenSSH client
features such as `ProxyJump`, `ProxyCommand`, and custom `ssh_config` files are
not implemented by this package.

## 🧰 Tools

Connection and config tools:

- `remote_add_config`
- `remote_remove_config`
- `remote_list_configs`
- `remote_connect`
- `remote_disconnect`
- `remote_list_machines`

Remote operation tools:

- `remote_bash`
- `remote_glob`
- `remote_grep`
- `remote_read`
- `remote_write`
- `remote_edit`
- `remote_patch`
- `remote_pull`
- `remote_push`

All remote operation tools accept an optional `machine` parameter. If omitted
and exactly one machine is connected, that machine is used.

## 📦 File Transfer

`remote_pull` and `remote_push` require explicit absolute paths. The MCP server
does not infer the agent workspace from its own startup directory.

### Pull

Download a remote file or directory to a local absolute path:

```text
remote_pull(
  machine: "dev",
  remotePath: "/home/project/logs",
  localPath: "/home/me/project/artifacts/logs"
)
```

Rules:

- `remotePath` must be an absolute remote path.
- `localPath` must be an absolute local path.
- On Windows, use a fully qualified path such as
  `C:\work\project\artifact.bin` or a UNC path, not `\artifact.bin`.
- Directories are copied recursively and preserve their internal tree.
- Binary files are supported.
- Same-path local files are overwritten.
- Extra local files are not deleted.

### Push

Upload a local file or directory to a remote absolute path:

```text
remote_push(
  machine: "dev",
  localPath: "/home/me/project/artifacts/logs",
  remotePath: "/home/project/logs"
)
```

Rules:

- `localPath` must be an absolute local path.
- `remotePath` must be an absolute remote path.
- Directories are uploaded recursively and preserve their internal tree.
- Binary files are supported.
- Symlinks and special local file types are skipped.
- Same-path remote files are overwritten.
- Extra remote files are not deleted.

### Large Transfer Confirmation

Pull and push both use a two-step confirmation for large transfers.

Defaults:

- Size threshold: `25 MB`.
- File-count threshold: `500` files.
- Confirmation window: `10` minutes.

The first large-transfer call returns a plan with type, byte size, file count,
directory count, and source/destination paths. It does not transfer data, even
if `force: true` is already present. Repeat the same call with `force: true`
within the confirmation window to proceed.

Environment overrides:

| Direction | Size threshold | File threshold |
| --- | --- | --- |
| Pull | `REMOTE_PULL_WARN_BYTES` | `REMOTE_PULL_WARN_FILES` |
| Push | `REMOTE_PUSH_WARN_BYTES` | `REMOTE_PUSH_WARN_FILES` |

## 🛠️ Development

```bash
npm install
npm run lint
npm run build
npm pack --dry-run
```

The npm package includes `build/`, `README.md`, and `README.zh-CN.md`.

## 🗂️ Repository Layout

This MCP server is a standalone repository. It may live next to, or inside a
checkout of, an OpenCode plugin during development, but its `.git` directory,
package metadata, README files, and npm build artifacts are independent.

## License

MIT
