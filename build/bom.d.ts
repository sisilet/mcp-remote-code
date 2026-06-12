export declare function splitBom(text: string): {
    bom: boolean;
    text: string;
};
export declare function joinBom(text: string, bom: boolean): string;
export declare function readFileWithBom(fs: typeof import("fs/promises"), filePath: string): Promise<{
    bom: boolean;
    text: string;
}>;
