import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const DEFAULT_FILENAME = "macros.json";
function expandHome(p) {
    if (!p)
        return p;
    if (p.startsWith("~" + path.sep) || p === "~") {
        return path.join(os.homedir(), p.slice(1));
    }
    return p;
}
export function resolveAutoMacrosPath(configPath) {
    const fromEnv = process.env.CMDMT_AUTO_MACROS?.trim();
    if (fromEnv)
        return expandHome(fromEnv);
    if (configPath)
        return path.join(path.dirname(configPath), DEFAULT_FILENAME);
    return path.join(os.homedir(), ".cmdmt", DEFAULT_FILENAME);
}
function normalizeAutoMacros(raw) {
    const out = {};
    if (!raw || typeof raw !== "object")
        return out;
    for (const [k, v] of Object.entries(raw)) {
        const name = k.startsWith("@") ? k : `@${k}`;
        if (Array.isArray(v)) {
            const codes = v.map((x) => String(x).trim()).filter(Boolean);
            if (codes.length)
                out[name] = codes;
            continue;
        }
        if (v && typeof v === "object") {
            const cmdVal = v.cmd;
            if (typeof cmdVal === "string" && cmdVal.trim()) {
                out[name] = { cmd: cmdVal.trim() };
            }
        }
    }
    return out;
}
export function loadAutoMacros(filePath) {
    try {
        if (!fs.existsSync(filePath))
            return {};
        const text = fs.readFileSync(filePath, "utf8");
        if (!text.trim())
            return {};
        const parsed = JSON.parse(text);
        return normalizeAutoMacros(parsed);
    }
    catch {
        return {};
    }
}
export function saveAutoMacros(filePath, macros) {
    try {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        const payload = JSON.stringify(macros, null, 2);
        fs.writeFileSync(filePath, payload, "utf8");
    }
    catch {
        // noop
    }
}
