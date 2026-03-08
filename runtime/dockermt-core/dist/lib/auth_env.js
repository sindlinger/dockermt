import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWindowsPath, isWsl, toWslPath } from "./config.js";
export function resolveAuthEnvPath(configPath, configObj) {
    const _unused = configPath; // reserved for future relative resolution
    const envOverride = (process.env.CMDMT_ENV || "").trim();
    if (envOverride) {
        const p = envOverride.startsWith("~") ? path.join(os.homedir(), envOverride.slice(1)) : envOverride;
        return isWsl() && isWindowsPath(p) ? toWslPath(p) : path.resolve(p);
    }
    const fromConfig = typeof configObj.envPath === "string" ? configObj.envPath.trim() : "";
    if (fromConfig) {
        const p = fromConfig.startsWith("~") ? path.join(os.homedir(), fromConfig.slice(1)) : fromConfig;
        return isWsl() && isWindowsPath(p) ? toWslPath(p) : path.resolve(p);
    }
    return path.join(os.homedir(), ".cmdmt", ".env");
}
export function upsertDotEnv(filePath, updates) {
    const lines = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split(/\r?\n/) : [];
    const keys = Object.keys(updates);
    const seen = new Set();
    const next = lines.map((line) => {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (!m)
            return line;
        const key = m[1];
        if (!(key in updates))
            return line;
        seen.add(key);
        return key + "=" + JSON.stringify(updates[key]);
    });
    for (const key of keys) {
        if (!seen.has(key))
            next.push(key + "=" + JSON.stringify(updates[key]));
    }
    const out = next.filter((l, idx, arr) => idx < arr.length - 1 || l.trim().length > 0).join("\n") + "\n";
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, out, "utf8");
}
