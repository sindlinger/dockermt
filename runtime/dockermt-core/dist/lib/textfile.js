import fs from "node:fs";
function looksLikeUtf16LeWithoutBom(buf) {
    if (buf.length < 4 || (buf.length % 2) !== 0)
        return false;
    let nulHigh = 0;
    const sample = Math.min(buf.length, 512);
    for (let i = 1; i < sample; i += 2) {
        if (buf[i] === 0x00)
            nulHigh++;
    }
    const pairs = Math.floor(sample / 2);
    return pairs > 0 && (nulHigh / pairs) > 0.7;
}
export function readTextWithEncoding(filePath) {
    const buf = fs.readFileSync(filePath);
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return { text: buf.slice(2).toString("utf16le"), encoding: "utf16le", bom: true };
    }
    if (looksLikeUtf16LeWithoutBom(buf)) {
        return { text: buf.toString("utf16le"), encoding: "utf16le", bom: false };
    }
    return { text: buf.toString("utf8"), encoding: "utf8", bom: false };
}
export function writeTextWithEncoding(filePath, text, encoding, bom) {
    if (encoding === "utf16le") {
        const content = Buffer.from(text, "utf16le");
        const out = bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), content]) : content;
        fs.writeFileSync(filePath, out);
        return;
    }
    fs.writeFileSync(filePath, text, "utf8");
}
