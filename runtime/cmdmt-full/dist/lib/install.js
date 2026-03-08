import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isWsl, toWslPath, toWindowsPath, isWindowsPath } from "./config.js";
import { readTextWithEncoding, writeTextWithEncoding } from "./textfile.js";
import { applyIniPatch, readIniValue } from "./iniMap.js";
import { MT5_INI } from "../types/mt5IniKeys.js";
import { INTERNAL_TELNET_PORT } from "../types/internalDefaults.js";
function normalizeDataPath(raw) {
    if (!raw)
        return null;
    let p = raw.trim().replace(/^"|"$/g, "");
    if (!p)
        return null;
    const lower = p.toLowerCase().replace(/\\/g, "/");
    if (lower.endsWith("/mql5")) {
        p = path.dirname(p);
    }
    return p;
}
function checkPathExists(p) {
    try {
        return fs.existsSync(p);
    }
    catch {
        return false;
    }
}
function isWithinRoot(targetAbs, rootAbs) {
    const rel = path.relative(rootAbs, targetAbs);
    if (!rel)
        return true;
    if (rel === "." || rel === path.sep)
        return true;
    return !rel.startsWith("..") && !path.isAbsolute(rel);
}
function assertNotLink(p, label) {
    if (!fs.existsSync(p))
        return;
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {
        throw new Error(`install bloqueado: ${label} e um link/junction (${toWindowsPath(p)})`);
    }
}
function assertInternalInstallDataPath(cmdmtRoot, dataPathWsl) {
    const cmdmtAbs = path.resolve(cmdmtRoot);
    const wsRootAbs = path.resolve(cmdmtAbs, "workspaces");
    const dataAbs = path.resolve(dataPathWsl);
    // Hard block: never write outside cmdmt/workspaces.
    if (!isWithinRoot(dataAbs, wsRootAbs)) {
        throw new Error("install bloqueado: MT5_DATA fora do workspace interno (cmdmt/workspaces).");
    }
    // Hard block: MT5_DATA must be the internal portable runtime.
    const norm = dataAbs.replace(/\\/g, "/").toLowerCase();
    if (!norm.endsWith("/.cmdmt/terminal")) {
        throw new Error("install bloqueado: MT5_DATA invalido (esperado terminar em /.cmdmt/terminal).");
    }
    // Hard block: refuse to operate if any critical directory is a link.
    const wsDirAbs = path.resolve(dataAbs, "..", ".."); // .../workspaces/<ws>
    const dotCmdmtAbs = path.resolve(dataAbs, ".."); // .../workspaces/<ws>/.cmdmt
    assertNotLink(wsRootAbs, "workspaces");
    assertNotLink(wsDirAbs, "workspace");
    assertNotLink(dotCmdmtAbs, ".cmdmt");
    assertNotLink(dataAbs, "MT5_DATA");
    const critical = [
        "Config",
        "MQL5",
        path.join("MQL5", "Experts"),
        path.join("MQL5", "Indicators"),
        path.join("MQL5", "Files"),
        path.join("MQL5", "Libraries"),
        path.join("MQL5", "Include"),
        path.join("MQL5", "Services"),
        path.join("MQL5", "Profiles"),
        path.join("MQL5", "Presets"),
        path.join("MQL5", "Logs")
    ];
    for (const rel of critical) {
        assertNotLink(path.join(dataAbs, rel), rel);
    }
    const scanChildren = (dir, label) => {
        if (!fs.existsSync(dir))
            return;
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (fs.lstatSync(full).isSymbolicLink()) {
                throw new Error(`install bloqueado: ${label} contem link/junction (${ent.name}).`);
            }
        }
    };
    scanChildren(path.join(dataAbs, "MQL5", "Experts"), "MQL5/Experts");
    scanChildren(path.join(dataAbs, "MQL5", "Indicators"), "MQL5/Indicators");
}
function statusLine(status, msg, log) {
    log.push(`[${status}] ${msg}`);
}
function ensureLocalShim(binPath, content, dryRun, log) {
    try {
        if (fs.existsSync(binPath)) {
            const existing = fs.readFileSync(binPath, "utf-8");
            const managed = existing.includes("MT5Commander") && existing.includes("cmdmt/dist/index.js");
            if (existing === content) {
                statusLine("OK", `shim ok: ${binPath}`, log);
                return;
            }
            if (!managed) {
                statusLine("WARN", `shim existe e nao foi alterado: ${binPath}`, log);
                return;
            }
        }
        if (dryRun) {
            statusLine("OK", `dry-run: criaria shim ${binPath}`, log);
            return;
        }
        fs.mkdirSync(path.dirname(binPath), { recursive: true });
        fs.writeFileSync(binPath, content, "utf-8");
        try {
            fs.chmodSync(binPath, 0o755);
        }
        catch {
            // ignore chmod errors on non-posix fs
        }
        statusLine("OK", `shim criado: ${binPath}`, log);
    }
    catch (err) {
        statusLine("WARN", `falha ao criar shim ${binPath}: ${String(err)}`, log);
    }
}
function ensureCmdmtShims(cmdmtRoot, dryRun, log) {
    if (!cmdmtRoot)
        return;
    if (!isWsl())
        return;
    const localBin = path.join(os.homedir(), ".local", "bin");
    const cmdmtShim = `#!/usr/bin/env bash
set -euo pipefail
ROOT="${cmdmtRoot}"
exec node "$ROOT/cmdmt/dist/index.js" "$@"
`;
    const pyplotShim = `#!/usr/bin/env bash
set -euo pipefail
ROOT="${cmdmtRoot}"
ENV_FILE="$ROOT/.env"
PYTHONW=""
UI=""
if [[ -f "$ENV_FILE" ]]; then
  PYTHONW=$(sed -n 's/^PYPLOT_PYTHONW=//p' "$ENV_FILE" | tail -n 1)
  UI=$(sed -n 's/^PYPLOT_UI=//p' "$ENV_FILE" | tail -n 1)
fi
if [[ -n "$PYTHONW" && -n "$UI" ]]; then
  cmd.exe /c "\\\"$PYTHONW\\\" \\\"$UI\\\""
  exit $?
fi
exec python3 "$ROOT/PyplotMT/app/src/pyshared_hub/PyShared_hub_ui.py" "$@"
`;
    const dukaShim = `#!/usr/bin/env bash
set -euo pipefail
ROOT="${cmdmtRoot}"
exec node "$ROOT/cmdmt/cli-duka-account/cli-demo-account.mjs" "$@"
`;
    ensureLocalShim(path.join(localBin, "cmdmt"), cmdmtShim, dryRun, log);
    ensureLocalShim(path.join(localBin, "pyplotmt"), pyplotShim, dryRun, log);
    ensureLocalShim(path.join(localBin, "cli-duka-account"), dukaShim, dryRun, log);
    const pathEnv = process.env.PATH || "";
    if (!pathEnv.split(path.delimiter).includes(localBin)) {
        statusLine("WARN", `PATH nao contem ${localBin}. Adicione ao seu shell.`, log);
    }
}
function findTelnetMtRoot(start) {
    let dir = path.resolve(start);
    for (let i = 0; i < 6; i++) {
        const candidates = [
            { probe: path.join(dir, "cmdmt", "TelnetmtService", "Services"), root: path.join(dir, "cmdmt", "TelnetmtService") },
            { probe: path.join(dir, "TelnetmtService", "Services"), root: path.join(dir, "TelnetmtService") },
            { probe: path.join(dir, "services", "telnetmt", "Services"), root: path.join(dir, "services", "telnetmt") },
            { probe: path.join(dir, "Services", "telnetmt", "Services"), root: path.join(dir, "Services", "telnetmt") },
            { probe: path.join(dir, "telnetmt", "Services"), root: path.join(dir, "telnetmt") }
        ];
        for (const cand of candidates) {
            if (fs.existsSync(cand.probe))
                return cand.root;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
function resolveCmdmtRootFromTelnetRoot(repoRoot) {
    const direct = path.join(repoRoot, "cmdmt");
    if (fs.existsSync(path.join(direct, "cmdmt.config.json")))
        return direct;
    if (fs.existsSync(path.join(repoRoot, "cmdmt.config.json")))
        return repoRoot;
    const parent = path.dirname(repoRoot);
    if (fs.existsSync(path.join(parent, "cmdmt.config.json")))
        return parent;
    return repoRoot;
}
function resolveSeedTerminalRoot(cmdmtRoot) {
    return path.join(cmdmtRoot, "mt5", "terminal");
}
function ensureInternalTerminalSeed(cmdmtRoot, dataPathWsl, dryRun, log) {
    const seedRoot = resolveSeedTerminalRoot(cmdmtRoot);
    const seedExe = path.join(seedRoot, "terminal64.exe");
    if (!fs.existsSync(seedExe)) {
        statusLine("FAIL", `seed MT5 ausente: ${toWindowsPath(seedExe)}`, log);
        return;
    }
    if (dryRun) {
        statusLine("OK", `dry-run: instalaria/atualizaria terminal seed em ${toWindowsPath(dataPathWsl)}`, log);
        return;
    }
    fs.mkdirSync(dataPathWsl, { recursive: true });
    const copyMissing = (src, dst) => {
        const st = fs.lstatSync(src);
        if (st.isSymbolicLink()) {
            // Avoid shipping links; resolve to real file/dir.
            copyMissing(fs.realpathSync(src), dst);
            return;
        }
        if (st.isDirectory()) {
            if (!fs.existsSync(dst))
                fs.mkdirSync(dst, { recursive: true });
            for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
                copyMissing(path.join(src, entry.name), path.join(dst, entry.name));
            }
            return;
        }
        if (!fs.existsSync(dst)) {
            fs.copyFileSync(src, dst);
        }
    };
    const entries = fs.readdirSync(seedRoot, { withFileTypes: true });
    const skip = new Set(["cmdmt-artifacts"]);
    for (const entry of entries) {
        if (skip.has(entry.name))
            continue;
        const src = path.join(seedRoot, entry.name);
        const dst = path.join(dataPathWsl, entry.name);
        if (entry.isDirectory()) {
            copyMissing(src, dst);
            continue;
        }
        if (entry.isFile()) {
            if (!fs.existsSync(dst))
                fs.copyFileSync(src, dst);
        }
    }
    statusLine("OK", `terminal seed ok: ${toWindowsPath(dataPathWsl)}`, log);
}
function applyServicesIniPort(dataPathWsl, dryRun, log) {
    const configDir = resolveConfigDir(dataPathWsl);
    const servicesPath = path.join(configDir, "services.ini");
    if (!fs.existsSync(servicesPath)) {
        statusLine("WARN", `services.ini ausente: ${toWindowsPath(servicesPath)}`, log);
        return;
    }
    const file = readTextWithEncoding(servicesPath);
    const next = file.text.replace(/InpPort=\d+/g, `InpPort=${INTERNAL_TELNET_PORT}`);
    if (next === file.text) {
        statusLine("OK", `services.ini port ok (${INTERNAL_TELNET_PORT})`, log);
        return;
    }
    if (dryRun) {
        statusLine("OK", `dry-run: ajustaria services.ini port=${INTERNAL_TELNET_PORT}`, log);
        return;
    }
    writeTextWithEncoding(servicesPath, next, file.encoding, file.bom);
    statusLine("OK", `services.ini port=${INTERNAL_TELNET_PORT}`, log);
}
function sortedPorts(text) {
    const out = new Set();
    for (const m of text.matchAll(/InpPort=(\d+)/g)) {
        const n = Number(m[1]);
        if (Number.isFinite(n))
            out.add(n);
    }
    return Array.from(out).sort((a, b) => a - b);
}
function formatBool(v) {
    if (v === undefined || v === null)
        return "(nao definido)";
    if (v === "1")
        return "1";
    if (v === "0")
        return "0";
    return v;
}
function resolveConfigDir(dataPathWsl) {
    const upper = path.join(dataPathWsl, "Config");
    const lower = path.join(dataPathWsl, "config");
    if (fs.existsSync(upper))
        return upper;
    if (fs.existsSync(lower))
        return lower;
    return upper;
}
function resolveCommonIniPath(dataPathWsl) {
    return path.join(resolveConfigDir(dataPathWsl), "common.ini");
}
function resolveTerminalIniPath(dataPathWsl) {
    return path.join(resolveConfigDir(dataPathWsl), "terminal.ini");
}
function applyCommonIni(spec, dataPathWsl, dryRun, log) {
    const configDir = resolveConfigDir(dataPathWsl);
    const commonPath = resolveCommonIniPath(dataPathWsl);
    const exists = fs.existsSync(commonPath);
    const file = exists
        ? readTextWithEncoding(commonPath)
        : { text: "", encoding: "utf16le", bom: true };
    const patch = {
        [MT5_INI.SECTION.EXPERTS]: {
            [MT5_INI.KEY.ALLOW_DLL_IMPORT]: spec.allowDll ? "1" : "0",
            [MT5_INI.KEY.ALLOW_LIVE_TRADING]: spec.allowLive ? "1" : "0"
        },
        [MT5_INI.SECTION.COMMON]: {
            [MT5_INI.KEY.LOGIN]: null,
            [MT5_INI.KEY.PASSWORD]: null,
            [MT5_INI.KEY.SERVER]: null
        }
    };
    if (spec.syncCommon) {
        patch[MT5_INI.SECTION.COMMON] = {
            [MT5_INI.KEY.LOGIN]: spec.login !== undefined ? String(spec.login) : undefined,
            [MT5_INI.KEY.PASSWORD]: spec.password,
            [MT5_INI.KEY.SERVER]: spec.server
        };
    }
    const next = applyIniPatch(file.text, patch);
    if (dryRun) {
        log.push("[DRY] write ini: " + toWindowsPath(commonPath));
        return;
    }
    fs.mkdirSync(configDir, { recursive: true });
    writeTextWithEncoding(commonPath, next, file.encoding, file.bom);
    log.push("[OK] write ini: " + toWindowsPath(commonPath));
}
function toWslMaybe(p) {
    if (!p)
        return p;
    if (isWsl() && isWindowsPath(p))
        return toWslPath(p);
    return p;
}
function ensureDir(p, dryRun, log) {
    if (fs.existsSync(p))
        return;
    if (dryRun) {
        log.push(`[DRY] mkdir: ${toWindowsPath(p)}`);
        return;
    }
    fs.mkdirSync(p, { recursive: true });
    log.push(`[OK] mkdir: ${toWindowsPath(p)}`);
}
function copyDirFiltered(srcDir, destDir, exts, dryRun, log) {
    if (!fs.existsSync(srcDir)) {
        log.push(`[WARN] origem ausente: ${toWindowsPath(srcDir)}`);
        return;
    }
    ensureDir(destDir, dryRun, log);
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile())
            continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!exts.includes(ext))
            continue;
        const src = path.join(srcDir, entry.name);
        const dest = path.join(destDir, entry.name);
        if (fs.existsSync(dest))
            continue;
        if (dryRun) {
            log.push(`[DRY] copy: ${toWindowsPath(src)} -> ${toWindowsPath(dest)}`);
            continue;
        }
        fs.copyFileSync(src, dest);
        log.push(`[OK] copy: ${toWindowsPath(dest)}`);
    }
}
function installTelnetFiles(repoRoot, dataPathWsl, dryRun, log) {
    const servicesSrc = path.join(repoRoot, "Services");
    const expertsSrc = path.join(repoRoot, "Experts");
    const scriptsSrc = path.join(repoRoot, "Scripts");
    const mql5Root = path.join(dataPathWsl, "MQL5");
    const servicesDstBundle = path.join(mql5Root, "Services", "TelnetMT_Services");
    const expertsDst = path.join(mql5Root, "Experts", "TelnetMT_Experts");
    const scriptsDst = path.join(mql5Root, "Scripts", "TelnetMT_Scripts");
    const extsAll = [".ex5", ".mq5", ".mqh"];
    const extsEx5 = [".ex5"];
    // Keep the full bundle organized under TelnetMT_* folders.
    copyDirFiltered(servicesSrc, servicesDstBundle, extsAll, dryRun, log);
    copyDirFiltered(expertsSrc, expertsDst, extsAll, dryRun, log);
    copyDirFiltered(scriptsSrc, scriptsDst, extsAll, dryRun, log);
    // Also copy the .ex5 services to MQL5/Services root for services.ini compatibility.
    const servicesDstRoot = path.join(mql5Root, "Services");
    copyDirFiltered(servicesSrc, servicesDstRoot, extsEx5, dryRun, log);
}
export function runDoctor(spec, cwd = process.cwd()) {
    const log = [];
    const repoInput = spec.repoPath
        ? (isWindowsPath(spec.repoPath) ? toWslPath(spec.repoPath) : spec.repoPath)
        : undefined;
    let repoRoot = repoInput ? path.resolve(repoInput) : findTelnetMtRoot(cwd) ?? "";
    if (repoRoot) {
        const svcService = path.join(repoRoot, "TelnetmtService", "Services");
        if (fs.existsSync(svcService))
            repoRoot = path.join(repoRoot, "TelnetmtService");
    }
    const cmdmtRoot = repoRoot ? resolveCmdmtRootFromTelnetRoot(repoRoot) : "";
    let dataPathRaw = normalizeDataPath(spec.dataPath);
    if (!dataPathRaw) {
        statusLine("FAIL", "MT5 dataPath nao informado.", log);
        statusLine("FAIL", "Use: doctor <MT5_DATA>.", log);
        return log.join("\n");
    }
    const dataPathWsl = isWsl() && /^[A-Za-z]:/.test(dataPathRaw) ? toWslPath(dataPathRaw) : dataPathRaw;
    const dataPathWin = toWindowsPath(dataPathWsl);
    statusLine("OK", `dataPath=${dataPathWin}`, log);
    const terminalExe = path.join(dataPathWsl, "terminal64.exe");
    statusLine(checkPathExists(terminalExe) ? "OK" : "FAIL", `terminal64.exe=${toWindowsPath(terminalExe)}`, log);
    const mql5Root = path.join(dataPathWsl, "MQL5");
    statusLine(checkPathExists(mql5Root) ? "OK" : "FAIL", `MQL5=${toWindowsPath(mql5Root)}`, log);
    const telnetSvcRoot = path.join(mql5Root, "Services", "TelnetMT_SocketTelnetService.ex5");
    const telnetSvcBundle = path.join(mql5Root, "Services", "TelnetMT_Services", "TelnetMT_SocketTelnetService.ex5");
    statusLine(checkPathExists(telnetSvcRoot) ? "OK" : "WARN", `TelnetMT svc(root)=${toWindowsPath(telnetSvcRoot)}`, log);
    statusLine(checkPathExists(telnetSvcBundle) ? "OK" : "WARN", `TelnetMT svc(bundle)=${toWindowsPath(telnetSvcBundle)}`, log);
    const servicesIni = path.join(resolveConfigDir(dataPathWsl), "services.ini");
    if (checkPathExists(servicesIni)) {
        try {
            const { text } = readTextWithEncoding(servicesIni);
            const ports = sortedPorts(text);
            statusLine("OK", `services.ini ports=${ports.join(",") || "(nenhum)"} expected=${INTERNAL_TELNET_PORT}`, log);
        }
        catch {
            statusLine("WARN", `services.ini leitura falhou: ${toWindowsPath(servicesIni)}`, log);
        }
    }
    else {
        statusLine("WARN", `services.ini ausente: ${toWindowsPath(servicesIni)}`, log);
    }
    const commonPath = resolveCommonIniPath(dataPathWsl);
    if (checkPathExists(commonPath)) {
        const { text } = readTextWithEncoding(commonPath);
        const dllVal = readIniValue(text, MT5_INI.SECTION.EXPERTS, MT5_INI.KEY.ALLOW_DLL_IMPORT);
        const liveVal = readIniValue(text, MT5_INI.SECTION.EXPERTS, MT5_INI.KEY.ALLOW_LIVE_TRADING);
        statusLine("OK", `common.ini ${MT5_INI.KEY.ALLOW_DLL_IMPORT}=${formatBool(dllVal)} ${MT5_INI.KEY.ALLOW_LIVE_TRADING}=${formatBool(liveVal)}`, log);
    }
    else {
        statusLine("WARN", `common.ini nao encontrado: ${toWindowsPath(commonPath)}`, log);
    }
    if (!cmdmtRoot) {
        statusLine("WARN", "cmdmt root nao encontrado (use --repo).", log);
    }
    else {
        statusLine("OK", `cmdmt=${toWindowsPath(cmdmtRoot)}`, log);
    }
    statusLine("OK", "modo seguro: nenhuma alteracao fora do workspace.", log);
    return log.join("\n");
}
export function runInstall(spec, cwd = process.cwd()) {
    const log = [];
    const repoInput = spec.repoPath
        ? (isWindowsPath(spec.repoPath) ? toWslPath(spec.repoPath) : spec.repoPath)
        : undefined;
    let repoRoot = repoInput ? path.resolve(repoInput) : findTelnetMtRoot(cwd) ?? "";
    if (repoRoot) {
        const svcService = path.join(repoRoot, "TelnetmtService", "Services");
        if (fs.existsSync(svcService))
            repoRoot = path.join(repoRoot, "TelnetmtService");
    }
    const cmdmtRoot = repoRoot ? resolveCmdmtRootFromTelnetRoot(repoRoot) : "";
    let dataPathRaw = normalizeDataPath(spec.dataPath);
    if (!dataPathRaw)
        throw new Error("mt5 data path ausente. Use workspace ativo.");
    const dataPathWsl = isWsl() && /^[A-Za-z]:/.test(dataPathRaw) ? toWslPath(dataPathRaw) : dataPathRaw;
    const dataPathWin = toWindowsPath(dataPathWsl);
    if (!cmdmtRoot)
        throw new Error("cmdmt root nao encontrado (use --repo).");
    assertInternalInstallDataPath(cmdmtRoot, dataPathWsl);
    log.push("MODO SEGURO: tudo acontece no workspace interno do cmdmt (nao usa terminal/pasta do usuario).");
    log.push(`mt5 interno: ${dataPathWin}`);
    // Ensure internal portable terminal files exist.
    ensureInternalTerminalSeed(cmdmtRoot, dataPathWsl, spec.dryRun, log);
    // Apply config patches.
    applyCommonIni(spec, dataPathWsl, spec.dryRun, log);
    applyServicesIniPort(dataPathWsl, spec.dryRun, log);
    // Install TelnetMT bundle.
    if (repoRoot && (spec.installTelnet ?? true)) {
        installTelnetFiles(repoRoot, dataPathWsl, spec.dryRun, log);
    }
    // WSL shims.
    ensureCmdmtShims(cmdmtRoot, spec.dryRun, log);
    if (spec.dryRun) {
        log.push("dry-run: nenhuma alteracao aplicada");
    }
    return log.join("\n");
}
