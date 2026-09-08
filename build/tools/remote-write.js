import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { createTwoFilesPatch } from "diff";
import { jailRemotePath, requireConnection, targetSchema, textResult } from "../tool-utils.js";
import { readFileWithBom, joinBom, splitBom } from "../bom.js";
import { trimDiff } from "../diff-utils.js";
export function createRemoteWriteTool(server, connectionManager) {
    server.registerTool("remote_write", {
        description: `Write content to a file on the remote machine within the configured root.`,
        inputSchema: {
            target: targetSchema,
            content: z.string().describe("The content to write to the file"),
            filePath: z.string().describe("The path to the file to write on the remote machine (absolute or relative to root)"),
        },
    }, async ({ target, content, filePath }) => {
        const connOrError = await requireConnection(connectionManager, target);
        if ("errorText" in connOrError) {
            return textResult(connOrError.errorText);
        }
        const conn = connOrError;
        const jailed = await jailRemotePath(conn, filePath, { forNewFile: true });
        if ("errorText" in jailed) {
            return textResult(jailed.errorText);
        }
        const remotePath = jailed.path;
        const localPath = conn.pathMapper.toLocal(remotePath);
        // Decide "new vs overwrite" from the REMOTE, not the local mirror. The
        // old check (fs.stat on the mirror) treated any file the tool had not
        // seen before as new, skipped the pull, and overwrote it blind. Pulling
        // the target first gives a correct diff preview and records the stamp
        // the push guard needs.
        await conn.syncEngine.register(remotePath);
        const [existed] = await conn.syncEngine.pull([remotePath]);
        let bom = false;
        let oldContent = "";
        if (existed) {
            try {
                const existing = await readFileWithBom(fs, localPath);
                bom = existing.bom;
                oldContent = existing.text;
            }
            catch { }
        }
        bom = bom || splitBom(content).bom;
        const diffPreview = existed
            ? generateDiffPreview(remotePath, oldContent, content)
            : `A ${remotePath}\n+ ${content.split("\n").slice(0, 10).join("\n+ ")}`;
        console.error(`[remote_write] ${remotePath}${existed ? " (overwrite)" : " (new)"}`);
        console.error(diffPreview.slice(0, 500));
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, joinBom(content, bom), "utf-8");
        await conn.syncEngine.register(remotePath);
        // Push ONLY this file. pushAll() here uploaded every tracked file from
        // the local mirror, and for a new file the mirror had not been refreshed,
        // so earlier files were overwritten with stale copies.
        await conn.syncEngine.push([remotePath]);
        return textResult(`Wrote file successfully.\nPath: ${remotePath}\nExists: ${existed}`);
    });
}
function generateDiffPreview(filePath, oldText, newText) {
    return trimDiff(createTwoFilesPatch(filePath, filePath, oldText, newText));
}
//# sourceMappingURL=remote-write.js.map