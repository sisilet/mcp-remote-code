import type { ConnectionInfo } from "./connection-manager.js"

export function buildServerInstructions(targets: ConnectionInfo[]): string {
  const rootList = targets.map((info) => `${info.name}=${info.workdir}`).join(", ")

  const lines = [
    "MCP Remote Code is connected to remote machine(s) over SSH.",
    "",
    `Targets (${targets.length}):`,
  ]

  for (const info of targets) {
    lines.push(
      `- ${info.name}: ${info.user}@${info.host}:${info.port}, root=${info.workdir}, platform=${info.platform}, git=${info.isGitRepo ? "yes" : "no"}`
    )
  }

  if (targets.length > 1) {
    lines.push("", "When multiple targets are configured, pass the target parameter on every tool call.")
  }

  lines.push(
    "",
    "Agent policy — stay inside the configured root:",
    `- Treat each target's root as the ONLY writable workspace: ${rootList}.`,
    "- Do NOT use file tools to read, create, modify, delete, search, stat, hash, pull, or push paths outside that target's root.",
    "- Prefer paths relative to the root (e.g. src/main.ts) instead of absolute paths.",
    "- Do NOT attempt to bypass the jail with .., symlinks, or absolute paths outside the root. The server rejects these.",
    "- If the user asks to change files outside the root, say it is not allowed by this server and ask them to widen --root or use a different target.",
    "- Use remote_read / remote_write / remote_edit / remote_patch for file changes. Do NOT use remote_bash (sed, tee, rm, mv, etc.) to modify project files when a file tool exists.",
    "",
    "File tools (remote_read, remote_write, remote_edit, remote_patch, remote_glob, remote_grep, remote_pull, remote_push, remote_stat, remote_hash):",
    "- All remote paths must stay under each target's root.",
    "- Relative paths are resolved under the root.",
    "- Symlink escapes are blocked via realpath checks.",
    "- There is no force escape for file tools.",
    "",
    "remote_stat:",
    "- Returns file or directory metadata (type, size, permissions, timestamps, symlink target).",
    "",
    "remote_hash:",
    "- Returns SHA-256 for a file. Use the same path on two targets (or compare with a local hash) to verify content quickly.",
    "",
    "remote_bash:",
    "- Default working directory is the target root.",
    "- Use bash only for builds, tests, package installs, and other commands that are not covered by file tools.",
    "- Do NOT use remote_bash to edit, create, or delete source files inside the project when file tools are available.",
    "- Use outside=true and a two-step force confirmation only when the user explicitly needs commands outside the root.",
    "- Commands are not parsed; bash is not command-sandboxed. Prefer file tools to enforce the root boundary."
  )

  return lines.join("\n")
}
