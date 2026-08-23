# MCP Remote Code

[English](./README.md)

MCP Remote Code 是一个通过 **stdio** 传输的 Model Context Protocol 服务器，用于通过 SSH 连接单台远程机器。它面向代理式远程开发：一个本地 MCP 进程、一个 SSH 目标、一个受限的根目录。

远程主机只需要 SSH 守护进程。MCP 服务器在本地运行，通过 `ssh2` 连接，并向 MCP 客户端（Cursor、Claude Desktop 等）暴露远程文件与 shell 工具。

## 特性

- **Stdio 传输** — 一个 MCP 客户端启动一个进程；无需 HTTP 守护进程或开放端口。
- **单主机模型** — 启动时使用 `--remote` 和 `--root` 连接。
- **根目录沙箱** — `remote_read`、`remote_write`、`remote_edit`、`remote_patch`、`remote_glob`、`remote_grep`、`remote_pull`、`remote_push` 均限制在 `--root` 之下（通过 `realpath` 检查符号链接）。
- **确认的 bash 逃逸** — `remote_bash` 默认在根目录运行；若需确认可能离开沙箱的命令，需 `outside=true` 并两步 `force` 确认。
- **文件传输** — `remote_pull` / `remote_push`，大文件传输需确认。

## 要求

- Node.js >= 20
- 远程机器上可访问的 SSH 服务
- 用于文件工具的类 POSIX shell

远程机器**不需要** Node.js、MCP 软件或代理运行时。

## 安装

```bash
npm install
npm run build
npm install -g .
```

全局命令：

```bash
mcp-remote-code --remote "ssh user@host" --root /home/project
```

## Cursor / Claude Desktop 配置

推荐在 `mcp.json` / `claude_desktop_config.json` 的 `args` 中配置所有目标：

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
        "--name", "alpha"
      ]
    }
  }
}
```

| 参数 | 含义 |
| --- | --- |
| `--ssh` | `user@host`（重复以添加多个目标） |
| `--key` | 身份文件（`-i`） |
| `--path` | 远程沙箱根目录 |
| `--name` | 可选目标名称 |

仍支持别名：`--remote`（同 `--ssh`，也支持 `user@host:/path` 简写）、`--root` / `--workdir`（同 `--path`）。

## 命令行

```bash
mcp-remote-code --ssh user@host --key ~/.ssh/id_rsa --path /home/project
```

| 参数 | 含义 |
| --- | --- |
| `--ssh` | SSH 目标（可重复） |
| `--key` | 身份文件 |
| `--path` | 沙箱根目录 |
| `--remote` | `--ssh` 的别名 |
| `--root` | `--path` 的别名 |
| `--workdir` | `--path` 的别名 |
| `--password` | SSH 密码 |
| `--sudo-password` | sudo 密码 |

## 根目录沙箱（文件工具）

所有文件工具严格限制在 `--root` 内：

- 相对路径解析到根目录下。
- 绝对路径规范化后必须仍在根目录内。
- 对已存在路径使用远程 `realpath` / `readlink -f`，防止符号链接逃逸。
- 文件工具**没有** `force` 逃逸。

## Bash（`remote_bash`）

| 调用 | 行为 |
| --- | --- |
| `remote_bash({ command })` | 在 `cwd = root` 下运行。 |
| `cwd` 在根目录内 | 在该目录运行。 |
| `outside: true` 或 `cwd` 在根目录外 | 两步确认（10 分钟内第二次调用带 `force: true`）。 |

**注意：** bash **不会**解析命令字符串做沙箱。例如 `cat /etc/passwd` 在未设 `outside` 时仍可能执行。沙箱针对文件工具；bash 确认是策略门，不是内核级隔离。

## 工具

- `remote_bash`
- `remote_glob`
- `remote_grep`
- `remote_read`
- `remote_write`
- `remote_edit`
- `remote_patch`
- `remote_pull`
- `remote_push`

## 开发

```bash
npm install
npm run lint
npm run build
npm test
npm run test:docker   # 需要 Docker
```

## 许可证

MIT
