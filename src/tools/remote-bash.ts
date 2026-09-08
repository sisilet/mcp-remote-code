import path from "path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { checkConfirmation } from "../confirmation.js"
import type { ConnectionManager } from "../connection-manager.js"
import { isUnderRoot } from "../root-jail.js"
import { requireConnection, targetSchema, textResult } from "../tool-utils.js"
import { confirmWithUser, resolveMode } from "../elicitation.js"

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
  const connOrError = await requireConnection(connectionManager, target)
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
        "This command is flagged because it may access paths outside the configured root. Note: this is a model-side acknowledgement, not a user prompt.",
        "",
        `Root: ${root}`,
        `Working directory: ${actualCwd}`,
        `Command: ${command}`,
        "",
        "Run remote_bash again with the same command/cwd/outside and force=true within 10 minutes to execute it.",
      ].join("\n"),
    () =>
      [
        "Outside command is preflighted but not acknowledged.",
        "",
        `Command: ${command}`,
        `Working directory: ${actualCwd}`,
        "",
        "Run remote_bash again with force=true to execute it.",
      ].join("\n")
  )

  if (needsOutsideConfirm) {
    // Prefer a real user prompt over the model-side acknowledgement (F-5).
    const mode = resolveMode((conn.config as any).elicitation)
    const verdict = await confirmWithUser(
      [
        `Run a command outside the configured root on "${conn.name}"?`,
        ``,
        `Root: ${root}`,
        `Working directory: ${actualCwd}`,
        `Command: ${command}`,
      ].join("\n"),
      mode
    )
    if (verdict.approved) {
      // User said yes: skip the model-side dance entirely.
      return runCommand()
    }
    if (verdict.via === "user-declined") {
      return textResult(
        `Declined by the user. The command was not run.\n\nCommand: ${command}`
      )
    }
    if (verdict.via === "error") {
      return textResult(
        `Could not obtain user confirmation (${verdict.detail}). The command was not run.`
      )
    }
    // "unsupported" or "disabled": fall through to the acknowledgement flow,
    // and be explicit that no human was asked.
    if (outcome.status === "pending" || outcome.status === "needs_force") {
      return textResult(
        outcome.message +
        `\n\n(No user prompt was shown: elicitation is ` +
        `${verdict.via === "disabled" ? "disabled in config" : "unsupported by this client"}.)`
      )
    }
  }

  if (outcome.status === "pending" || outcome.status === "needs_force") {
    return textResult(outcome.message)
  }

  return runCommand()

  async function runCommand() {

  const result = await conn.sshPool.exec(command, {
    cwd: actualCwd,
    timeout: actualTimeout,
    // Never re-run an arbitrary user command. If the connection drops after
    // partial execution, a retry would run it twice (review F-3). The error
    // surfaces to the caller, who knows whether the command is safe to repeat.
    retry: false,
  })

  let stdout = result.stdout || ""
  let stderr = result.stderr || ""
  stderr = filterSshNoise(stderr)

  // The exit code is the command's own verdict. Treating stderr text as
  // failure misreports commands that legitimately write to stderr while
  // succeeding: `find /` printing "Permission denied" for unreadable
  // directories still exits 0 and still returns useful results (review F-17).
  if (result.exitCode !== 0) {
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
}

export function createRemoteBashTool(
  server: McpServer,
  connectionManager: ConnectionManager
) {
  server.registerTool(
    "remote_bash",
    {
      description: `Execute commands in a bash shell on the remote machine. Commands run in the configured root by default.

IMPORTANT: only the working directory is constrained by the root. The command itself is NOT sandboxed and may reference any path the SSH user can reach. The outside/force flags are a model-side acknowledgement, not an access control. Use the file tools (remote_read, remote_write, remote_edit, remote_patch) when you need the root jail to be enforced.`,
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
