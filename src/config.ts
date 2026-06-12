import os from "os"
import path from "path"

export interface RemoteConfig {
  sshCommand: string
  host: string
  user: string
  port: number
  identity?: string
  extraOptions: string[]
  password?: string
  sudoPassword?: string
  remoteWorkdir: string
  mirrorRoot: string
  active: boolean
}

export function parseSshCommand(cmd: string): {
  host: string
  user: string
  port: number
  identity?: string
  extraOptions: string[]
} {
  const tokens = tokenizeCommand(cmd)
  if (tokens.length === 0 || tokens[0] !== "ssh") {
    throw new Error(`Remote Code: SSH command must start with "ssh", got: ${cmd}`)
  }

  let host = ""
  let user = ""
  let port = 22
  let identity: string | undefined
  const extraOptions: string[] = []

  const applyOpenSshOption = (option: string) => {
    extraOptions.push(option)
    const { key, value } = parseOpenSshOption(option)
    switch (key.toLowerCase()) {
      case "port": {
        const parsed = parseInt(value, 10)
        if (isNaN(parsed)) throw new Error(`Remote Code: invalid Port option in SSH command`)
        port = parsed
        break
      }
      case "user":
        user = value
        break
      case "identityfile":
        identity = expandLocalPath(value)
        break
    }
  }

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === "-p" || tok === "--port") {
      const value = nextValue(tokens, ++i, tok)
      port = parseInt(value, 10)
      if (isNaN(port)) throw new Error(`Remote Code: invalid port in SSH command`)
    } else if (tok.startsWith("-p") && tok.length > 2) {
      port = parseInt(tok.slice(2), 10)
      if (isNaN(port)) throw new Error(`Remote Code: invalid port in SSH command`)
    } else if (tok === "-i") {
      identity = expandLocalPath(nextValue(tokens, ++i, tok))
    } else if (tok.startsWith("-i") && tok.length > 2) {
      identity = expandLocalPath(tok.slice(2))
    } else if (tok.startsWith("-o")) {
      if (tok === "-o") {
        applyOpenSshOption(nextValue(tokens, ++i, tok))
      } else {
        applyOpenSshOption(tok.slice(2))
      }
    } else if (tok === "-l") {
      user = nextValue(tokens, ++i, tok)
    } else if (tok.startsWith("-l") && tok.length > 2) {
      user = tok.slice(2)
    } else if (tok.startsWith("-")) {
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        i++
      }
    } else if (tok.includes("@")) {
      const at = tok.lastIndexOf("@")
      user = tok.slice(0, at)
      host = tok.slice(at + 1)
    } else {
      host = tok
    }
  }

  if (!host) {
    throw new Error(`Remote Code: could not parse host from SSH command: ${cmd}`)
  }
  if (!user) {
    user = "root"
  }

  return { host, user, port, identity, extraOptions }
}

function parseOpenSshOption(option: string): { key: string; value: string } {
  const eq = option.indexOf("=")
  if (eq === -1) {
    return { key: option.trim(), value: "" }
  }
  return {
    key: option.slice(0, eq).trim(),
    value: option.slice(eq + 1).trim(),
  }
}

function nextValue(tokens: string[], index: number, option: string): string {
  const value = tokens[index]
  if (!value) {
    throw new Error(`Remote Code: missing value for SSH option ${option}`)
  }
  return value
}

function expandLocalPath(input: string): string {
  if (input === "~") {
    return os.homedir()
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2))
  }
  return input
}

function tokenizeCommand(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  const text = input.trim()

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (ch === "\\" && quote !== "'") {
      const next = text[i + 1]
      if (next && /[\s"'\\]/.test(next)) {
        current += next
        i++
        continue
      }
      current += ch
      continue
    }

    if (quote) {
      if (ch === quote) {
        quote = undefined
      } else {
        current += ch
      }
      continue
    }

    if (ch === "'" || ch === `"`) {
      quote = ch
      continue
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += ch
  }

  if (quote) {
    throw new Error(`Remote Code: unterminated quote in SSH command: ${input}`)
  }
  if (current) {
    tokens.push(current)
  }

  return tokens
}

export function buildRemoteConfig(
  sshCommand: string,
  remoteWorkdir: string,
  options?: {
    password?: string
    sudoPassword?: string
    mirrorRoot?: string
  }
): RemoteConfig {
  const parsed = parseSshCommand(sshCommand)
  const mirrorRoot = options?.mirrorRoot ?? path.join(os.homedir(), ".opencode", "mirrors")

  return {
    sshCommand,
    ...parsed,
    password: options?.password,
    sudoPassword: options?.sudoPassword,
    remoteWorkdir,
    mirrorRoot,
    active: true,
  }
}

export interface StartupConnection {
  name: string
  sshCommand: string
  workdir: string
  password?: string
  sudoPassword?: string
}

export function parseStartupConnections(): StartupConnection[] {
  const connections: StartupConnection[] = []
  const argv = process.argv.slice(2)

  let current: StartupConnection | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === "--remote" || arg === "--connect") {
      if (current) connections.push(current)
      current = {
        name: "default",
        sshCommand: argv[++i],
        workdir: "",
      }
    } else if (current) {
      if (arg === "--workdir" || arg === "-w") {
        current.workdir = argv[++i]
      } else if (arg === "--name" || arg === "-n") {
        current.name = argv[++i]
      } else if (arg === "--password" || arg === "-p") {
        current.password = argv[++i]
      } else if (arg === "--sudo-password") {
        current.sudoPassword = argv[++i]
      }
    }
  }

  if (current) connections.push(current)

  // Fallback to environment variables for backward compatibility
  if (connections.length === 0 && process.env.REMOTE_SSH) {
    connections.push({
      name: process.env.REMOTE_NAME || "default",
      sshCommand: process.env.REMOTE_SSH,
      workdir: process.env.REMOTE_WORKDIR || "",
      password: process.env.REMOTE_PASSWORD,
      sudoPassword: process.env.REMOTE_SUDO_PASSWORD,
    })
  }

  return connections
}
