# 🌐 MCP Remote Code

[🌏 English](./README.md)

MCP Remote Code 是一个独立的 Model Context Protocol 服务器，用来通过 SSH 操作远端机器。它的核心定位不是远端服务器运维，而是让 agent 能像操作本地项目一样顺畅地开发远端项目。

最有特色的工具是 agent 日常写代码时真正依赖的这一组：

- `remote_glob`
- `remote_grep`
- `remote_read`
- `remote_write`
- `remote_edit`
- `remote_patch`

很多已有 SSH MCP server 主要提供远端 bash，最多再加上文件 pull/push。这对服务器运维是够用的，但会迫使 agent 用临时 shell 管道去处理源文件。MCP Remote Code 则直接暴露参考 OpenCode 原生 glob、grep、read、write、edit、patch 工具设计的远端文件工具，让 agent 操作远端项目时更接近本地开发体验。

远端机器仍然保持零侵入：只需要 SSH 服务，不需要安装 agent、Node.js 或额外守护进程。MCP server 在本机运行，使用 `ssh2` 维护持久 SSH/SFTP 连接，并把远端能力暴露成带命名空间的 MCP 工具。

## 💡 制作动机

这个项目的根本动机和最初的 [OpenCode 远端插件](https://github.com/zz6zz666/opencode-remote-code) 一致：很多重要的远程开发机器太老、权限太受限，或者环境太特殊，无法安装 agent runtime。

这类情况常见于远端虚拟机、实验室机器、EDA 工作站、嵌入式 Linux 目标机和老旧服务器。它们可能没有现代 Node.js，也不适合运行常驻 agent 进程、语言服务器或额外索引服务。但 agent 仍然需要稳定地执行命令、搜索代码、读取文件、编辑文件、应用 patch，以及传输必要的产物。

OpenCode 插件验证了这种远端开发工作流，但插件绑定在 OpenCode 生态里，并且刻意把远端机器完全伪装成本地工作区。这个模式下，agent 的运行时环境完全在远端，无法自然感知和访问本地目录。

MCP server 的拆分目标有两点：

- 将这套 SSH 远端开发工具从单一客户端生态中拆出来；
- 支持本地工作和远端工作协同，而不是只能完全伪装成远端本地机。

例如模拟 IC 工程师可以在本地创建设计笔记、查询 gm/ID 查找表、迭代尺寸脚本；同时让 agent 在远端 EDA 机器上运行 Spectre 验证和仿真迭代。纯远端 bash 型 MCP server 对这种工作流太底层，完全远端伪装的插件又不能自然使用本地工作区。本项目面向的就是这个中间地带。

## ✨ 功能

- 多机器连接管理。
- 机器模板保存到 `~/.opencode/mcp-remote-code-configs.json`。
- 通过 `remote_connect` 按需连接远端机器。
- 支持 CLI 参数或环境变量启动时自动连接。
- 持久 SSH 命令连接池和 SFTP 连接池。
- 远端命令、glob、grep、read、write、edit、patch 工具。
- 显式绝对路径文件传输工具：
  - `remote_pull`：远端文件/目录下载到本机绝对路径。
  - `remote_push`：本机文件/目录上传到远端绝对路径。
- 大文件/大目录传输预检警告，需要第二次 `force` 确认。
- 支持当前 MCP 客户端使用的 Streamable HTTP。
- 保留旧 HTTP+SSE 客户端兼容。

## 📋 环境要求

- Node.js >= 20。
- 每台远端机器需要可访问的 SSH 服务。
- 文件工具假设远端有类 POSIX shell。

远端机器不需要 Node.js、MCP 软件、agent、`rsync` 或 `sshpass`。

## 🚀 安装

从源码目录安装：

```bash
npm install
npm run build
npm install -g .
```

全局安装后命令为：

```bash
mcp-remote-code
```

## ▶️ 启动服务

默认本地 daemon：

```bash
mcp-remote-code
```

指定监听地址：

```bash
mcp-remote-code --port 3000 --host 127.0.0.1
```

安全说明：服务器没有内置认证。除非你自行放在可信网络边界后面，否则请保持默认 `127.0.0.1` 绑定。不要直接暴露到公网。

## 🔌 MCP 端点

| Endpoint | 用途 |
| --- | --- |
| `http://127.0.0.1:3000/sse` | 兼容端点，支持 Streamable HTTP POST/GET/DELETE 和旧 SSE GET。 |
| `http://127.0.0.1:3000/mcp` | 当前 MCP 客户端使用的 Streamable HTTP 端点。 |
| `http://127.0.0.1:3000/message` | 旧 HTTP+SSE message 端点。 |
| `http://127.0.0.1:3000/health` | 健康检查和状态 JSON。 |

大多数 MCP 客户端可使用：

```json
{
  "mcpServers": {
    "remote-code": {
      "url": "http://127.0.0.1:3000/sse"
    }
  }
}
```

## 🖥️ 机器配置

机器模板保存位置：

```text
~/.opencode/mcp-remote-code-configs.json
```

从 MCP 客户端添加机器：

```text
remote_add_config(
  name: "dev",
  ssh: "ssh -oHostKeyAlgorithms=+ssh-rsa user@host",
  workdir: "/home/project",
  password: "optional-password"
)
```

之后连接：

```text
remote_connect(machine: "dev")
```

模板中的密码会保存在本机 JSON 配置文件中。请为该文件设置符合你使用场景的本机文件权限。

## ⚡ 启动时自动连接

也可以在 daemon 启动时立即连接远端机器。启动连接不会保存成模板。

```bash
mcp-remote-code \
  --remote "ssh -i ~/.ssh/id_rsa user@host" \
  --workdir /home/project \
  --name dev
```

环境变量形式：

```bash
export REMOTE_SSH='ssh user@host'
export REMOTE_WORKDIR='/home/project'
export REMOTE_NAME='dev'
mcp-remote-code
```

支持的启动环境变量：

| 变量 | 含义 |
| --- | --- |
| `REMOTE_SSH` | SSH 命令字符串。 |
| `REMOTE_WORKDIR` | 远端工作目录。 |
| `REMOTE_NAME` | 连接名，默认 `default`。 |
| `REMOTE_PASSWORD` | SSH 密码。 |
| `REMOTE_SUDO_PASSWORD` | sudo 命令使用的密码。 |

## 🔑 SSH 命令支持

SSH 命令字符串必须以 `ssh` 开头。会解析常见 OpenSSH 风格参数：

- `-p <port>` 或 `-p<port>`
- `-i <identity_file>` 或 `-i<identity_file>`
- `-l <user>` 或 `-l<user>`
- `-o Key=Value`

已识别的 `-o` 值包括：

- `Port`
- `User`
- `IdentityFile`
- `HostKeyAlgorithms`
- `StrictHostKeyChecking=no`

本服务器不会调用外部 `ssh` 二进制。`ProxyJump`、`ProxyCommand`、自定义 `ssh_config` 等高级 OpenSSH 客户端能力当前没有在本包中实现。

## 🧰 工具列表

连接和配置工具：

- `remote_add_config`
- `remote_remove_config`
- `remote_list_configs`
- `remote_connect`
- `remote_disconnect`
- `remote_list_machines`

远端操作工具：

- `remote_bash`
- `remote_glob`
- `remote_grep`
- `remote_read`
- `remote_write`
- `remote_edit`
- `remote_patch`
- `remote_pull`
- `remote_push`

所有远端操作工具都接受可选 `machine` 参数。若省略且当前只有一台机器连接，则自动使用该机器。

## 📦 文件传输

`remote_pull` 和 `remote_push` 都要求显式绝对路径。MCP server 不会从自己的启动目录推断 agent workspace。

### Pull

将远端文件或目录下载到本机绝对路径：

```text
remote_pull(
  machine: "dev",
  remotePath: "/home/project/logs",
  localPath: "/home/me/project/artifacts/logs"
)
```

规则：

- `remotePath` 必须是远端绝对路径。
- `localPath` 必须是本机绝对路径。
- Windows 下应使用完整限定路径，例如 `C:\work\project\artifact.bin` 或 UNC 路径，不要使用 `\artifact.bin` 这种依赖当前盘符的路径。
- 目录会递归复制，并保留内部结构。
- 支持二进制文件。
- 同路径本地文件会被覆盖。
- 不会删除本地多余文件。

### Push

将本机文件或目录上传到远端绝对路径：

```text
remote_push(
  machine: "dev",
  localPath: "/home/me/project/artifacts/logs",
  remotePath: "/home/project/logs"
)
```

规则：

- `localPath` 必须是本机绝对路径。
- `remotePath` 必须是远端绝对路径。
- 目录会递归上传，并保留内部结构。
- 支持二进制文件。
- symlink 和其他特殊本地文件类型不会上传。
- 同路径远端文件会被覆盖。
- 不会删除远端多余文件。

### 大传输确认

Pull 和 push 都使用两步确认机制。

默认阈值：

- 大小阈值：`25 MB`。
- 文件数量阈值：`500` 个文件。
- 确认窗口：`10` 分钟。

首次大传输调用只返回计划信息，包括类型、字节数、文件数、目录数、源路径和目标路径；不会传输数据，即使第一次就带了 `force: true`。在确认窗口内用相同参数再次调用，并加上 `force: true`，才会真正执行。

环境变量覆盖：

| 方向 | 大小阈值 | 文件阈值 |
| --- | --- | --- |
| Pull | `REMOTE_PULL_WARN_BYTES` | `REMOTE_PULL_WARN_FILES` |
| Push | `REMOTE_PUSH_WARN_BYTES` | `REMOTE_PUSH_WARN_FILES` |

## 🛠️ 开发

```bash
npm install
npm run lint
npm run build
npm pack --dry-run
```

npm 包包含 `build/`、`README.md` 和 `README.zh-CN.md`。

## 🗂️ 仓库结构

这个 MCP server 是独立仓库。开发时它可以放在 OpenCode 插件仓库旁边，甚至临时嵌套在插件 checkout 里，但它的 `.git`、package metadata、README 文件和 npm build 产物都是独立的。

## License

MIT
