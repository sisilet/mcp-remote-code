const BOM_CODE = 0xfeff;
const BOM = String.fromCharCode(BOM_CODE);
export function splitBom(text) {
    if (text.charCodeAt(0) !== BOM_CODE)
        return { bom: false, text };
    return { bom: true, text: text.slice(1) };
}
export function joinBom(text, bom) {
    const stripped = splitBom(text).text;
    if (!bom)
        return stripped;
    return BOM + stripped;
}
export async function readFileWithBom(fs, filePath) {
    const buf = await fs.readFile(filePath);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
    return splitBom(text);
}
//# sourceMappingURL=bom.js.map