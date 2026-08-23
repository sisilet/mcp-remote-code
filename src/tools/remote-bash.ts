import path from "path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { checkConfirmation } from "../confirmation.js"
import type { ConnectionManager } from "../connection-manager.js"
import { isUnderRoot } from "../root-jail.js"
import { requireConnection, targetSchema, textResult } from "../tool-utils.js"

export function evaluateBashExecution(
  root: string,
  cwd?: string,
  outside?: boolean
): { actualCwd: string; needsOutsideConfirm: boolean } {
  let actualCwd = root
  let needsOutsideConfirm = Boolean(outside)

  if (cwd) {
    let normalizedCwd = path.posix.normalize(cwd)
    if (!path.posix.isAbsolute(normalizedCwd)) {
      normalizedCwd = path.posix.normalize(path.posix.join(root, cwd))
    }
    actualCwd = normalizedCwd
    if (!isUnderRoot(root, actualCwd)) {
      needsOutsideConfirm = true
    }
  }

  return { actualCwd, needsOutsideConfirm }
}

export async function handleRemoteBash(
  connectionManager: ConnectionManager,
  args: {
    target?: string
    command: string
    description: string
    timeout?: number
    cwd?: string
    outside?: boolean
    force?: boolean
  }
) {
  const { target, command, description, timeout, cwd, outside, force } = args
  const connOrError = requireConnection(connectionManager, target)
  if ("errorText" in connOrError) {
    return textResult(connOrError.errorText)
  }
  const conn = connOrError

  const actualTimeout = timeout ?? 120_000
  if (actualTimeout < 0) {
    return textResult("Error: Timeout must be a non-negative number")
  }

  const root = conn.config.remoteWorkdir
  const { actualCwd, needsOutsideConfirm } = evaluateBashExecution(root, cwd, outside)
  const confirmationKey = ["bash-outside", command, actualCwd].join("\0")
  const outcome = checkConfirmation(
    confirmationKey,
    needsOutsideConfirm,
    force,
    () =>
      [
        "This command requires confirmation because it may access paths outside the configured root.",
        "",
        `Root: ${root}`,
        `Working directory: ${actualCwd}`,
        `Command: ${command}`,
        "",
        "Run remote_bash again with the same command/cwd/outside and force=true within 10 minutes to execute it.",
      ].join("\n"),
    () =>
      [
        "Outside command is preflighted but not confirmed.",
        "",
        `Command: ${command}`,
        `Working directory: ${actualCwd}`,
        "",
        "Run remote_bash again with force=true to execute it.",
      ].join("\n")
  )

  if (outcome.status === "pending" || outcome.status === "needs_force") {
    return textResult(outcome.message)
  }

  const result = await conn.sshPool.exec(command, {
    cwd: actualCwd,
    timeout: actualTimeout,
  })

  let stdout = result.stdout || ""
  let stderr = result.stderr || ""
  stderr = filterSshNoise(stderr)

  const stderrErrors = [
    "command not found",
    "no such file or directory",
    "permission denied",
    "sorry, you must have a tty to run sudo",
  ]
  const hasStderrError = stderrErrors.some((e) =>
    stderr.toLowerCase().includes(e)
  )

  if (result.exitCode !== 0 || hasStderrError) {
    const parts: string[] = []
    if (stdout.trim()) parts.push(stdout)
    if (stderr.trim()) parts.push(`stderr:\n${stderr}`)
    const message = parts.length > 0 ? parts.join("\n\n") : "(no output)"
    return textResult(
      `Command failed with exit code ${result.exitCode}:\n${command}\n\n${message}`
    )
  }

  let output = stdout
  if (stderr.trim()) {
    output += "\n\nstderr:\n" + stderr
  }
  if (!output.trim()) {
    output = "(no output)"
  }

  return textResult(`${description || "bash"}\n\n${output}`)
}

export function createRemoteBashTool(
  server: McpServer,
  connectionManager: ConnectionManager
) {
  server.registerTool(
    "remote_bash",
    {
      description: `Execute commands in a bash shell on the remote machine. Commands run in the configured root by default. Use outside=true (with force confirmation) to acknowledge commands that may access paths outside the root.`,
      inputSchema: {
        target: targetSchema,
        command: z.string().describe("The bash command to execute"),
        description: z.string().describe("A short description of what the command does"),
        timeout: z.number().optional().describe("Timeout in milliseconds (optional, default 120000)"),
        cwd: z.string().optional().describe("Working directory on the remote machine (must be under root unless outside=true)"),
        outside: z.boolean().optional().describe("Acknowledge that this command may access paths outside the configured root"),
        force: z.boolean().optional().describe("Set true only after an outside-command confirmation prompt"),
      },
    },
    async (args) => handleRemoteBash(connectionManager, args)
  )
}

const SSH_NOISE_PATTERNS = [
  /^Warning: Permanently added .* to the list of known hosts\.\s*$/,
  /^\*\* WARNING: connection is not using a post-quantum key exchange algorithm\.\s*$/,
  /^\*\* This session may be vulnerable to "store now, decrypt later" attacks\.\s*$/,
  /^\*\* The server may need to be upgraded\. See https:\/\/openssh\.com\/pq\.html\s*$/,
  /^Connection to .* closed\.\s*$/,
]

function filterSshNoise(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !SSH_NOISE_PATTERNS.some((p) => p.test(line)))
    .join("\n")
}
