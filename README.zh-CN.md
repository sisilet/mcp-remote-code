# MCP Remote Code

[English](./README.md)

MCP Remote Code 是一个通过 **stdio** 传输的 Model Context Protocol 服务器，用于通过 SSH 连接远程机器。它面向代理式远程开发：一个本地 MCP 进程、一个或多个 SSH 目标，每个目标各有一个受限的根目录。

远程主机只需要 SSH 守护进程。MCP 服务器在本地运行，通过 `ssh2` 连接，并向 MCP 客户端（Cursor、Claude Desktop 等）暴露远程文件与 shell 工具。

## 特性

- **Stdio 传输** — 一个 MCP 客户端启动一个进程；无需 HTTP 守护进程或开放端口。
- **多目标** — 通过 `--config` 指向的 targets 文件连接任意数量的主机，工具调用以 `target` 参数选择；单主机仍可用 `--ssh` 与 `--path`。离线目标不会阻塞其他目标，并会在后续调用时自动重试。
- **根目录沙箱** — `remote_read`、`remote_write`、`remote_edit`、`remote_patch`、`remote_glob`、`remote_grep`、`remote_pull`、`remote_push` 均限制在 `--root` 之下（通过 `realpath` 检查符号链接）。
- **离开根目录需确认** — `remote_bash` 默认在根目录运行。工作目录位于根目录之外时，若客户端支持 MCP elicitation 则直接询问用户，用户拒绝即终止；否则回退为 `outside=true` 加两步 `force` 的模型端确认。
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

## 连接模型

每个目标一条 SSH 连接，并发通过 channel 实现（v3.0.0）。SSH 本来就以 channel 做多路复用，
OpenSSH 的 `ControlMaster` 正是如此。之前的 3+2 连接池，对每个目标要付出五次握手，
以及远端五个 `sshd` 进程。

改版当时在家庭局域网实测：

| 目标 | 改版前连接 | 改版后 |
|---|---|---|
| Linux 服务器（千兆） | 462 ms | 116 ms |
| Synology DS220j（ARM、512 MB） | 3597 ms | 400 ms |

`REMOTE_MAX_CHANNELS`（默认 6）限制同时打开的 channel 数量。OpenSSH 的 `MaxSessions`
默认为 10，且 SFTP 会话也计入其中，因此默认值留有余量。超出时服务器会返回
“Channel open failure”，程序会自动重试。

旧的 `REMOTE_POOL_COMMAND_SIZE`、`REMOTE_POOL_FILE_SIZE` 和 `REMOTE_POOL_STAGGER_MS`
已失效，若仍然设置会输出弃用警告。

## 安全模型

**主机密钥验证**（默认启用）。服务器提供的密钥必须已存在于 `~/.ssh/known_hosts` 中，
使用 `ssh-keygen -F` 比对，因此哈希过的条目与 `[host]:port` 形式都能正确处理。
未知主机或密钥变更会中止连接，并显示指纹和修复命令。可按目标设置：

```json
{ "name": "box", "host": "10.0.0.1", "hostKeyPolicy": "accept-new" }
```

- `verify`（默认）— 必须已在 known_hosts 中
- `accept-new` — 首次连接时记录，之后验证（TOFU）
- `insecure` — 接受任何密钥并输出警告，等同于 `-o StrictHostKeyChecking=no`

**根目录沙箱的覆盖范围。** 文件工具（`remote_read`、`remote_write`、`remote_edit`、
`remote_patch`、`remote_push`、`remote_pull`、`remote_stat`、`remote_hash`）会在远端
解析符号链接，并拒绝根目录之外的路径。**`remote_bash` 并未沙箱化**：只有工作目录
受到限制，命令本身可以访问该 SSH 用户能够触及的任何路径。

**用户确认。** 触及根目录之外的命令会通过 MCP elicitation 询问用户。若客户端不支持，
或配置为关闭，则回退到模型端的确认机制，并在响应中明确说明未曾询问用户。
可用 `MCP_ELICITATION=off` 全局关闭，或在目标中设置 `"elicitation": "off"`。

**本地镜像是临时暂存，而非工作副本。** 文件工具会在本地镜像目录中暂存内容。目标每次
重新连接时该目录都会被删除重建，且不做新鲜度校验，因此不应将其视为远端目录树的持久副本。

**敏感信息。** `password` 与 `sudoPassword` 以明文存放在 targets 文件中；若该文件权限
宽于所有者，启动时会发出警告。建议改用密钥认证和免密码 `sudo`（NOPASSWD）。

## Cursor / Claude Desktop 配置

推荐使用独立 targets 文件，在 mcp 配置里只引用路径：

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

`~/.mcp-remote-code/targets.json` 示例：

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
    }
  ]
}
```

未传 `--config` 且无 CLI 目标时，自动加载 `~/.mcp-remote-code/targets.json`。

## 命令行

```bash
mcp-remote-code --config ~/.mcp-remote-code/targets.json
```

| 参数 | 含义 |
| --- | --- |
| `--config` | JSON 目标文件（推荐） |
| `--ssh` | SSH 目标（遗留；可重复） |
| `--key` | 身份文件 |
| `--path` | 沙箱根目录 |
| `--remote` | `--ssh` 的别名 |
| `--root` | `--path` 的别名 |
| `--workdir` | `--path` 的别名 |
| `--name` | 目标名称 |
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
