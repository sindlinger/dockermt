import fs from "node:fs";
import path from "node:path";
import { isWindowsPath, isWsl, toWslPath, toWindowsPath } from "./config.js";
function toLocalPath(p) {
    return isWsl() && isWindowsPath(p) ? toWslPath(p) : p;
}
function ensureDir(p) {
    if (!fs.existsSync(p))
        fs.mkdirSync(p, { recursive: true });
}
function normalizeSourcePath(input) {
    const trimmed = input.trim().replace(/^"+|"+$/g, "");
    if (!trimmed)
        return "";
    const local = toLocalPath(trimmed);
    return path.resolve(local);
}
function assertNotSymlink(filePath) {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink()) {
        throw new Error(`addons: links/junctions nao sao permitidos (${toWindowsPath(filePath)})`);
    }
}
function shouldSkipEntryName(name) {
    const n = name.toLowerCase();
    if (n === ".git" || n === ".svn" || n === ".hg")
        return true;
    if (n === "__pycache__")
        return true;
    if (n.endsWith(".locked"))
        return true;
    return false;
}
function copyRecursiveNoLinks(source, destination) {
    assertNotSymlink(source);
    const st = fs.statSync(source);
    if (st.isDirectory()) {
        ensureDir(destination);
        let copied = 0;
        const entries = fs.readdirSync(source, { withFileTypes: true });
        for (const entry of entries) {
            if (shouldSkipEntryName(entry.name))
                continue;
            const src = path.join(source, entry.name);
            const dst = path.join(destination, entry.name);
            copied += copyRecursiveNoLinks(src, dst);
        }
        return copied;
    }
    ensureDir(path.dirname(destination));
    try {
        fs.copyFileSync(source, destination);
    }
    catch (e) {
        if (e && (e.code === "EACCES" || e.code === "EPERM"))
            return 0;
        throw e;
    }
    return 1;
}
function removeRecursiveNoLinks(target) {
    if (!fs.existsSync(target))
        return 0;
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) {
        throw new Error(`addons: links/junctions nao sao permitidos (${toWindowsPath(target)})`);
    }
    if (st.isDirectory()) {
        let removed = 0;
        const entries = fs.readdirSync(target, { withFileTypes: true });
        for (const entry of entries) {
            const child = path.join(target, entry.name);
            removed += removeRecursiveNoLinks(child);
        }
        fs.rmdirSync(target);
        return removed;
    }
    fs.unlinkSync(target);
    return 1;
}
function syncRecursiveNoLinks(source, destination) {
    assertNotSymlink(source);
    const st = fs.statSync(source);
    if (st.isDirectory()) {
        if (fs.existsSync(destination)) {
            const dstL = fs.lstatSync(destination);
            if (dstL.isSymbolicLink()) {
                throw new Error(`addons: links/junctions nao sao permitidos (${toWindowsPath(destination)})`);
            }
            if (!dstL.isDirectory()) {
                removeRecursiveNoLinks(destination);
                ensureDir(destination);
            }
        }
        else {
            ensureDir(destination);
        }
        let copied = 0;
        let deleted = 0;
        const srcEntries = fs
            .readdirSync(source, { withFileTypes: true })
            .filter((entry) => !shouldSkipEntryName(entry.name));
        const srcNames = new Set(srcEntries.map((entry) => entry.name));
        for (const entry of srcEntries) {
            const src = path.join(source, entry.name);
            const dst = path.join(destination, entry.name);
            const out = syncRecursiveNoLinks(src, dst);
            copied += out.copied;
            deleted += out.deleted;
        }
        const dstEntries = fs.readdirSync(destination, { withFileTypes: true });
        for (const entry of dstEntries) {
            if (shouldSkipEntryName(entry.name))
                continue;
            if (srcNames.has(entry.name))
                continue;
            const dst = path.join(destination, entry.name);
            deleted += removeRecursiveNoLinks(dst);
        }
        return { copied, deleted };
    }
    ensureDir(path.dirname(destination));
    if (fs.existsSync(destination)) {
        const dstL = fs.lstatSync(destination);
        if (dstL.isSymbolicLink()) {
            throw new Error(`addons: links/junctions nao sao permitidos (${toWindowsPath(destination)})`);
        }
        if (dstL.isDirectory()) {
            removeRecursiveNoLinks(destination);
        }
    }
    fs.copyFileSync(source, destination);
    return { copied: 1, deleted: 0 };
}
function copyIntoRoot(sourcePath, rootDir, mode = "merge") {
    ensureDir(rootDir);
    const baseName = path.basename(sourcePath);
    const destination = path.join(rootDir, baseName);
    if (mode === "sync") {
        const out = syncRecursiveNoLinks(sourcePath, destination);
        return { destination, filesCopied: out.copied, filesDeleted: out.deleted };
    }
    const filesCopied = copyRecursiveNoLinks(sourcePath, destination);
    return { destination, filesCopied, filesDeleted: 0 };
}
function resolveWorkspaceRootFromDataPath(dataPath) {
    const local = toLocalPath(dataPath);
    return path.resolve(local, "..", "..");
}
function mql5TargetForKind(kind) {
    if (kind === "expert")
        return "Experts";
    if (kind === "indicator")
        return "Indicators";
    return "Libraries";
}
function packTargetForKind(kind, dirs) {
    if (kind === "expert")
        return dirs.packsExperts;
    if (kind === "indicator")
        return dirs.packsIndicators;
    return dirs.packsLibraries;
}
export function ensureAddonPacksDirs(dataPath) {
    const workspaceRoot = resolveWorkspaceRootFromDataPath(dataPath);
    const packsRoot = path.join(workspaceRoot, "packs");
    const packsExperts = path.join(packsRoot, "Experts");
    const packsIndicators = path.join(packsRoot, "Indicators");
    const packsLibraries = path.join(packsRoot, "Libraries");
    ensureDir(packsRoot);
    ensureDir(packsExperts);
    ensureDir(packsIndicators);
    ensureDir(packsLibraries);
    return { workspaceRoot, packsRoot, packsExperts, packsIndicators, packsLibraries };
}
export function detectFilesPackLayout(source) {
    const sourceResolved = normalizeSourcePath(source);
    if (!sourceResolved || !fs.existsSync(sourceResolved))
        return null;
    assertNotSymlink(sourceResolved);
    const st = fs.statSync(sourceResolved);
    if (!st.isDirectory())
        return null;
    const entries = fs.readdirSync(sourceResolved, { withFileTypes: true });
    const expDirs = [];
    const indDirs = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const name = entry.name;
        if (/^EXP-/i.test(name))
            expDirs.push(path.join(sourceResolved, name));
        if (/^IND-/i.test(name))
            indDirs.push(path.join(sourceResolved, name));
    }
    if (!expDirs.length || !indDirs.length)
        return null;
    expDirs.sort((a, b) => a.localeCompare(b));
    indDirs.sort((a, b) => a.localeCompare(b));
    return { sourceResolved, expDirs, indDirs };
}
export function importAddonFromPath(args) {
    const sourceResolved = normalizeSourcePath(args.source);
    if (!sourceResolved)
        throw new Error("addons: caminho da origem vazio.");
    if (!fs.existsSync(sourceResolved)) {
        throw new Error(`addons: caminho nao encontrado (${toWindowsPath(sourceResolved)})`);
    }
    const mode = args.mode === "sync" ? "sync" : "merge";
    const dirs = ensureAddonPacksDirs(args.dataPath);
    const dataRoot = toLocalPath(args.dataPath);
    const mql5Root = path.join(dataRoot, "MQL5");
    const mql5TargetRoot = path.join(mql5Root, mql5TargetForKind(args.kind));
    ensureDir(mql5TargetRoot);
    const packRoot = packTargetForKind(args.kind, dirs);
    const packCopy = copyIntoRoot(sourceResolved, packRoot, mode);
    const mqlCopy = copyIntoRoot(packCopy.destination, mql5TargetRoot, mode);
    return {
        kind: args.kind,
        mode,
        source: args.source,
        sourceResolved,
        packPath: packCopy.destination,
        mql5Path: mqlCopy.destination,
        filesCopiedToPack: packCopy.filesCopied,
        filesCopiedToMql5: mqlCopy.filesCopied,
        filesDeletedFromPack: packCopy.filesDeleted,
        filesDeletedFromMql5: mqlCopy.filesDeleted
    };
}
export function importFilesPackLayout(args) {
    const layout = detectFilesPackLayout(args.source);
    if (!layout) {
        throw new Error("addons: diretorio nao segue layout de pacote (esperado EXP-* e IND-*).");
    }
    const imported = [];
    for (const expDir of layout.expDirs) {
        imported.push(importAddonFromPath({ kind: "expert", source: expDir, dataPath: args.dataPath, mode: args.mode }));
    }
    for (const indDir of layout.indDirs) {
        imported.push(importAddonFromPath({ kind: "indicator", source: indDir, dataPath: args.dataPath, mode: args.mode }));
    }
    return { sourceResolved: layout.sourceResolved, imported };
}
