import fs from "fs/promises"
import path from "path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { createTwoFilesPatch } from "diff"
import type { ConnectionManager } from "../connection-manager.js"
import { jailRemotePath, requireConnection, targetSchema, textResult } from "../tool-utils.js"
import { readFileWithBom, joinBom, splitBom } from "../bom.js"
import { trimDiff } from "../diff-utils.js"

export function createRemoteWriteTool(
  server: McpServer,
  connectionManager: ConnectionManager
) {
  server.registerTool(
    "remote_write",
    {
      description: `Write content to a file on the remote machine within the configured root.`,
      inputSchema: {
        target: targetSchema,
        content: z.string().describe("The content to write to the file"),
        filePath: z.string().describe("The path to the file to write on the remote machine (absolute or relative to root)"),
      },
    },
    async ({ target, content, filePath }) => {
      const connOrError = requireConnection(connectionManager, target)
      if ("errorText" in connOrError) {
        return textResult(connOrError.errorText)
      }
      const conn = connOrError

      const jailed = await jailRemotePath(conn, filePath, { forNewFile: true })
      if ("errorText" in jailed) {
        return textResult(jailed.errorText)
      }
      const remotePath = jailed.path

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

      console.error(`[remote_write] ${remotePath}${existed ? " (overwrite)" : " (new)"}`)
      console.error(diffPreview.slice(0, 500))

      await fs.mkdir(path.dirname(localPath), { recursive: true })
      await fs.writeFile(localPath, joinBom(content, bom), "utf-8")

      await conn.syncEngine.register(remotePath)
      await conn.syncEngine.pushAll()

      return textResult(`Wrote file successfully.\nPath: ${remotePath}\nExists: ${existed}`)
    }
  )
}

function generateDiffPreview(filePath: string, oldText: string, newText: string): string {
  return trimDiff(createTwoFilesPatch(filePath, filePath, oldText, newText))
}
