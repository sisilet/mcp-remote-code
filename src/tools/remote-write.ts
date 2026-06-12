import fs from "fs/promises"
import path from "path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { createTwoFilesPatch } from "diff"
import type { ConnectionManager } from "../connection-manager.js"
import { readFileWithBom, joinBom, splitBom } from "../bom.js"
import { trimDiff } from "../diff-utils.js"

export function createRemoteWriteTool(
  server: McpServer,
  connectionManager: ConnectionManager
) {
  server.registerTool(
    "remote_write",
    {
      description: `Write content to a file on a remote machine.`,
      inputSchema: {
        machine: z.string().optional().describe("Name of the remote machine. If omitted and only one machine is connected, uses that machine."),
        content: z.string().describe("The content to write to the file"),
        filePath: z.string().describe("The absolute path to the file to write on the remote machine (must be absolute)"),
      },
    },
    async ({ machine, content, filePath }) => {
      const conn = connectionManager.get(machine)
      if (!conn) {
        return {
          content: [
            {
              type: "text" as const,
              text: machine
                ? `Connection "${machine}" not found. Use remote_list_machines to see available connections.`
                : "No remote machines connected. Use remote_connect to connect, or specify a machine name.",
            },
          ],
        }
      }

      let remotePath = path.posix.normalize(filePath)
      if (!path.posix.isAbsolute(remotePath)) {
        remotePath = path.posix.join(conn.pathMapper.remoteRoot, remotePath)
      }

      const localPath = conn.pathMapper.toLocal(remotePath)
      const existed = await fs.stat(localPath).then((s) => s.isFile(), () => false)

      let bom = false
      let oldContent = ""
      if (existed) {
        await conn.syncEngine.register(remotePath)
        await conn.syncEngine.pullAll()
        try {
          const existing = await readFileWithBom(fs, localPath)
          bom = existing.bom
          oldContent = existing.text
        } catch {}
      }
      bom = bom || splitBom(content).bom

      const diffPreview = existed
        ? generateDiffPreview(remotePath, oldContent, content)
        : `A ${remotePath}\n+ ${content.split("\n").slice(0, 10).join("\n+ ")}`

      console.error(`[remote_write] [${conn.name}] ${remotePath}${existed ? " (overwrite)" : " (new)"}`)
      console.error(diffPreview.slice(0, 500))

      await fs.mkdir(path.dirname(localPath), { recursive: true })
      await fs.writeFile(localPath, joinBom(content, bom), "utf-8")

      await conn.syncEngine.register(remotePath)
      await conn.syncEngine.pushAll()

      return {
        content: [
          {
            type: "text" as const,
            text: `[${conn.name}] Wrote file successfully.\nPath: ${remotePath}\nExists: ${existed}`,
          },
        ],
      }
    }
  )
}

function generateDiffPreview(filePath: string, oldText: string, newText: string): string {
  return trimDiff(createTwoFilesPatch(filePath, filePath, oldText, newText))
}
