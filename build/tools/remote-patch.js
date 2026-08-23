import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { jailRemotePath, requireConnection, targetSchema, textResult } from "../tool-utils.js";
import { readFileWithBom, joinBom } from "../bom.js";
import { quoteShell } from "../shell-quote.js";
function parsePatchHeader(lines, startIdx) {
    const line = lines[startIdx];
    if (line.startsWith("*** Add File:")) {
        const filePath = line.slice("*** Add File:".length).trim();
        return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
    }
    if (line.startsWith("*** Delete File:")) {
        const filePath = line.slice("*** Delete File:".length).trim();
        return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
    }
    if (line.startsWith("*** Update File:")) {
        const filePath = line.slice("*** Update File:".length).trim();
        let movePath;
        let nextIdx = startIdx + 1;
        if (nextIdx < lines.length && lines[nextIdx].startsWith("*** Move to:")) {
            movePath = lines[nextIdx].slice("*** Move to:".length).trim();
            nextIdx++;
        }
        return filePath ? { filePath, movePath, nextIdx } : null;
    }
    return null;
}
function parseUpdateFileChunks(lines, startIdx) {
    const chunks = [];
    let i = startIdx;
    while (i < lines.length && !lines[i].startsWith("***")) {
        if (lines[i].startsWith("@@")) {
            const contextLine = lines[i].substring(2).trim();
            i++;
            const oldLines = [];
            const newLines = [];
            let isEndOfFile = false;
            while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("***")) {
                const changeLine = lines[i];
                if (changeLine === "*** End of File") {
                    isEndOfFile = true;
                    i++;
                    break;
                }
                if (changeLine.startsWith(" ")) {
                    const content = changeLine.substring(1);
                    oldLines.push(content);
                    newLines.push(content);
                }
                else if (changeLine.startsWith("-")) {
                    oldLines.push(changeLine.substring(1));
                }
                else if (changeLine.startsWith("+")) {
                    newLines.push(changeLine.substring(1));
                }
                i++;
            }
            chunks.push({
                old_lines: oldLines,
                new_lines: newLines,
                change_context: contextLine || undefined,
                is_end_of_file: isEndOfFile || undefined,
            });
        }
        else {
            i++;
        }
    }
    return { chunks, nextIdx: i };
}
function parseAddFileContent(lines, startIdx) {
    let content = "";
    let i = startIdx;
    while (i < lines.length && !lines[i].startsWith("***")) {
        if (lines[i].startsWith("+")) {
            content += lines[i].substring(1) + "\n";
        }
        i++;
    }
    if (content.endsWith("\n")) {
        content = content.slice(0, -1);
    }
    return { content, nextIdx: i };
}
function stripHeredoc(input) {
    const heredocMatch = input.match(/^(?:cat\s+)?<<['"']?(\w+)['"']?\s*\n([\s\S]*?)\n\1\s*$/);
    if (heredocMatch) {
        return heredocMatch[2];
    }
    return input;
}
export function parsePatch(patchText) {
    const cleaned = stripHeredoc(patchText.trim());
    const lines = cleaned.split("\n");
    const hunks = [];
    let i = 0;
    const beginMarker = "*** Begin Patch";
    const endMarker = "*** End Patch";
    const beginIdx = lines.findIndex((line) => line.trim() === beginMarker);
    const endIdx = lines.findIndex((line) => line.trim() === endMarker);
    if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
        throw new Error("Invalid patch format: missing Begin/End markers");
    }
    i = beginIdx + 1;
    while (i < endIdx) {
        const header = parsePatchHeader(lines, i);
        if (!header) {
            i++;
            continue;
        }
        if (lines[i].startsWith("*** Add File:")) {
            const { content, nextIdx } = parseAddFileContent(lines, header.nextIdx);
            hunks.push({
                type: "add",
                path: header.filePath,
                contents: content,
            });
            i = nextIdx;
        }
        else if (lines[i].startsWith("*** Delete File:")) {
            hunks.push({
                type: "delete",
                path: header.filePath,
            });
            i = header.nextIdx;
        }
        else if (lines[i].startsWith("*** Update File:")) {
            const { chunks, nextIdx } = parseUpdateFileChunks(lines, header.nextIdx);
            hunks.push({
                type: "update",
                path: header.filePath,
                move_path: header.movePath,
                chunks,
            });
            i = nextIdx;
        }
        else {
            i++;
        }
    }
    return { hunks };
}
function deriveNewContentsFromChunks(filePath, chunks, originalText) {
    const originalContent = readTextWithBom(originalText);
    let originalLines = originalContent.text.split("\n");
    if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
        originalLines.pop();
    }
    const replacements = computeReplacements(originalLines, filePath, chunks);
    let newLines = applyReplacements(originalLines, replacements);
    if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
        newLines.push("");
    }
    const next = readTextWithBom(newLines.join("\n"));
    return {
        content: next.text,
        bom: originalContent.bom || next.bom,
    };
}
function computeReplacements(originalLines, filePath, chunks) {
    const replacements = [];
    let lineIndex = 0;
    for (const chunk of chunks) {
        if (chunk.change_context) {
            const contextIdx = seekSequence(originalLines, [chunk.change_context], lineIndex);
            if (contextIdx === -1) {
                throw new Error(`Failed to find context '${chunk.change_context}' in ${filePath}`);
            }
            lineIndex = contextIdx;
        }
        if (chunk.old_lines.length === 0) {
            const insertionIdx = originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
                ? originalLines.length - 1
                : originalLines.length;
            replacements.push([insertionIdx, 0, chunk.new_lines]);
            continue;
        }
        let pattern = chunk.old_lines;
        let newSlice = chunk.new_lines;
        let found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
        if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
            pattern = pattern.slice(0, -1);
            if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
                newSlice = newSlice.slice(0, -1);
            }
            found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
        }
        if (found !== -1) {
            replacements.push([found, pattern.length, newSlice]);
            lineIndex = found + pattern.length;
        }
        else {
            throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.old_lines.join("\n")}`);
        }
    }
    replacements.sort((a, b) => a[0] - b[0]);
    return replacements;
}
function applyReplacements(lines, replacements) {
    const result = [...lines];
    for (let i = replacements.length - 1; i >= 0; i--) {
        const [startIdx, oldLen, newSegment] = replacements[i];
        result.splice(startIdx, oldLen);
        for (let j = 0; j < newSegment.length; j++) {
            result.splice(startIdx + j, 0, newSegment[j]);
        }
    }
    return result;
}
function normalizeUnicode(str) {
    return str
        .replace(/[‘’‚‛]/g, "'")
        .replace(/[“”„‟]/g, '"')
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
        .replace(/…/g, "...")
        .replace(/\u00a0/g, " ");
}
function tryMatch(lines, pattern, startIndex, compare, eof) {
    if (eof) {
        const fromEnd = lines.length - pattern.length;
        if (fromEnd >= startIndex) {
            let matches = true;
            for (let j = 0; j < pattern.length; j++) {
                if (!compare(lines[fromEnd + j], pattern[j])) {
                    matches = false;
                    break;
                }
            }
            if (matches)
                return fromEnd;
        }
    }
    for (let i = startIndex; i <= lines.length - pattern.length; i++) {
        let matches = true;
        for (let j = 0; j < pattern.length; j++) {
            if (!compare(lines[i + j], pattern[j])) {
                matches = false;
                break;
            }
        }
        if (matches)
            return i;
    }
    return -1;
}
function seekSequence(lines, pattern, startIndex, eof = false) {
    if (pattern.length === 0)
        return -1;
    const exact = tryMatch(lines, pattern, startIndex, (a, b) => a === b, eof);
    if (exact !== -1)
        return exact;
    const rstrip = tryMatch(lines, pattern, startIndex, (a, b) => a.trimEnd() === b.trimEnd(), eof);
    if (rstrip !== -1)
        return rstrip;
    const trim = tryMatch(lines, pattern, startIndex, (a, b) => a.trim() === b.trim(), eof);
    if (trim !== -1)
        return trim;
    const normalized = tryMatch(lines, pattern, startIndex, (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()), eof);
    return normalized;
}
function readTextWithBom(text) {
    const BOM_CODE = 0xfeff;
    if (text.charCodeAt(0) === BOM_CODE) {
        return { text: text.slice(1), bom: true };
    }
    return { text, bom: false };
}
function parseUnifiedPatch(patchText) {
    const lines = patchText.split("\n");
    const files = [];
    let current = null;
    let currentHunk = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("--- ")) {
            const oldPath = line.slice(4).trim();
            const nextLine = lines[i + 1] ?? "";
            let newPath = null;
            if (nextLine.startsWith("+++ ")) {
                newPath = nextLine.slice(4).trim();
                i++;
            }
            current = {
                oldPath: oldPath === "/dev/null" ? null : oldPath,
                newPath: newPath === "/dev/null" ? null : newPath,
                hunks: [],
                isNew: oldPath === "/dev/null",
                isDeleted: newPath === "/dev/null",
            };
            files.push(current);
            currentHunk = null;
            continue;
        }
        const hunkMatch = line.match(/^@@ -(\d+)(?:(\d+))? \+(\d+)(?:(\d+))? @@/);
        if (hunkMatch && current) {
            currentHunk = {
                oldStart: parseInt(hunkMatch[1], 10),
                oldCount: parseInt(hunkMatch[2] ?? "1", 10),
                newStart: parseInt(hunkMatch[3], 10),
                newCount: parseInt(hunkMatch[4] ?? "1", 10),
                lines: [],
            };
            current.hunks.push(currentHunk);
            continue;
        }
        if (currentHunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
            currentHunk.lines.push(line);
            continue;
        }
    }
    return files;
}
function detectNoNewlineAtEnd(hunks) {
    for (const hunk of hunks) {
        for (let i = hunk.lines.length - 1; i >= 0; i--) {
            const line = hunk.lines[i];
            if (line === "\\ No newline at end of file")
                return true;
            if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))
                break;
        }
    }
    return false;
}
function applyUnifiedDiff(content, hunks, hasNoNewlineMarker) {
    let lines = content === "" ? [] : content.split("\n");
    const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
    if (hadTrailingNewline) {
        lines.pop();
    }
    for (let h = hunks.length - 1; h >= 0; h--) {
        const hunk = hunks[h];
        const matchIdx = findHunkPosition(lines, hunk);
        if (matchIdx === -1) {
            throw new Error(`Patch does not apply: could not find hunk context near line ${hunk.oldStart}`);
        }
        const newLines = [];
        for (const ln of hunk.lines) {
            if (ln.startsWith(" ") || ln.startsWith("+")) {
                newLines.push(ln.slice(1));
            }
        }
        let oldLinesCount = 0;
        for (const ln of hunk.lines) {
            if (ln.startsWith(" ") || ln.startsWith("-")) {
                oldLinesCount++;
            }
        }
        lines.splice(matchIdx, oldLinesCount, ...newLines);
    }
    let result = lines.join("\n");
    if (!hasNoNewlineMarker && lines.length > 0) {
        result += "\n";
    }
    return result;
}
function findHunkPosition(lines, hunk) {
    const expectedIndex = hunk.oldStart - 1;
    const oldLines = [];
    for (const ln of hunk.lines) {
        if (ln.startsWith(" ") || ln.startsWith("-")) {
            oldLines.push(ln.slice(1));
        }
    }
    if (oldLines.length === 0) {
        return expectedIndex >= 0 && expectedIndex <= lines.length ? expectedIndex : -1;
    }
    const exact = tryMatchUnified(lines, expectedIndex, oldLines);
    if (exact >= 0)
        return exact;
    for (let offset = 1; offset <= 20; offset++) {
        const up = tryMatchUnified(lines, expectedIndex - offset, oldLines);
        if (up >= 0)
            return up;
        const down = tryMatchUnified(lines, expectedIndex + offset, oldLines);
        if (down >= 0)
            return down;
    }
    return -1;
}
function tryMatchUnified(lines, idx, oldLines) {
    if (idx < 0 || idx + oldLines.length > lines.length)
        return -1;
    for (let i = 0; i < oldLines.length; i++) {
        if (lines[idx + i] !== oldLines[i])
            return -1;
    }
    return idx;
}
// ========================================================================
// Tool definition
// ========================================================================
export function createRemotePatchTool(server, connectionManager) {
    server.registerTool("remote_patch", {
        description: `Apply a patch to files on the remote machine within the configured root. Supports both unified diff format and OpenCode native patch format.`,
        inputSchema: {
            target: targetSchema,
            patchText: z.string().describe("The full patch text that describes all changes to be made"),
        },
    }, async ({ target, patchText }) => {
        const connOrError = requireConnection(connectionManager, target);
        if ("errorText" in connOrError) {
            return textResult(connOrError.errorText);
        }
        const conn = connOrError;
        if (!patchText.trim()) {
            return textResult("patchText is required");
        }
        const normalizedPatchText = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        let files;
        if (normalizedPatchText.includes("*** Begin Patch")) {
            files = await parseAndPrepareNative(normalizedPatchText, conn.config.remoteWorkdir, conn.pathMapper);
            if (files.length === 0) {
                files = await parseAndPrepareUnified(normalizedPatchText, conn.config.remoteWorkdir, conn.pathMapper);
            }
        }
        else {
            files = await parseAndPrepareUnified(normalizedPatchText, conn.config.remoteWorkdir, conn.pathMapper);
        }
        if (files.length === 0) {
            return textResult("apply_patch verification failed: no file paths found in patch");
        }
        const involvedPaths = new Set();
        for (const f of files) {
            involvedPaths.add(f.path);
            if (f.moveFrom)
                involvedPaths.add(f.moveFrom);
        }
        for (const rp of involvedPaths) {
            if (rp === "/dev/null")
                continue;
            const jailed = await jailRemotePath(conn, rp, { forNewFile: true, allowMissing: true });
            if ("errorText" in jailed) {
                return textResult(jailed.errorText);
            }
        }
        for (const rp of involvedPaths) {
            await conn.syncEngine.register(rp);
        }
        await conn.syncEngine.pullAll();
        for (const f of files) {
            const sourcePath = f.moveFrom ?? f.path;
            const localSourcePath = conn.pathMapper.toLocal(sourcePath);
            const { bom, text } = await readFileWithBom(fs, localSourcePath);
            const newText = f.apply(text);
            const localDestPath = conn.pathMapper.toLocal(f.path);
            await fs.mkdir(path.dirname(localDestPath), { recursive: true });
            await fs.writeFile(localDestPath, joinBom(newText, bom), "utf-8");
        }
        await conn.syncEngine.pushAll();
        // Handle file moves
        for (const f of files) {
            if (f.moveFrom) {
                const fromLocal = conn.pathMapper.toLocal(f.moveFrom);
                const toLocal = conn.pathMapper.toLocal(f.path);
                await conn.sshPool.exec(`rm -f ${quoteShell(f.moveFrom)}`, { timeout: 10_000 });
                await fs.rename(fromLocal, toLocal).catch(() => { });
                conn.syncEngine.manifest.remove(f.moveFrom);
            }
        }
        return textResult(`Patched ${involvedPaths.size} file(s)\n\nSuccess. Updated the following files:\n${Array.from(involvedPaths).join("\n")}`);
    });
}
async function parseAndPrepareUnified(patchText, remoteWorkdir, pathMapper) {
    const parsed = parseUnifiedPatch(patchText);
    const result = [];
    for (const file of parsed) {
        const targetPath = file.newPath ?? file.oldPath;
        if (!targetPath)
            continue;
        const rp = normalizePatchPath(targetPath, remoteWorkdir);
        const hasNoNewlineMarker = detectNoNewlineAtEnd(file.hunks);
        result.push({
            path: rp,
            apply: (content) => applyUnifiedDiff(content, file.hunks, hasNoNewlineMarker),
        });
    }
    return result;
}
async function parseAndPrepareNative(patchText, remoteWorkdir, pathMapper) {
    const hunks = parsePatch(patchText).hunks;
    const result = [];
    for (const hunk of hunks) {
        const rp = normalizePatchPath(hunk.path, remoteWorkdir);
        if (hunk.type === "add") {
            result.push({
                path: rp,
                apply: () => hunk.contents ?? "",
            });
        }
        else if (hunk.type === "delete") {
            result.push({
                path: rp,
                apply: () => "",
            });
        }
        else if (hunk.type === "update" && hunk.chunks) {
            const chunks = hunk.chunks;
            const movePath = hunk.move_path
                ? normalizePatchPath(hunk.move_path, remoteWorkdir)
                : undefined;
            if (movePath) {
                result.push({
                    path: movePath,
                    apply: (content) => deriveNewContentsFromChunks(movePath, chunks, content).content,
                    moveFrom: rp,
                });
            }
            else {
                result.push({
                    path: rp,
                    apply: (content) => deriveNewContentsFromChunks(rp, chunks, content).content,
                });
            }
        }
    }
    return result;
}
function normalizePatchPath(raw, remoteWorkdir) {
    let p = raw.trim();
    if (p === "/dev/null")
        return p;
    if (p.startsWith("a/") || p.startsWith("b/")) {
        p = p.slice(2);
    }
    const tabIdx = p.indexOf("\t");
    if (tabIdx >= 0)
        p = p.slice(0, tabIdx);
    if (!p.startsWith("/")) {
        p = path.posix.join(remoteWorkdir, p);
    }
    return path.posix.normalize(p);
}
//# sourceMappingURL=remote-patch.js.map