import fs from "node:fs";
import path from "node:path";
import { isWindowsPath, toWslPath } from "./config.js";
function ensureTplExt(name) {
    return name.toLowerCase().endsWith(".tpl") ? name : `${name}.tpl`;
}
function readTextWithEncoding(filePath) {
    const buf = fs.readFileSync(filePath);
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return { text: buf.slice(2).toString("utf16le"), encoding: "utf16le", bom: true };
    }
    return { text: buf.toString("utf8"), encoding: "utf8", bom: false };
}
function writeTextWithEncoding(filePath, text, encoding, bom) {
    if (encoding === "utf16le") {
        const content = Buffer.from(text, "utf16le");
        const out = bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), content]) : content;
        fs.writeFileSync(filePath, out);
        return;
    }
    fs.writeFileSync(filePath, text, "utf8");
}
function stripExpertBlock(tpl) {
    let out = tpl;
    for (;;) {
        const start = out.indexOf("<expert>");
        if (start < 0)
            break;
        const end = out.indexOf("</expert>", start);
        if (end < 0)
            break;
        out = out.slice(0, start) + out.slice(end + "</expert>".length);
    }
    return out;
}
function parseParams(pstr) {
    if (!pstr)
        return [];
    return pstr
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((entry) => {
        const idx = entry.indexOf("=");
        if (idx <= 0)
            return { key: entry, value: "" };
        return { key: entry.slice(0, idx).trim(), value: entry.slice(idx + 1).trim() };
    });
}
function buildExpertBlock(name, pathLine, pstr, newline = "\n") {
    const params = parseParams(pstr);
    let block = `<expert>${newline}`;
    block += `name=${name}${newline}`;
    if (pathLine)
        block += `path=${pathLine}${newline}`;
    block += `expertmode=5${newline}`;
    block += `<inputs>${newline}`;
    for (const pair of params) {
        if (!pair.key)
            continue;
        block += `${pair.key}=${pair.value}${newline}`;
    }
    block += `</inputs>${newline}`;
    block += `</expert>${newline}`;
    return block;
}
function normalizeExpertPath(expert) {
    let e = expert.replace(/\//g, "\\");
    const lower = e.toLowerCase();
    const marker = "\\mql5\\experts\\";
    const idx = lower.indexOf(marker);
    if (idx >= 0)
        e = e.slice(idx + marker.length);
    if (e.startsWith("Experts\\"))
        e = e.slice("Experts\\".length);
    const tail = e.slice(-4).toLowerCase();
    if (tail === ".ex5" || tail === ".mq5")
        e = e.slice(0, -4);
    return e;
}
function resolveExpertPath(expert, dataPath) {
    const e = normalizeExpertPath(expert);
    const base = path.join(dataPath, "MQL5", "Experts");
    const directEx5 = path.join(base, `${e}.ex5`);
    const directMq5 = path.join(base, `${e}.mq5`);
    if (fs.existsSync(directEx5) || fs.existsSync(directMq5))
        return e;
    const alt = path.join("Examples", e, e);
    if (fs.existsSync(path.join(base, `${alt}.ex5`)) || fs.existsSync(path.join(base, `${alt}.mq5`))) {
        return alt.replace(/\//g, "\\");
    }
    return e;
}
export function createExpertTemplate(input) {
    const dataPath = isWindowsPath(input.dataPath) ? toWslPath(input.dataPath) : input.dataPath;
    const templatesDir = path.join(dataPath, "MQL5", "Profiles", "Templates");
    const baseTplName = ensureTplExt(input.baseTpl);
    const baseTplPath = isWindowsPath(baseTplName) ? toWslPath(baseTplName) : path.join(templatesDir, baseTplName);
    if (!fs.existsSync(baseTplPath)) {
        throw new Error(`base template nao encontrado: ${baseTplPath}`);
    }
    const outTplName = ensureTplExt(input.outTpl);
    const outTplPath = path.join(templatesDir, outTplName);
    const { text, encoding, bom } = readTextWithEncoding(baseTplPath);
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const stripped = stripExpertBlock(text);
    const expertPath = resolveExpertPath(input.expert, dataPath);
    const base = path.join(dataPath, "MQL5", "Experts");
    const rel = expertPath.replace(/\//g, "\\");
    const relFs = rel.replace(/\\/g, path.sep);
    const nameLine = path.win32.basename(rel) || rel;
    let pathLine = `Experts\\${rel}`;
    if (fs.existsSync(path.join(base, `${relFs}.ex5`)))
        pathLine = `Experts\\${rel}.ex5`;
    else if (fs.existsSync(path.join(base, `${relFs}.mq5`)))
        pathLine = `Experts\\${rel}.mq5`;
    const block = buildExpertBlock(nameLine, pathLine, input.params, newline);
    let next = stripped;
    const idx = stripped.indexOf("</chart>");
    if (idx >= 0) {
        next = stripped.slice(0, idx) + block + stripped.slice(idx);
    }
    else {
        next = stripped + newline + block;
    }
    writeTextWithEncoding(outTplPath, next, encoding, bom);
    return outTplName;
}
