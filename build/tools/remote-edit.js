import fs from "fs/promises";
import { z } from "zod";
import { createTwoFilesPatch, diffLines } from "diff";
import { jailRemotePath, requireConnection, targetSchema, textResult } from "../tool-utils.js";
import { readFileWithBom, joinBom, splitBom } from "../bom.js";
import { trimDiff } from "../diff-utils.js";
// ========================================================================
// Per-file edit locks (global across all connections)
// ========================================================================
const fileLocks = new Map();
async function withFileLock(filePath, fn) {
    const previous = fileLocks.get(filePath);
    const current = (async () => {
        if (previous)
            await previous;
        return fn();
    })();
    fileLocks.set(filePath, current.then(() => { }, () => { }));
    try {
        return await current;
    }
    finally {
        if (fileLocks.get(filePath) === current) {
            fileLocks.delete(filePath);
        }
    }
}
// ========================================================================
// Line ending helpers
// ========================================================================
function normalizeLineEndings(text) {
    return text.replaceAll("\r\n", "\n");
}
function detectLineEnding(text) {
    return text.includes("\r\n") ? "\r\n" : "\n";
}
function convertToLineEnding(text, ending) {
    if (ending === "\n")
        return text;
    return text.replaceAll("\n", "\r\n");
}
// ====================================================================
// Local processing layer - ported from OpenCode 1.15.6 edit.ts
// ====================================================================
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3;
function* simpleReplacer(_content, find) {
    yield find;
}
function* lineTrimmedReplacer(content, find) {
    const originalLines = content.split("\n");
    const searchLines = find.split("\n");
    if (searchLines[searchLines.length - 1] === "")
        searchLines.pop();
    for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
        let matches = true;
        for (let j = 0; j < searchLines.length; j++) {
            if (originalLines[i + j].trim() !== searchLines[j].trim()) {
                matches = false;
                break;
            }
        }
        if (matches) {
            let matchStartIndex = 0;
            for (let k = 0; k < i; k++)
                matchStartIndex += originalLines[k].length + 1;
            let matchEndIndex = matchStartIndex;
            for (let k = 0; k < searchLines.length; k++) {
                matchEndIndex += originalLines[i + k].length;
                if (k < searchLines.length - 1)
                    matchEndIndex += 1;
            }
            yield content.substring(matchStartIndex, matchEndIndex);
        }
    }
}
function levenshtein(a, b) {
    if (a === "" || b === "")
        return Math.max(a.length, b.length);
    const matrix = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
        }
    }
    return matrix[a.length][b.length];
}
function* blockAnchorReplacer(content, find) {
    const originalLines = content.split("\n");
    const searchLines = find.split("\n");
    if (searchLines.length < 3)
        return;
    if (searchLines[searchLines.length - 1] === "")
        searchLines.pop();
    const firstLineSearch = searchLines[0].trim();
    const lastLineSearch = searchLines[searchLines.length - 1].trim();
    const searchBlockSize = searchLines.length;
    const candidates = [];
    for (let i = 0; i < originalLines.length; i++) {
        if (originalLines[i].trim() !== firstLineSearch)
            continue;
        for (let j = i + 2; j < originalLines.length; j++) {
            if (originalLines[j].trim() === lastLineSearch) {
                candidates.push({ startLine: i, endLine: j });
                break;
            }
        }
    }
    if (candidates.length === 0)
        return;
    if (candidates.length === 1) {
        const { startLine, endLine } = candidates[0];
        const actualBlockSize = endLine - startLine + 1;
        let similarity = 0;
        let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
        if (linesToCheck > 0) {
            for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
                const originalLine = originalLines[startLine + j].trim();
                const searchLine = searchLines[j].trim();
                const maxLen = Math.max(originalLine.length, searchLine.length);
                if (maxLen === 0)
                    continue;
                const distance = levenshtein(originalLine, searchLine);
                similarity += (1 - distance / maxLen) / linesToCheck;
                if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD)
                    break;
            }
        }
        else {
            similarity = 1.0;
        }
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
            let matchStartIndex = 0;
            for (let k = 0; k < startLine; k++)
                matchStartIndex += originalLines[k].length + 1;
            let matchEndIndex = matchStartIndex;
            for (let k = startLine; k <= endLine; k++) {
                matchEndIndex += originalLines[k].length;
                if (k < endLine)
                    matchEndIndex += 1;
            }
            yield content.substring(matchStartIndex, matchEndIndex);
        }
        return;
    }
    let bestMatch = null;
    let maxSimilarity = -1;
    for (const candidate of candidates) {
        const { startLine, endLine } = candidate;
        const actualBlockSize = endLine - startLine + 1;
        let similarity = 0;
        let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
        if (linesToCheck > 0) {
            for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
                const originalLine = originalLines[startLine + j].trim();
                const searchLine = searchLines[j].trim();
                const maxLen = Math.max(originalLine.length, searchLine.length);
                if (maxLen === 0)
                    continue;
                const distance = levenshtein(originalLine, searchLine);
                similarity += 1 - distance / maxLen;
            }
            similarity /= linesToCheck;
        }
        else {
            similarity = 1.0;
        }
        if (similarity > maxSimilarity) {
            maxSimilarity = similarity;
            bestMatch = candidate;
        }
    }
    if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
        const { startLine, endLine } = bestMatch;
        let matchStartIndex = 0;
        for (let k = 0; k < startLine; k++)
            matchStartIndex += originalLines[k].length + 1;
        let matchEndIndex = matchStartIndex;
        for (let k = startLine; k <= endLine; k++) {
            matchEndIndex += originalLines[k].length;
            if (k < endLine)
                matchEndIndex += 1;
        }
        yield content.substring(matchStartIndex, matchEndIndex);
    }
}
function* whitespaceNormalizedReplacer(content, find) {
    const normalizeWhitespace = (text) => text.replace(/\s+/g, " ").trim();
    const normalizedFind = normalizeWhitespace(find);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (normalizeWhitespace(line) === normalizedFind) {
            yield line;
        }
        else {
            const normalizedLine = normalizeWhitespace(line);
            if (normalizedLine.includes(normalizedFind)) {
                const words = find.trim().split(/\s+/);
                if (words.length > 0) {
                    const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
                    try {
                        const regex = new RegExp(pattern);
                        const match = line.match(regex);
                        if (match)
                            yield match[0];
                    }
                    catch { }
                }
            }
        }
    }
    const findLines = find.split("\n");
    if (findLines.length > 1) {
        for (let i = 0; i <= lines.length - findLines.length; i++) {
            const block = lines.slice(i, i + findLines.length);
            if (normalizeWhitespace(block.join("\n")) === normalizedFind)
                yield block.join("\n");
        }
    }
}
function* indentationFlexibleReplacer(content, find) {
    const removeIndentation = (text) => {
        const lines = text.split("\n");
        const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
        if (nonEmptyLines.length === 0)
            return text;
        const minIndent = Math.min(...nonEmptyLines.map((line) => {
            const match = line.match(/^(\s*)/);
            return match ? match[1].length : 0;
        }));
        return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n");
    };
    const normalizedFind = removeIndentation(find);
    const contentLines = content.split("\n");
    const findLines = find.split("\n");
    for (let i = 0; i <= contentLines.length - findLines.length; i++) {
        const block = contentLines.slice(i, i + findLines.length).join("\n");
        if (removeIndentation(block) === normalizedFind)
            yield block;
    }
}
function* escapeNormalizedReplacer(content, find) {
    const unescapeString = (str) => {
        return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
            switch (capturedChar) {
                case "n": return "\n";
                case "t": return "\t";
                case "r": return "\r";
                case "'": return "'";
                case '"': return '"';
                case "`": return "`";
                case "\\": return "\\";
                case "\n": return "\n";
                case "$": return "$";
                default: return match;
            }
        });
    };
    const unescapedFind = unescapeString(find);
    if (content.includes(unescapedFind))
        yield unescapedFind;
    const lines = content.split("\n");
    const findLines = unescapedFind.split("\n");
    for (let i = 0; i <= lines.length - findLines.length; i++) {
        const block = lines.slice(i, i + findLines.length).join("\n");
        if (unescapeString(block) === unescapedFind)
            yield block;
    }
}
function* multiOccurrenceReplacer(content, find) {
    let startIndex = 0;
    while (true) {
        const index = content.indexOf(find, startIndex);
        if (index === -1)
            break;
        yield find;
        startIndex = index + find.length;
    }
}
function* trimmedBoundaryReplacer(content, find) {
    const trimmedFind = find.trim();
    if (trimmedFind === find)
        return;
    if (content.includes(trimmedFind))
        yield trimmedFind;
    const lines = content.split("\n");
    const findLines = find.split("\n");
    for (let i = 0; i <= lines.length - findLines.length; i++) {
        const block = lines.slice(i, i + findLines.length).join("\n");
        if (block.trim() === trimmedFind)
            yield block;
    }
}
function* contextAwareReplacer(content, find) {
    const findLines = find.split("\n");
    if (findLines.length < 3)
        return;
    if (findLines[findLines.length - 1] === "")
        findLines.pop();
    const contentLines = content.split("\n");
    const firstLine = findLines[0].trim();
    const lastLine = findLines[findLines.length - 1].trim();
    for (let i = 0; i < contentLines.length; i++) {
        if (contentLines[i].trim() !== firstLine)
            continue;
        for (let j = i + 2; j < contentLines.length; j++) {
            if (contentLines[j].trim() === lastLine) {
                const blockLines = contentLines.slice(i, j + 1);
                const block = blockLines.join("\n");
                if (blockLines.length === findLines.length) {
                    let matchingLines = 0;
                    let totalNonEmptyLines = 0;
                    for (let k = 1; k < blockLines.length - 1; k++) {
                        const blockLine = blockLines[k].trim();
                        const findLine = findLines[k].trim();
                        if (blockLine.length > 0 || findLine.length > 0) {
                            totalNonEmptyLines++;
                            if (blockLine === findLine)
                                matchingLines++;
                        }
                    }
                    if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
                        yield block;
                        break;
                    }
                }
                break;
            }
        }
    }
}
function replaceContent(content, oldString, newString, replaceAll = false) {
    if (oldString === newString) {
        throw new Error("No changes to apply: oldString and newString are identical.");
    }
    if (oldString === "") {
        return newString;
    }
    let notFound = true;
    for (const replacer of [
        simpleReplacer,
        lineTrimmedReplacer,
        blockAnchorReplacer,
        whitespaceNormalizedReplacer,
        indentationFlexibleReplacer,
        escapeNormalizedReplacer,
        trimmedBoundaryReplacer,
        contextAwareReplacer,
        multiOccurrenceReplacer,
    ]) {
        for (const search of replacer(content, oldString)) {
            const index = content.indexOf(search);
            if (index === -1)
                continue;
            notFound = false;
            if (replaceAll) {
                let result = content;
                let idx = result.indexOf(search);
                while (idx !== -1) {
                    result = result.substring(0, idx) + newString + result.substring(idx + search.length);
                    idx = result.indexOf(search, idx + newString.length);
                }
                return result;
            }
            const lastIndex = content.lastIndexOf(search);
            if (index !== lastIndex)
                continue;
            return content.substring(0, index) + newString + content.substring(index + search.length);
        }
    }
    if (notFound) {
        throw new Error("Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.");
    }
    throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.");
}
function countDiffStats(oldText, newText) {
    let additions = 0;
    let deletions = 0;
    for (const change of diffLines(oldText, newText)) {
        if (change.added)
            additions += change.count || 0;
        if (change.removed)
            deletions += change.count || 0;
    }
    return { additions, deletions };
}
// ========================================================================
// Tool definition
// ========================================================================
export function createRemoteEditTool(server, connectionManager) {
    server.registerTool("remote_edit", {
        description: `Make precise text replacements in a remote file within the configured root.`,
        inputSchema: {
            target: targetSchema,
            filePath: z.string().describe("The path to the file to modify on the remote machine (absolute or relative to root)"),
            oldString: z.string().describe("The text to replace"),
            newString: z.string().describe("The text to replace it with (must be different from oldString)"),
            replaceAll: z.boolean().optional().describe("Replace all occurrences of oldString (default false)"),
        },
    }, async ({ target, filePath, oldString, newString, replaceAll }) => {
        if (oldString === newString) {
            return textResult("No changes to apply: oldString and newString are identical.");
        }
        const connOrError = await requireConnection(connectionManager, target);
        if ("errorText" in connOrError) {
            return textResult(connOrError.errorText);
        }
        const conn = connOrError;
        const jailed = await jailRemotePath(conn, filePath);
        if ("errorText" in jailed) {
            return textResult(jailed.errorText);
        }
        const remotePath = jailed.path;
        const localPath = conn.pathMapper.toLocal(remotePath);
        return withFileLock(localPath, async () => {
            await conn.syncEngine.register(remotePath);
            await conn.syncEngine.pullAll();
            let content = "";
            let bom = false;
            let existed = false;
            try {
                const existing = await readFileWithBom(fs, localPath);
                content = existing.text;
                bom = existing.bom;
                existed = true;
            }
            catch { }
            if (!existed && oldString !== "") {
                return textResult(`File ${remotePath} not found`);
            }
            const ending = detectLineEnding(content);
            const oldNorm = convertToLineEnding(normalizeLineEndings(oldString), ending);
            const newNorm = convertToLineEnding(normalizeLineEndings(newString), ending);
            const result = replaceContent(content, oldNorm, newNorm, replaceAll ?? false);
            const diffPreview = generateDiffPreview(remotePath, content, result);
            console.error(`[remote_edit] ${remotePath}`);
            console.error(diffPreview.slice(0, 500));
            const next = splitBom(result);
            const desiredBom = bom || next.bom;
            await fs.writeFile(localPath, joinBom(result, desiredBom), "utf-8");
            // Push only the edited file, never the whole mirror (see SyncEngine.push).
            await conn.syncEngine.push([remotePath]);
            const stats = countDiffStats(content, result);
            return textResult(`Edit applied successfully.\nPath: ${remotePath}\nAdditions: ${stats.additions}\nDeletions: ${stats.deletions}`);
        });
    });
}
function generateDiffPreview(filePath, oldText, newText) {
    return trimDiff(createTwoFilesPatch(filePath, filePath, oldText, newText));
}
//# sourceMappingURL=remote-edit.js.map