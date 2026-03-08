import fs from "node:fs";
import path from "node:path";
import { isWindowsPath, isWsl, toWslPath, toWindowsPath } from "./config.js";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..", "workspaces");
function toLocalPath(p) {
    return isWindowsPath(p) && isWsl() ? toWslPath(p) : p;
}
function readJson(filePath) {
    try {
        if (!fs.existsSync(filePath))
            return {};
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
function writeJson(filePath, data) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function sanitizeName(name) {
    const trimmed = name.trim();
    if (!trimmed)
        throw new Error("workspace: nome ausente.");
    if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
        throw new Error("workspace: nome invalido (nao use /, \\\\ ou ..).");
    }
    return trimmed;
}
function ensureDir(p) {
    if (!fs.existsSync(p))
        fs.mkdirSync(p, { recursive: true });
}
export function listWorkspaces(args) {
    const cfg = readJson(args.configPath);
    const root = WORKSPACE_ROOT;
    const rootLocal = toLocalPath(root);
    const entries = new Map();
    const reg = cfg.workspaces ?? {};
    for (const [name, meta] of Object.entries(reg)) {
        const p = path.join(root, name);
        const local = toLocalPath(p);
        entries.set(name, {
            name,
            path: p,
            exists: fs.existsSync(local),
            registered: true,
            createdAt: meta?.createdAt
        });
    }
    if (fs.existsSync(rootLocal)) {
        const dirs = fs.readdirSync(rootLocal, { withFileTypes: true }).filter((d) => d.isDirectory());
        for (const dir of dirs) {
            if (entries.has(dir.name))
                continue;
            const p = path.join(root, dir.name);
            entries.set(dir.name, { name: dir.name, path: p, exists: true, registered: false });
        }
    }
    return Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name));
}
export function createWorkspace(args) {
    const log = [];
    const name = sanitizeName(args.name);
    const root = WORKSPACE_ROOT;
    const rootLocal = toLocalPath(root);
    const dest = path.join(root, name);
    const destLocal = toLocalPath(dest);
    if (fs.existsSync(destLocal)) {
        throw new Error(`workspace ja existe: ${toWindowsPath(destLocal)}`);
    }
    ensureDir(destLocal);
    // Create an empty MQL5 tree (internal workspace). No auto-import from any external MT5 folder.
    const mql5 = path.join(destLocal, "MQL5");
    const subdirs = [
        "Indicators",
        "Experts",
        "Scripts",
        "Services",
        "Files",
        "Include",
        "Libraries",
        "Presets",
        "Profiles",
        "Logs"
    ];
    ensureDir(mql5);
    for (const s of subdirs)
        ensureDir(path.join(mql5, s));
    // Common cmdmt workspace dirs (avoid root-level "config" which conflicts with MT5 "Config").
    ensureDir(path.join(destLocal, "reports"));
    ensureDir(path.join(destLocal, "cmdmt-artifacts"));
    log.push(`OK workspace criado: ${toWindowsPath(destLocal)}`);
    const cfg = readJson(args.configPath);
    if (!cfg.workspaces)
        cfg.workspaces = {};
    cfg.workspaces[name] = {
        createdAt: new Date().toISOString()
    };
    writeJson(args.configPath, cfg);
    log.push(`OK registry atualizado: ${args.configPath}`);
    log.push(`OK root: ${toWindowsPath(rootLocal)}`);
    return log;
}
export function removeWorkspace(args) {
    const log = [];
    const name = sanitizeName(args.name);
    const cfg = readJson(args.configPath);
    if (!cfg.workspaces || !cfg.workspaces[name]) {
        throw new Error(`workspace nao registrado: ${name}`);
    }
    delete cfg.workspaces[name];
    writeJson(args.configPath, cfg);
    log.push(`OK workspace removido do registry (sem apagar arquivos): ${name}`);
    return log;
}
export function getActiveWorkspace(args) {
    const cfg = readJson(args.configPath);
    const activeName = typeof cfg.workspace === "string" ? cfg.workspace.trim() : "";
    if (!activeName)
        return null;
    const entries = listWorkspaces({
        configPath: args.configPath,
    });
    return entries.find((e) => e.name === activeName) ?? null;
}
export function useWorkspace(args) {
    const log = [];
    const name = sanitizeName(args.name);
    const entries = listWorkspaces({
        configPath: args.configPath,
    });
    const selected = entries.find((e) => e.name === name);
    if (!selected) {
        throw new Error(`workspace nao encontrado: ${name}`);
    }
    if (!selected.exists) {
        throw new Error(`workspace sem pasta fisica: ${name}`);
    }
    const cfg = readJson(args.configPath);
    if (!cfg.workspaces)
        cfg.workspaces = {};
    if (!cfg.workspaces[name]) {
        cfg.workspaces[name] = {
            createdAt: new Date().toISOString()
        };
    }
    cfg.workspace = name;
    writeJson(args.configPath, cfg);
    log.push(`OK workspace ativo: ${name}`);
    log.push(`OK path: ${selected.path}`);
    return log;
}
export function resolveWorkspaceRoot(_args) {
    const root = WORKSPACE_ROOT;
    return isWindowsPath(root) && isWsl() ? toWindowsPath(root) : root;
}
function scanDirLinks(dirPath) {
    const out = [];
    if (!fs.existsSync(dirPath))
        return out;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const ent of entries) {
        if (!ent.isDirectory() && !ent.isSymbolicLink())
            continue;
        const full = path.join(dirPath, ent.name);
        try {
            const st = fs.lstatSync(full);
            if (st.isSymbolicLink()) {
                out.push({ name: ent.name, kind: "link" });
            }
            else if (st.isDirectory()) {
                out.push({ name: ent.name, kind: "dir" });
            }
            else if (st.isFile()) {
                out.push({ name: ent.name, kind: "file" });
            }
            else {
                out.push({ name: ent.name, kind: "file" });
            }
        }
        catch {
            out.push({ name: ent.name, kind: "missing" });
        }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}
export function listWorkspaceLinks(args) {
    const baseLocal = toLocalPath(args.workspacePath);
    const runtime = path.join(baseLocal, ".cmdmt", "terminal");
    const expertsDir = path.join(runtime, "MQL5", "Experts");
    const indicatorsDir = path.join(runtime, "MQL5", "Indicators");
    return {
        experts: scanDirLinks(expertsDir),
        indicators: scanDirLinks(indicatorsDir)
    };
}
