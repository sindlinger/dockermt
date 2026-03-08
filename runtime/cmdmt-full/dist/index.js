#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { handleError } from "./lib/errors.js";
import { splitArgs } from "./lib/args.js";
import { dispatch } from "./lib/dispatch.js";
import { sendLine, sendJson } from "./lib/transport.js";
import { runRepl } from "./repl.js";
import { renderBanner } from "./lib/banner.js";
import { requireRunner, requireTransport, resolveConfig, toWslPath, toWindowsPath, isWindowsPath, isWsl } from "./lib/config.js";
import { createExpertTemplate } from "./lib/template.js";
import { buildAttachReport, formatAttachReport, DEFAULT_ATTACH_META, findLatestLogFile } from "./lib/attach_report.js";
import { runConfigUi } from "./lib/config_ui.js";
import { resolveExpertFromRunner } from "./lib/expert_resolve.js";
import { performDataImport } from "./lib/data_import.js";
import { detectFilesPackLayout, ensureAddonPacksDirs, importAddonFromPath, importFilesPackLayout } from "./lib/addons.js";
import { readTextWithEncoding, writeTextWithEncoding } from "./lib/textfile.js";
import { toSendKeysTokens } from "./lib/keys.js";
import { loadAutoMacros, resolveAutoMacrosPath } from "./lib/auto_store.js";
import { containerStatesStorePath, listContainerStates, restoreContainerState, saveContainerState } from "./lib/container_states.js";
import { runTester, runTesterInContainer } from "./lib/tester.js";
let TRACE = false;
let CONFIRM_FALLBACK = null;
const HOST_CMDMT_PORT = Number.parseInt(process.env.TELNETMT_PORT || "41122", 10);
function trace(msg) {
    if (TRACE)
        process.stderr.write(`[trace] ${msg}\n`);
}
function resolvePyplotUiPath(repoPath) {
    const env = process.env.PYPLOT_UI?.trim() || process.env.PYPLOT_HUB_UI?.trim();
    if (env) {
        const wsl = isWindowsPath(env) ? toWslPath(env) : env;
        if (fs.existsSync(wsl))
            return env;
    }
    const resolved = resolvePyplotUiFromRepo(repoPath) ?? resolvePyplotUiFromRepo(process.cwd());
    if (resolved) {
        if (isWsl() && !isWindowsPath(resolved)) {
            const win = toWindowsPath(resolved);
            if (win)
                return win;
        }
        return resolved;
    }
    return null;
}
function findOnPath(exe) {
    const cmd = process.platform === "win32" ? "where" : "which";
    const res = spawnSync(cmd, [exe], { encoding: "utf8" });
    if (res.status !== 0 || !res.stdout)
        return null;
    const line = res.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
    return line || null;
}
function findWindowsExe(exe) {
    const res = spawnSync("cmd.exe", ["/c", "where", exe], { encoding: "utf8" });
    if (res.status !== 0 || !res.stdout)
        return null;
    const line = res.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
    return line || null;
}
function resolveExeCandidate(raw) {
    const trimmed = (raw || "").trim();
    if (!trimmed)
        return null;
    const pathLike = isWindowsPath(trimmed) || trimmed.includes("/") || trimmed.includes("\\");
    if (pathLike)
        return existsPath(trimmed) ? trimmed : null;
    if (isWsl()) {
        const win = findWindowsExe(trimmed);
        if (win)
            return win;
    }
    return findOnPath(trimmed);
}
function readEnvVarFromFile(filePath, key) {
    try {
        if (!fs.existsSync(filePath))
            return null;
        const text = fs.readFileSync(filePath, "utf8");
        const re = new RegExp(`^${key}=(.*)$`, "m");
        const m = text.match(re);
        if (!m)
            return null;
        return m[1].trim();
    }
    catch {
        return null;
    }
}
function resolvePyplotPythonBinary(envVars = process.env) {
    let env = envVars.PYPLOT_PYTHONW?.trim() || envVars.PYPLOT_PYTHON?.trim();
    if (!env) {
        const envPath = path.join(os.homedir(), ".cmdmt", ".env");
        env = readEnvVarFromFile(envPath, "PYPLOT_PYTHONW") || readEnvVarFromFile(envPath, "PYPLOT_PYTHON") || "";
    }
    const fromEnv = resolveExeCandidate(env);
    if (fromEnv)
        return fromEnv;
    if (isWsl()) {
        const win = findWindowsExe("pythonw.exe") || findWindowsExe("python.exe");
        if (win)
            return win;
    }
    const local = findOnPath("pythonw.exe") || findOnPath("python3") || findOnPath("python");
    if (local)
        return local;
    if (isWsl()) {
        const win = findWindowsExe("py.exe") || findWindowsExe("py");
        if (win)
            return win;
    }
    const py = findOnPath("py");
    if (py)
        return py;
    return null;
}
function resolvePyplotPython(envVars) {
    return resolvePyplotPythonBinary(envVars);
}
function buildPyplotEnv(resolved, commanderRoot) {
    const env = { ...process.env };
    const dataPathRaw = resolved.runner?.dataPath;
    if (dataPathRaw) {
        const dataPathWin = isWindowsPath(dataPathRaw) ? dataPathRaw : isWsl() ? toWindowsPath(dataPathRaw) : dataPathRaw;
        const mql5Win = dataPathWin.toLowerCase().endsWith("\\mql5")
            ? dataPathWin
            : path.win32.join(dataPathWin, "MQL5");
        env.PYPLOT_MQL5 = mql5Win;
        env.PYSHARED_CONFIG = path.win32.join(mql5Win, "Files", "pyshared_config.json");
    }
    if (commanderRoot) {
        const dllWsl = path.join(commanderRoot, "mt5ide", "dll", "PyShared_v2.dll");
        if (fs.existsSync(dllWsl)) {
            env.PYPLOT_DLL_SOURCE = isWsl() ? toWindowsPath(dllWsl) : dllWsl;
        }
    }
    return env;
}
function parseJsonSafe(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
function ensurePyplotAssets(dataPath, commanderRoot, dryRun, outputs) {
    const dataPathWsl = isWindowsPath(dataPath) ? toWslPath(dataPath) : dataPath;
    const dataPathWin = isWindowsPath(dataPath) ? dataPath : toWindowsPath(dataPathWsl);
    const mql5Wsl = dataPathWsl.toLowerCase().endsWith("/mql5") ? dataPathWsl : path.join(dataPathWsl, "MQL5");
    const mql5Win = dataPathWin.toLowerCase().endsWith("\\mql5") ? dataPathWin : path.win32.join(dataPathWin, "MQL5");
    const filesDir = path.join(mql5Wsl, "Files");
    const libsDir = path.join(mql5Wsl, "Libraries");
    const cfgPath = path.join(filesDir, "pyshared_config.json");
    let cfg = {};
    if (fs.existsSync(cfgPath)) {
        try {
            const raw = readTextWithEncoding(cfgPath).text.trim();
            const parsed = parseJsonSafe(raw);
            if (parsed && typeof parsed === "object")
                cfg = parsed;
        }
        catch {
            // ignore parse errors
        }
    }
    const dllName = typeof cfg.dll_name === "string" && cfg.dll_name ? cfg.dll_name : "PyShared_v2.dll";
    let dllPathWin = typeof cfg.dll_path === "string" && cfg.dll_path ? cfg.dll_path : "";
    let dllPathWsl = dllPathWin ? (isWindowsPath(dllPathWin) ? toWslPath(dllPathWin) : dllPathWin) : "";
    if (!dllPathWin) {
        dllPathWin = path.win32.join(mql5Win, "Libraries", dllName);
        dllPathWsl = path.join(libsDir, dllName);
    }
    const ensureDirs = [filesDir, libsDir];
    for (const dir of ensureDirs) {
        if (!fs.existsSync(dir)) {
            if (dryRun)
                outputs.push(`[DRY] mkdir: ${toWindowsPath(dir)}`);
            else
                fs.mkdirSync(dir, { recursive: true });
        }
    }
    const dllExists = dllPathWsl ? fs.existsSync(dllPathWsl) : false;
    if (!dllExists) {
        let src = null;
        if (commanderRoot) {
            const cand1 = path.join(commanderRoot, "mt5ide", "dll", dllName);
            const cand2 = path.join(commanderRoot, "PyplotMT", "app", "src", "pyshared_hub", dllName);
            if (fs.existsSync(cand1))
                src = cand1;
            else if (fs.existsSync(cand2))
                src = cand2;
        }
        if (!src) {
            outputs.push(`pyplot: DLL source nao encontrada (${dllName})`);
        }
        else if (dryRun) {
            outputs.push(`[DRY] copy: ${toWindowsPath(src)} -> ${toWindowsPath(dllPathWsl)}`);
        }
        else {
            fs.copyFileSync(src, dllPathWsl);
            outputs.push(`pyplot: DLL instalada (${toWindowsPath(dllPathWsl)})`);
        }
    }
    if (!cfg || Object.keys(cfg).length === 0 || cfg.dll_name !== dllName || cfg.dll_path !== dllPathWin) {
        const nextCfg = {
            ...cfg,
            dll_name: dllName,
            dll_path: dllPathWin,
            channel: cfg.channel || "MAIN",
            capacity_mb: cfg.capacity_mb || 8
        };
        if (dryRun) {
            outputs.push(`[DRY] write: ${toWindowsPath(cfgPath)}`);
        }
        else {
            writeTextWithEncoding(cfgPath, JSON.stringify(nextCfg, null, 2) + "\n", "utf8", false);
            outputs.push(`pyplot: config atualizado (${toWindowsPath(cfgPath)})`);
        }
    }
}
function launchPyplotUiResolved(uiPath, pythonExe, env) {
    const mergedEnv = env ?? process.env;
    if (isWsl() && isWindowsPath(pythonExe)) {
        const cmdArgs = ["/c", "start", "", pythonExe, uiPath];
        spawn("cmd.exe", cmdArgs, { detached: true, stdio: "ignore", env: mergedEnv }).unref();
        return;
    }
    spawn(pythonExe, [uiPath], { detached: true, stdio: "ignore", env: mergedEnv }).unref();
}
function resolvePyplotUiFromRepo(repoPath) {
    if (!repoPath)
        return null;
    const start = isWindowsPath(repoPath) ? toWslPath(repoPath) : repoPath;
    let current = path.resolve(start);
    for (;;) {
        const candidate = path.join(current, "pyplotmt", "app", "src", "pyshared_hub", "PyShared_hub_ui.py");
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        const parent = path.dirname(current);
        if (!parent || parent === current)
            break;
        current = parent;
    }
    return null;
}
function currentCmdmtRoot() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "..");
}
function resolveRepoRoot(repoPath) {
    if (!repoPath)
        return null;
    let root = isWindowsPath(repoPath) ? toWslPath(repoPath) : repoPath;
    root = path.resolve(root);
    const nested = path.join(root, "services", "telnetmt", "cmdmt");
    const commander = path.join(root, "cmdmt");
    if (fs.existsSync(path.join(nested, "package.json")))
        return nested;
    if (fs.existsSync(path.join(commander, "package.json")))
        return commander;
    if (fs.existsSync(path.join(root, "package.json")))
        return root;
    return null;
}
function shouldBuild(repoRoot, distPath) {
    if (!fs.existsSync(distPath))
        return true;
    const distStat = fs.statSync(distPath);
    const srcRoot = path.join(repoRoot, "src");
    if (fs.existsSync(srcRoot)) {
        const stack = [srcRoot];
        while (stack.length) {
            const dir = stack.pop();
            if (!dir)
                continue;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    stack.push(full);
                    continue;
                }
                if (!entry.isFile())
                    continue;
                if (!/\.(ts|tsx)$/.test(entry.name))
                    continue;
                if (fs.statSync(full).mtimeMs > distStat.mtimeMs)
                    return true;
            }
        }
    }
    const pkg = path.join(repoRoot, "package.json");
    if (fs.existsSync(pkg) && fs.statSync(pkg).mtimeMs > distStat.mtimeMs)
        return true;
    const tsconfig = path.join(repoRoot, "tsconfig.json");
    if (fs.existsSync(tsconfig) && fs.statSync(tsconfig).mtimeMs > distStat.mtimeMs)
        return true;
    return false;
}
function maybeDelegateToRepo(repoRoot, autoBuild) {
    const currentRoot = currentCmdmtRoot();
    if (path.resolve(repoRoot) === path.resolve(currentRoot))
        return false;
    const distPath = path.join(repoRoot, "dist", "index.js");
    if (autoBuild && shouldBuild(repoRoot, distPath)) {
        const build = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
        if (build.status !== 0) {
            process.exitCode = build.status ?? 1;
            return true;
        }
    }
    if (!fs.existsSync(distPath)) {
        process.stderr.write("WARN repoPath configurado mas dist/index.js nao encontrado; usando cmdmt atual.\n");
        return false;
    }
    const result = spawnSync(process.execPath, [distPath, ...process.argv.slice(2)], {
        stdio: "inherit",
        env: { ...process.env, CMDMT_DELEGATED: "1" }
    });
    process.exitCode = result.status ?? 1;
    return true;
}
function formatTraceResponse(resp) {
    const trimmed = resp.replace(/\s+$/, "");
    const lines = trimmed.split(/\r?\n/);
    if (lines.length > 80) {
        return lines.slice(0, 80).join("\n") + `\n... (${lines.length} lines)`;
    }
    if (trimmed.length > 4000) {
        return trimmed.slice(0, 4000) + `\n... (${trimmed.length} chars)`;
    }
    return trimmed;
}
function isErrorResponse(resp) {
    const up = resp.trim().toUpperCase();
    return up.startsWith("ERR") || up.includes(" ERR ") || up.includes("CODE=");
}
function extractDataLines(resp) {
    const lines = resp.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    while (lines.length && lines[0].toUpperCase().startsWith("OK"))
        lines.shift();
    return lines;
}
function maybeExplainError(resp) {
    const low = resp.toLowerCase();
    const has4802 = low.includes("code=4802") || low.includes(" 4802");
    const icustom = low.includes("icustom") || low.includes("indicator cannot be created");
    if (has4802 && icustom) {
        process.stderr.write("AVISO: indicador nao pode ser criado (4802).\n" +
            "Verifique se o .ex5 existe em MQL5/Indicators (nao em MQL5/Files) e se o nome/caminho esta correto.\n" +
            "Use caminho relativo sem extensao, ex: Subpasta\\\\NomeIndicador\n");
    }
}
function isBaseTplError(resp) {
    const low = resp.toLowerCase();
    return low.includes("base_tpl") || low.includes("invalid file name");
}
function runLocalSaveTplEA(params, resolved) {
    try {
        const runner = requireRunner(resolved);
        const expert = params[0] ?? "";
        const outTpl = params[1] ?? "";
        const baseTplRaw = params[2] ?? "";
        const baseTpl = baseTplRaw || resolved.baseTpl || "base.tpl";
        const paramStr = params.length > 3 ? params[3] : undefined;
        if (!expert || !outTpl) {
            return { ok: false, response: "ERR local_tpl: parametros invalidos para SAVE_TPL_EA" };
        }
        const generated = createExpertTemplate({
            expert,
            outTpl,
            baseTpl,
            params: paramStr,
            dataPath: runner.dataPath ?? ""
        });
        return { ok: true, response: `OK local_tpl:${generated}`, outTpl: generated };
    }
    catch (err) {
        return { ok: false, response: `ERR local_tpl:${String(err)}` };
    }
}
function parseChartList(resp) {
    const out = [];
    const lines = resp.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        if (!/^\d+\|/.test(line))
            continue;
        const parts = line.split("|");
        if (parts.length < 3)
            continue;
        out.push({ id: parts[0], sym: parts[1], tf: parts[2] });
    }
    return out;
}
function normalizeTf(tf) {
    const t = tf.toUpperCase();
    return t.startsWith("PERIOD_") ? t : `PERIOD_${t}`;
}
function buildPowerShellSendKeysScript(winPath, keys, delayMs) {
    const payload = JSON.stringify({ path: winPath, keys, delay: delayMs });
    return [
        `$payload = @'`,
        payload,
        `'@`,
        `$data = $payload | ConvertFrom-Json`,
        `$target = $data.path`,
        `$keys = $data.keys`,
        `$delay = [int]$data.delay`,
        `$proc = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | Select-Object -First 1`,
        `if (-not $proc) { Write-Error "process not found for $target"; exit 2 }`,
        `$p = Get-Process -Id $proc.ProcessId -ErrorAction Stop`,
        `$h = $p.MainWindowHandle`,
        `if ($h -eq 0) { Write-Error "window handle not found for $target"; exit 3 }`,
        `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@`,
        `[Win32]::ShowWindow([IntPtr]$h, 5) | Out-Null`,
        `[Win32]::SetForegroundWindow([IntPtr]$h) | Out-Null`,
        `Add-Type -AssemblyName System.Windows.Forms`,
        `foreach ($k in $keys) {`,
        `  if ($null -ne $k -and $k -ne "") {`,
        `    [System.Windows.Forms.SendKeys]::SendWait($k)`,
        `    if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }`,
        `  }`,
        `}`
    ].join("\n");
}
async function ensureChartOpen(sym, tf, transport) {
    const listResp = await executeSend({ type: "LIST_CHARTS", params: [] }, transport);
    const charts = parseChartList(listResp);
    const targetTf = normalizeTf(tf);
    if (charts.some((c) => c.sym === sym && c.tf === targetTf))
        return;
    await executeSend({ type: "OPEN_CHART", params: [sym, tf] }, transport);
}
function readTextMaybeUtf16(p) {
    const raw = fs.readFileSync(p);
    if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
        return raw.slice(2).toString("utf16le");
    }
    return raw.toString("utf8");
}
function normalizeExpertName(expert) {
    let e = expert.replace(/\//g, "\\");
    const lower = e.toLowerCase();
    const marker = "\\mql5\\experts\\";
    const idx = lower.indexOf(marker);
    if (idx >= 0)
        e = e.slice(idx + marker.length);
    const low2 = e.toLowerCase();
    if (low2.startsWith("experts\\"))
        e = e.slice("Experts\\".length);
    if (e.toLowerCase().endsWith(".ex5") || e.toLowerCase().endsWith(".mq5")) {
        e = e.slice(0, -4);
    }
    return e;
}
function expertNameCandidates(expert) {
    const norm = normalizeExpertName(expert);
    const base = path.win32.basename(norm);
    const out = new Set();
    if (norm)
        out.add(norm);
    if (base)
        out.add(base);
    return Array.from(out);
}
async function verifyExpertAttached(sym, tf, expertName, transport, dataPath) {
    const listResp = await executeSend({ type: "LIST_CHARTS", params: [] }, transport);
    const charts = parseChartList(listResp);
    const targetTf = normalizeTf(tf);
    const candidates = charts.filter((c) => c.sym === sym && c.tf === targetTf);
    trace(`verify_ea charts=${charts.length} match=${candidates.length} sym=${sym} tf=${targetTf}`);
    if (!candidates.length)
        return false;
    const templatesDir = path.join(toWslPath(dataPath), "MQL5", "Profiles", "Templates");
    const expCandidates = expertNameCandidates(expertName).map((v) => v.toLowerCase());
    trace(`verify_ea names=${expCandidates.join(",")}`);
    for (const chart of candidates) {
        const checkName = `__cmdmt_check_${Date.now()}_${chart.id}`;
        await executeSend({ type: "CHART_SAVE_TPL", params: [chart.id, checkName] }, transport);
        const tplPath = path.join(templatesDir, `${checkName}.tpl`);
        if (!fs.existsSync(tplPath)) {
            trace(`verify_ea tpl_missing=${tplPath}`);
            continue;
        }
        const txt = readTextMaybeUtf16(tplPath);
        try {
            fs.unlinkSync(tplPath);
        }
        catch {
            // ignore
        }
        const lower = txt.toLowerCase();
        const s = lower.indexOf("<expert>");
        if (s < 0)
            continue;
        const e = lower.indexOf("</expert>", s);
        if (e < 0)
            continue;
        const block = lower.slice(s, e);
        if (expCandidates.some((exp) => block.includes(`name=${exp}`))) {
            trace(`verify_ea ok chart=${chart.id}`);
            return true;
        }
    }
    return false;
}
function existsPath(p) {
    if (!p)
        return false;
    const local = isWindowsPath(p) ? toWslPath(p) : p;
    return fs.existsSync(local);
}
function detectMqlKind(filePath) {
    try {
        const local = isWindowsPath(filePath) ? toWslPath(filePath) : filePath;
        const text = fs.readFileSync(local, "utf8").toLowerCase();
        if (text.includes("#property indicator_") || text.includes("indicator_separate_window") || text.includes("indicator_chart_window"))
            return "indicator";
        if (text.includes("#property script"))
            return "script";
        if (text.includes("ontick") || text.includes("ontrade") || text.includes("ontradeevent"))
            return "expert";
        return "unknown";
    }
    catch {
        return "unknown";
    }
}
function resolveCompilePath(resolved) {
    const env = process.env.CMDMT_COMPILE?.trim();
    const builtInWsl = "/mnt/c/git/MT5Commander/cmdmt/TelnetmtService/tools/mt5-compile.exe";
    const builtInWin = "C:\\git\\MT5Commander\\cmdmt\\TelnetmtService\\tools\\mt5-compile.exe";
    const candidates = [
        resolved.compilePath,
        env,
        builtInWsl,
        builtInWin
    ].filter(Boolean);
    for (const c of candidates) {
        if (existsPath(c))
            return c;
    }
    return null;
}
function deriveMt5Home(resolved) {
    const candidate = resolved.runner?.metaeditorPath ?? resolved.runner?.terminalPath;
    if (!candidate)
        return null;
    const winPath = isWindowsPath(candidate) ? candidate : isWsl() ? toWindowsPath(candidate) : candidate;
    if (isWindowsPath(winPath))
        return path.win32.dirname(winPath);
    return path.dirname(winPath);
}
function deriveMt5HomeFromDataPath(dataPath) {
    if (!dataPath)
        return null;
    const dataWsl = isWindowsPath(dataPath) && isWsl() ? toWslPath(dataPath) : dataPath;
    const originPath = path.join(dataWsl, "origin.txt");
    if (!fs.existsSync(originPath))
        return null;
    try {
        const originRaw = readTextWithEncoding(originPath).text.trim();
        if (!originRaw)
            return null;
        const winPath = isWindowsPath(originRaw) ? originRaw : isWsl() ? toWindowsPath(originRaw) : originRaw;
        if (!winPath)
            return null;
        if (/\.exe$/i.test(winPath))
            return path.win32.dirname(winPath);
        return winPath;
    }
    catch {
        return null;
    }
}
function buildCompileEnv(resolved) {
    const env = { ...process.env };
    if (!env.MT5_HOME) {
        const home = deriveMt5Home(resolved) ?? deriveMt5HomeFromDataPath(resolved.runner?.dataPath);
        if (home)
            env.MT5_HOME = home;
    }
    return env;
}
function inferDataPathFromSource(src) {
    if (!src)
        return null;
    const raw = isWindowsPath(src) ? src.replace(/\\/g, "/") : src;
    const lower = raw.toLowerCase();
    const idx = lower.lastIndexOf("/mql5/");
    if (idx === -1)
        return null;
    const base = raw.slice(0, idx);
    if (!base)
        return null;
    return isWindowsPath(src) ? base.replace(/\//g, "\\") : base;
}
function isPlainFileName(p) {
    if (!p)
        return false;
    if (p.includes("/") || p.includes("\\"))
        return false;
    return true;
}
function collapseWinPath(p) {
    return p.replace(/[\\/]/g, "").toLowerCase();
}
function looksLikeCollapsedWinPath(p) {
    if (!/^[A-Za-z]:/i.test(p))
        return false;
    if (/[\\/]/.test(p))
        return false;
    return /\.mq[45]$/i.test(p);
}
function findFileRecursive(root, fileName, maxDepth = 6) {
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
        const { dir, depth } = queue.shift();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            let isFile = entry.isFile();
            let isDir = entry.isDirectory();
            if (entry.isSymbolicLink()) {
                try {
                    const stat = fs.statSync(full);
                    if (stat.isFile())
                        isFile = true;
                    if (stat.isDirectory())
                        isDir = true;
                }
                catch {
                    // ignore broken symlink
                }
            }
            if (isFile && entry.name.toLowerCase() === fileName.toLowerCase()) {
                return full;
            }
            if (isDir && depth < maxDepth) {
                queue.push({ dir: full, depth: depth + 1 });
            }
        }
    }
    return null;
}
function findFileByCollapsedPath(root, collapsedTarget, maxDepth = 10) {
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
        const { dir, depth } = queue.shift();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            let isFile = entry.isFile();
            let isDir = entry.isDirectory();
            if (entry.isSymbolicLink()) {
                try {
                    const stat = fs.statSync(full);
                    if (stat.isFile())
                        isFile = true;
                    if (stat.isDirectory())
                        isDir = true;
                }
                catch {
                    // ignore broken symlink
                }
            }
            if (isFile) {
                const winFull = toWindowsPath(full);
                if (collapseWinPath(winFull) === collapsedTarget)
                    return full;
            }
            if (isDir && depth < maxDepth) {
                queue.push({ dir: full, depth: depth + 1 });
            }
        }
    }
    return null;
}
function normalizeIndicatorRel(rel) {
    let out = rel.replace(/\\/g, "/");
    out = out.replace(/\.(mq5|ex5)$/i, "");
    out = out.replace(/^[/\\]+/, "");
    return out.replace(/\//g, "\\");
}
function normalizeIndicatorKey(name) {
    return name
        .toLowerCase()
        .replace(/\.(mq5|ex5)$/i, "")
        .replace(/[^a-z0-9]+/g, "");
}
function buildIndicatorAcronym(name) {
    const tokens = name
        .replace(/\.(mq5|ex5)$/i, "")
        .split(/[^a-z0-9]+/i)
        .filter(Boolean);
    if (!tokens.length)
        return "";
    return tokens.map((t) => t[0].toLowerCase()).join("");
}
function listIndicatorFiles(root, maxDepth = 6) {
    const out = [];
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
        const { dir, depth } = queue.shift();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            let isFile = entry.isFile();
            let isDir = entry.isDirectory();
            if (entry.isSymbolicLink()) {
                try {
                    const stat = fs.statSync(full);
                    if (stat.isFile())
                        isFile = true;
                    if (stat.isDirectory())
                        isDir = true;
                }
                catch {
                    // ignore broken symlink
                }
            }
            if (isFile && /\.(mq5|ex5)$/i.test(entry.name)) {
                const rel = path.relative(root, full);
                const ext = path.extname(entry.name).toLowerCase();
                const base = path.basename(entry.name, ext);
                out.push({ full, rel, base, ext, depth });
                continue;
            }
            if (isDir && depth < maxDepth) {
                queue.push({ dir: full, depth: depth + 1 });
            }
        }
    }
    return out;
}
function resolveIndicatorFromRunner(name, dataPath) {
    if (!dataPath)
        return null;
    if (!name)
        return null;
    const trimmed = name.trim().replace(/^"+|"+$/g, "");
    if (!trimmed)
        return null;
    const stripExt = (v) => v.replace(/\.(ex5|mq5)$/i, "");
    const base = path.join(toWslPath(dataPath), "MQL5", "Indicators");
    const hasExt = /\.(mq5|ex5)$/i.test(trimmed);
    const tryResolveAbsolute = (absPath) => {
        const normalized = absPath.replace(/\\/g, path.sep);
        if (!fs.existsSync(normalized))
            return null;
        if (!normalized.startsWith(base))
            return null;
        const rel = path.relative(base, normalized);
        return stripExt(normalizeIndicatorRel(rel));
    };
    if (isWindowsPath(trimmed)) {
        const rel = tryResolveAbsolute(toWslPath(trimmed));
        if (rel)
            return rel;
    }
    else if (path.isAbsolute(trimmed)) {
        const rel = tryResolveAbsolute(trimmed);
        if (rel)
            return rel;
    }
    let relInput = trimmed.replace(/^[/\\]+/, "");
    relInput = relInput.replace(/^mql5[\\/]/i, "");
    relInput = relInput.replace(/^indicators[\\/]/i, "");
    const relFs = relInput.replace(/\\/g, path.sep);
    if (hasExt && fs.existsSync(path.join(base, relFs))) {
        return stripExt(normalizeIndicatorRel(relInput));
    }
    if (!hasExt) {
        if (fs.existsSync(path.join(base, `${relFs}.ex5`))) {
            return stripExt(normalizeIndicatorRel(`${relInput}.ex5`));
        }
        if (fs.existsSync(path.join(base, `${relFs}.mq5`))) {
            return stripExt(normalizeIndicatorRel(`${relInput}.mq5`));
        }
    }
    if (!isPlainFileName(trimmed))
        return null;
    const candidates = hasExt ? [trimmed] : [`${trimmed}.ex5`, `${trimmed}.mq5`];
    for (const candidate of candidates) {
        const found = findFileRecursive(base, candidate);
        if (found) {
            const rel = path.relative(base, found);
            return stripExt(normalizeIndicatorRel(rel));
        }
    }
    const target = normalizeIndicatorKey(trimmed);
    if (!target)
        return null;
    const acronym = buildIndicatorAcronym(trimmed);
    const files = listIndicatorFiles(base);
    let best = null;
    for (const f of files) {
        const norm = normalizeIndicatorKey(f.base);
        if (!norm)
            continue;
        let score = 0;
        if (norm === target) {
            score = 10000 + norm.length;
        }
        else if (acronym && norm === acronym) {
            score = 9000 + norm.length;
        }
        else if (target.includes(norm) || norm.includes(target)) {
            score = 1000 + Math.min(norm.length, target.length);
        }
        if (score <= 0)
            continue;
        const extRank = f.ext === ".ex5" ? 2 : 1;
        const depth = f.depth;
        if (!best ||
            score > best.score ||
            (score === best.score && extRank > best.extRank) ||
            (score === best.score && extRank === best.extRank && depth < best.depth)) {
            best = { rel: f.rel, score, extRank, depth };
        }
    }
    if (best)
        return stripExt(normalizeIndicatorRel(best.rel));
    return null;
}
function resolveMqSourceFromRunner(input, dataPath) {
    if (!dataPath || !input)
        return null;
    const base = path.join(toWslPath(dataPath), "MQL5");
    const trimmed = input.trim().replace(/^"+|"+$/g, "");
    if (looksLikeCollapsedWinPath(trimmed)) {
        const collapsed = collapseWinPath(trimmed);
        const found = findFileByCollapsedPath(base, collapsed);
        if (found)
            return found;
    }
    const hasExt = /\.(mq4|mq5)$/i.test(input);
    const candidates = hasExt ? [input] : [`${input}.mq5`, `${input}.mq4`];
    const hasSeparators = input.includes("/") || input.includes("\\");
    for (const candidate of candidates) {
        if (hasSeparators) {
            const rel = candidate.replace(/^[/\\]+/, "");
            const full = path.join(base, rel);
            if (fs.existsSync(full))
                return full;
            continue;
        }
        const found = findFileRecursive(base, candidate);
        if (found)
            return found;
    }
    return null;
}
function tailLines(text, count) {
    const lines = text.split(/\r?\n/);
    if (count <= 0)
        return "";
    const start = Math.max(0, lines.length - count);
    return lines.slice(start).join("\n");
}
function resolveIndicatorFiles(name, dataPath) {
    if (!dataPath || !name)
        return {};
    const base = path.join(toWslPath(dataPath), "MQL5", "Indicators");
    const trimmed = name.trim().replace(/^"+|"+$/g, "");
    if (!trimmed)
        return {};
    const resolvedRel = resolveIndicatorFromRunner(trimmed, dataPath);
    if (resolvedRel) {
        const relFs = resolvedRel.replace(/\\/g, path.sep);
        return {
            rel: resolvedRel,
            mq5: path.join(base, `${relFs}.mq5`),
            ex5: path.join(base, `${relFs}.ex5`)
        };
    }
    const hasExt = /\.(mq5|ex5)$/i.test(trimmed);
    if (isWindowsPath(trimmed)) {
        const abs = toWslPath(trimmed);
        return hasExt
            ? { mq5: trimmed.toLowerCase().endsWith(".mq5") ? abs : undefined, ex5: trimmed.toLowerCase().endsWith(".ex5") ? abs : undefined }
            : { mq5: `${abs}.mq5`, ex5: `${abs}.ex5` };
    }
    if (path.isAbsolute(trimmed)) {
        return hasExt
            ? { mq5: trimmed.toLowerCase().endsWith(".mq5") ? trimmed : undefined, ex5: trimmed.toLowerCase().endsWith(".ex5") ? trimmed : undefined }
            : { mq5: `${trimmed}.mq5`, ex5: `${trimmed}.ex5` };
    }
    const relRaw = trimmed.replace(/^mql5[\\/]/i, "").replace(/^indicators[\\/]/i, "");
    const relFs = relRaw.replace(/\\/g, path.sep);
    return {
        rel: normalizeIndicatorRel(relRaw),
        mq5: path.join(base, `${relFs}.mq5`),
        ex5: path.join(base, `${relFs}.ex5`)
    };
}
function resolveExpertFiles(name, dataPath) {
    if (!dataPath || !name)
        return {};
    const resolved = resolveExpertFromRunner(name, dataPath);
    if (!resolved)
        return {};
    return {
        rel: resolved.name,
        mq5: resolved.mq5,
        ex5: resolved.ex5
    };
}
function updateHotkeyText(text, action, key, value) {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const sectionRe = /(^\[Hotkeys\][\s\S]*?)(?=^\[|\Z)/im;
    const match = text.match(sectionRe);
    const header = "[Hotkeys]";
    const safeKey = key?.trim() ?? "";
    if (!match) {
        if (action === "set" && safeKey && value) {
            return (text ? text + newline : "") + `${header}${newline}${safeKey}=${value}${newline}`;
        }
        if (action === "clear")
            return "";
        return text;
    }
    const block = match[1];
    const lines = block.split(/\r?\n/);
    const next = [lines[0] || header];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim())
            continue;
        if (safeKey && line.startsWith(`${safeKey}=`))
            continue;
        next.push(line);
    }
    if (action === "set" && safeKey && value) {
        next.push(`${safeKey}=${value}`);
    }
    if (action === "clear") {
        return text.replace(block, `${header}${newline}`);
    }
    const updated = next.join(newline) + newline;
    return text.replace(block, updated);
}
function toWindowsArgsIfNeeded(args, compilePath) {
    if (!isWsl())
        return args;
    const lower = compilePath.toLowerCase();
    const isWinTarget = isWindowsPath(compilePath) ||
        lower.endsWith(".cmd") ||
        lower.endsWith(".bat") ||
        (lower.endsWith(".exe") && isWsl());
    if (!isWinTarget)
        return args;
    return args.map((arg) => {
        if (!arg)
            return arg;
        const lowerArg = arg.toLowerCase();
        if (lowerArg.startsWith("/compile:") || lowerArg.startsWith("/log:"))
            return arg;
        if (arg.includes("/") || arg.includes("\\")) {
            return isWindowsPath(arg) ? arg : toWindowsPath(arg);
        }
        return arg;
    });
}
function isMetaEditorPath(p) {
    const base = path.basename(p).toLowerCase();
    return base.includes("metaeditor") && base.endsWith(".exe");
}
function looksLikeMqSource(p) {
    return /\.mq[45]$/i.test(p);
}
function buildMetaEditorArgs(src, args) {
    const hasCompile = args.some((a) => a.toLowerCase().startsWith("/compile:"));
    if (hasCompile)
        return args;
    const srcWin = isWindowsPath(src) ? src : isWsl() ? toWindowsPath(src) : src;
    const logArg = args.find((a) => a.toLowerCase().startsWith("/log:"));
    const logPath = logArg
        ? logArg.slice(5)
        : path.win32.join(path.win32.dirname(srcWin), "mt5-compile.log");
    return [`/compile:${srcWin}`, `/log:${logPath}`];
}
async function compileMqSource(src, resolved) {
    let compilePath = resolveCompilePath(resolved);
    if (!compilePath) {
        throw new Error("compile nao configurado. Use --compile-path, CMDMT_COMPILE ou defaults.compilePath no config.");
    }
    const args = isMetaEditorPath(compilePath) ? buildMetaEditorArgs(src, []) : [src];
    const env = buildCompileEnv(resolved);
    if (!env.MT5_HOME) {
        const dataPath = inferDataPathFromSource(src);
        const inferred = deriveMt5HomeFromDataPath(dataPath ?? undefined);
        if (inferred)
            env.MT5_HOME = inferred;
    }
    await runCompile(compilePath, toWindowsArgsIfNeeded(args, compilePath), env);
}
async function runCompile(pathOrCmd, args, env) {
    return new Promise((resolve, reject) => {
        const lower = pathOrCmd.toLowerCase();
        if (lower.endsWith(".cmd")) {
            reject(new Error("compile nao suporta .cmd. Use metaeditor.exe, mt5-compile.exe ou .bat."));
            return;
        }
        const envMerged = { ...process.env, ...(env ?? {}) };
        if (isWsl() && envMerged.MT5_HOME) {
            const wslEnv = envMerged.WSLENV ? envMerged.WSLENV.split(":").filter(Boolean) : [];
            const hasWin = isWindowsPath(envMerged.MT5_HOME);
            if (hasWin) {
                // Remove path-translation for MT5_HOME when already in Windows format.
                const filtered = wslEnv.filter((v) => v !== "MT5_HOME/p");
                if (!filtered.includes("MT5_HOME"))
                    filtered.push("MT5_HOME");
                envMerged.WSLENV = filtered.join(":");
            }
            else {
                if (!wslEnv.includes("MT5_HOME/p"))
                    wslEnv.push("MT5_HOME/p");
                envMerged.WSLENV = wslEnv.join(":");
            }
        }
        const quoteWin = (value) => {
            if (!/[\\s"]/g.test(value))
                return value;
            return `"${value.replace(/\"/g, '""')}"`;
        };
        const isBat = lower.endsWith(".bat");
        const winPath = isWindowsPath(pathOrCmd) ? pathOrCmd : isWsl() ? toWindowsPath(pathOrCmd) : pathOrCmd;
        const useCmd = isBat;
        const execPath = isWsl() && isWindowsPath(pathOrCmd) ? toWslPath(pathOrCmd) : pathOrCmd;
        const winArgs = toWindowsArgsIfNeeded(args, winPath);
        const cmdLine = [quoteWin(winPath), ...winArgs.map(quoteWin)].join(" ");
        const cmdArg = cmdLine.startsWith("\"") ? `"${cmdLine}"` : cmdLine;
        const child = useCmd
            ? spawn("cmd.exe", ["/c", cmdArg], {
                stdio: "inherit",
                env: envMerged
            })
            : spawn(execPath, args, { stdio: "inherit", env: envMerged });
        child.on("error", reject);
        child.on("exit", (code) => {
            let metaErrors = null;
            const isMeta = isMetaEditorPath(pathOrCmd);
            if (isMeta) {
                const logArg = args.find((a) => a.toLowerCase().startsWith("/log:"));
                if (logArg) {
                    const logPath = logArg.slice(5);
                    const local = isWindowsPath(logPath) ? toWslPath(logPath) : logPath;
                    try {
                        if (fs.existsSync(local)) {
                            const raw = readTextWithEncoding(local).text;
                            const text = raw.replace(/\0/g, "");
                            const tail = tailLines(text, 80);
                            if (tail.trim())
                                process.stdout.write(tail + "\n");
                            const match = text.match(/result:\s*(\d+)\s+errors/i);
                            if (match)
                                metaErrors = Number(match[1]);
                        }
                    }
                    catch {
                        // ignore log read errors
                    }
                }
            }
            if (!code || code === 0) {
                if (metaErrors !== null && metaErrors > 0) {
                    reject(new Error(`compile retornou ${metaErrors} errors`));
                    return;
                }
                resolve();
                return;
            }
            if (isMeta && metaErrors === 0) {
                resolve();
                return;
            }
            reject(new Error(`compile retornou ${code}`));
        });
    });
}
async function executeSend(action, transport) {
    if (action.type === "RAW") {
        const line = action.params[0] ?? "";
        trace(`send RAW ${line}`);
        const resp = await sendLine(line, transport);
        trace(`resp ${formatTraceResponse(resp)}`);
        return resp;
    }
    if (action.type === "JSON") {
        const raw = action.params[0] ?? "";
        let obj = raw;
        try {
            obj = JSON.parse(raw);
        }
        catch {
            // keep raw
        }
        trace(`send JSON ${typeof obj === "string" ? obj : JSON.stringify(obj)}`);
        const resp = await sendJson(obj, transport);
        trace(`resp ${formatTraceResponse(resp)}`);
        return resp;
    }
    const id = Date.now().toString();
    const line = [id, action.type, ...action.params].join("|");
    trace(`send ${line}`);
    const resp = await sendLine(line, transport);
    trace(`resp ${formatTraceResponse(resp)}`);
    return resp;
}
function extractErrorLines(resp) {
    const lines = resp.split(/\r?\n/);
    const kept = lines.filter((l) => /^(ERR|ERROR)\b/.test(l.trim()));
    return kept.length ? kept.join("\n") + "\n" : "";
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function pingTransport(transport) {
    try {
        const resp = await executeSend({ type: "PING", params: [] }, transport);
        return !isErrorResponse(resp);
    }
    catch {
        return false;
    }
}
function startTerminalMinimized(terminalPath, args = []) {
    const winPath = toWindowsPath(terminalPath);
    spawnSync("cmd.exe", ["/c", "start", "\"\"", "/min", winPath, ...args], { stdio: "ignore" });
}
function stopTerminalByPath(terminalPath) {
    const winPath = toWindowsPath(terminalPath);
    const script = "Get-Process terminal64 -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.Path -eq '" +
        winPath.replace(/'/g, "''") +
        "' } | Stop-Process -Force";
    spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
}
function isTerminalRunning(terminalPath) {
    const winPath = toWindowsPath(terminalPath);
    const script = "Get-Process terminal64 -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.Path -eq '" +
        winPath.replace(/'/g, "''") +
        "' } | Select-Object -First 1 -ExpandProperty Id";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
    const out = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return out.length > 0;
}
async function ensureServiceAvailable(runner, transport, attempts = 15, waitMs = 800) {
    if (await pingTransport(transport))
        return { started: false };
    if (!runner.terminalPath)
        return { started: false };
    const args = runner.portable ? ["/portable"] : [];
    startTerminalMinimized(runner.terminalPath, args);
    for (let i = 0; i < attempts; i++) {
        await sleep(waitMs);
        if (await pingTransport(transport))
            return { started: true };
    }
    return { started: true };
}
function resolveBaseTplName(baseTpl, dataPath) {
    const dataPathWsl = toWslPath(dataPath);
    const templatesDir = path.join(dataPathWsl, "MQL5", "Profiles", "Templates");
    if (baseTpl) {
        if (existsPath(baseTpl))
            return baseTpl;
        if (fs.existsSync(path.join(templatesDir, baseTpl)))
            return baseTpl;
    }
    const candidates = ["Moving Average.tpl", "Default.tpl", "default.tpl", "base.tpl", "Base.tpl"];
    for (const name of candidates) {
        if (fs.existsSync(path.join(templatesDir, name)))
            return name;
    }
    try {
        const files = fs.readdirSync(templatesDir)
            .filter((f) => /\.tpl$/i.test(f))
            .sort((a, b) => a.localeCompare(b));
        if (files.length)
            return files[0];
    }
    catch {
        // ignore
    }
    return "";
}
function resolveCommanderRoot(resolved) {
    const candidates = [];
    if (resolved.repoPath) {
        const repo = isWindowsPath(resolved.repoPath) ? toWslPath(resolved.repoPath) : resolved.repoPath;
        candidates.push(repo, path.dirname(repo));
    }
    const cmdmtRoot = currentCmdmtRoot();
    candidates.push(cmdmtRoot, path.dirname(cmdmtRoot));
    for (const raw of candidates) {
        if (!raw)
            continue;
        const base = path.resolve(raw);
        const hasCmdmt = fs.existsSync(path.join(base, "cmdmt", "package.json"));
        const hasMt5ide = fs.existsSync(path.join(base, "mt5ide", "package.json"));
        const hasPyplot = fs.existsSync(path.join(base, "PyplotMT")) || fs.existsSync(path.join(base, "pyplotmt"));
        if (hasCmdmt && hasMt5ide && hasPyplot)
            return base;
        if (fs.existsSync(path.join(base, "package.json")) && path.basename(base) === "cmdmt") {
            const parent = path.dirname(base);
            const ok = fs.existsSync(path.join(parent, "mt5ide", "package.json")) &&
                (fs.existsSync(path.join(parent, "PyplotMT")) || fs.existsSync(path.join(parent, "pyplotmt")));
            if (ok)
                return parent;
        }
    }
    return null;
}
function resolvePyplotRoot(commanderRoot) {
    const py = path.join(commanderRoot, "PyplotMT");
    if (fs.existsSync(py))
        return py;
    const lower = path.join(commanderRoot, "pyplotmt");
    if (fs.existsSync(lower))
        return lower;
    return null;
}
function resolveMt5ideRoot(commanderRoot) {
    const root = path.join(commanderRoot, "mt5ide");
    if (fs.existsSync(path.join(root, "package.json")))
        return root;
    return null;
}
function normalizeTargets(targets, allFlag) {
    if (allFlag)
        return ["mt5", "mt5ide", "telnet", "pyplot"];
    if (!targets || targets.length === 0)
        return ["mt5ide", "telnet", "pyplot"];
    const out = [];
    const seen = new Set();
    for (const t of targets) {
        if (t === "mt5" || t === "mt5ide" || t === "telnet" || t === "pyplot") {
            if (!seen.has(t)) {
                seen.add(t);
                out.push(t);
            }
        }
    }
    return out.length ? out : ["mt5ide", "telnet", "pyplot"];
}
async function confirmPlan(lines) {
    if (!process.stdin.isTTY) {
        if (CONFIRM_FALLBACK) {
            return CONFIRM_FALLBACK(lines);
        }
        process.stderr.write("confirmacao obrigatoria, mas sem TTY.\n");
        return false;
    }
    for (const line of lines)
        process.stdout.write(line + "\n");
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question("Confirma? [y/N] ", resolve));
    rl.close();
    const val = answer.trim().toLowerCase();
    return val === "y" || val === "yes" || val === "s" || val === "sim";
}
async function confirmUserFileOps(lines, assumeYes) {
    if (!lines.length)
        return true;
    if (assumeYes)
        return true;
    const plan = ["Operacoes em arquivos locais:", ...lines];
    return confirmPlan(plan);
}
async function promptRequired(question) {
    if (!process.stdin.isTTY) {
        process.stderr.write("entrada interativa requerida, mas sem TTY.\n");
        return null;
    }
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question(`${question}: `, resolve));
    rl.close();
    const value = answer.trim();
    return value || null;
}
async function promptText(question, defaultValue) {
    if (!process.stdin.isTTY) {
        process.stderr.write("entrada interativa requerida, mas sem TTY.\n");
        return null;
    }
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = `${question} [${defaultValue}]: `;
    const answer = await new Promise((resolve) => rl.question(prompt, resolve));
    rl.close();
    const value = answer.trim();
    return value || defaultValue;
}
function readHistoryDataPath(cfg) {
    const history = cfg.history;
    const last = typeof history?.lastDataPath === "string" ? history.lastDataPath : "";
    if (last)
        return last;
    const list = Array.isArray(history?.dataPaths) ? history.dataPaths : [];
    return list.length ? list[0] : null;
}
function runCmd(cmd, args, cwd) {
    const res = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: "inherit" });
    const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
    return { ok: res.status === 0, out };
}
function parseEnvFileSimple(filePath) {
    const out = {};
    if (!fs.existsSync(filePath))
        return out;
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line || line.startsWith("#"))
            continue;
        const i = line.indexOf("=");
        if (i <= 0)
            continue;
        const key = line.slice(0, i).trim();
        let val = line.slice(i + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
}
function resolveMt5DockerDir(resolved) {
    const candidates = [];
    const envDir = process.env.CMDMT_DOCKER_DIR?.trim();
    if (envDir)
        candidates.push(isWindowsPath(envDir) ? toWslPath(envDir) : envDir);
    const commanderRoot = resolveCommanderRoot(resolved);
    if (commanderRoot) {
        candidates.push(path.join(commanderRoot, "dockermt"));
        candidates.push(path.join(path.dirname(commanderRoot), "dockermt"));
    }
    const cmdmtRoot = currentCmdmtRoot();
    candidates.push(path.join(path.dirname(cmdmtRoot), "dockermt"));
    for (const c of candidates) {
        const abs = path.resolve(c);
        const composeYaml = path.join(abs, "docker-compose.yaml");
        const composeYml = path.join(abs, "docker-compose.yml");
        if (fs.existsSync(composeYaml) || fs.existsSync(composeYml))
            return abs;
    }
    return null;
}
function resolveMt5WebUrl(dockerDir, explicit) {
    if (explicit && explicit.trim())
        return explicit.trim();
    const env = parseEnvFileSimple(path.join(dockerDir, ".env"));
    const portRaw = (env.MT5_WEB_PORT || "").trim();
    const port = Number.parseInt(portRaw || "3000", 10);
    const safePort = Number.isFinite(port) && port > 0 ? port : 3000;
    return `http://localhost:${safePort}`;
}
function runDockerCompose(dockerDir, args) {
    const res = spawnSync("docker", ["compose", ...args], { cwd: dockerDir, encoding: "utf8" });
    const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
    return { ok: res.status === 0, out };
}
function runDockerCli(dockerDir, args) {
    const res = spawnSync("docker", args, { cwd: dockerDir, encoding: "utf8" });
    const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
    return { ok: res.status === 0, out };
}
function resolveDockerServiceNameFromCompose(dockerDir) {
    const svc = runDockerCompose(dockerDir, ["config", "--services"]);
    if (!svc.ok)
        return null;
    const lines = svc.out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !/^WARN/i.test(l));
    return lines.length ? lines[0] : null;
}
function collectContainerTesterLogLines(dockerDir, maxLines = 200) {
    const services = Array.from(new Set([resolveDockerServiceNameFromCompose(dockerDir), "mt5"].filter(Boolean)));
    if (!services.length)
        return [];
    const safeMax = Math.max(50, Number(maxLines) || 200);
    const script = [
        "set -eu",
        `max=${safeMax}`,
        'tmp="/tmp/cmdmt-log-dirs.txt"; : > "$tmp"',
        'for d in "/config/.wine/drive_c/Program Files/MetaTrader 5/Tester/logs" "/config/.wine/drive_c/Program Files/MetaTrader 5/Logs" "/config/.wine/drive_c/Program Files/MetaTrader 5/MQL5/Logs" "/config/.wine/drive_c/Program Files/MetaTrader 5/MQL5/Tester/logs"; do [ -d "$d" ] && printf "%s\\n" "$d" >> "$tmp" || true; done',
        "find /config/.wine/drive_c -type d \\( -path '*/MetaTrader 5/Tester/logs' -o -path '*/MetaTrader 5/Tester/Logs' -o -path '*/MetaTrader 5/MQL5/Logs' -o -path '*/MetaTrader 5/Logs' \\) 2>/dev/null >> \"$tmp\" || true",
        'sort -u "$tmp" | while IFS= read -r d; do',
        '  [ -d "$d" ] || continue',
        '  f=$(ls -1t "$d"/*.log 2>/dev/null | head -n1 || true)',
        '  [ -n "$f" ] || continue',
        '  if iconv -f UTF-16LE -t UTF-8 "$f" >/tmp/cmdmt-log-decoded.txt 2>/dev/null; then',
        '    tail -n "$max" /tmp/cmdmt-log-decoded.txt 2>/dev/null || true',
        '  else',
        '    tail -n "$max" "$f" 2>/dev/null || true',
        '  fi',
        'done'
    ].join("\n");
    for (const service of services) {
        const out = runDockerCompose(dockerDir, ["exec", "-T", service, "sh", "-lc", script]);
        if (!out.ok || !out.out)
            continue;
        const lines = out.out
            .split(/\r?\n/)
            .map((l) => l.replace(/\u0000/g, "").trim())
            .filter((l) => l.length > 0 && !/^WARN/i.test(l));
        if (lines.length)
            return lines;
    }
    return [];
}
async function ensureContainerTransportAvailable(dockerDir, transport) {
    const up = runDockerCompose(dockerDir, ["up", "-d"]);
    if (!up.ok)
        return false;
    for (let i = 0; i < 12; i++) {
        await sleep(500);
        if (await pingTransport(transport))
            return true;
    }
    const service = resolveDockerServiceNameFromCompose(dockerDir);
    if (service) {
        runDockerCompose(dockerDir, ["restart", service]);
    }
    else {
        runDockerCompose(dockerDir, ["restart"]);
    }
    for (let i = 0; i < 40; i++) {
        await sleep(500);
        if (await pingTransport(transport))
            return true;
    }
    return false;
}
async function ensureRuntimeReachable(resolved, transport) {
    if (await pingTransport(transport))
        return;
    const runner = requireRunner(resolved);
    await ensureServiceAvailable(runner, transport);
    if (!(await pingTransport(transport))) {
        throw new Error("servico TelnetMT indisponivel no runner local.");
    }
}
function openExternalUrl(url, appMode) {
    const safe = url.replace(/'/g, "''");
    if (isWsl() || process.platform === "win32") {
        if (appMode) {
            const browser = (() => {
                if (isWsl()) {
                    const candidates = [
                        findWindowsExe("chrome.exe"),
                        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
                    ].filter(Boolean);
                    return candidates.find((c) => existsPath(c)) || null;
                }
                return findOnPath("chrome") || findOnPath("google-chrome") || findOnPath("chromium");
            })();
            if (!browser)
                return false;
            const b = browser.replace(/'/g, "''");
            const script = `Start-Process -FilePath '${b}' -ArgumentList '--app=${safe}'`;
            const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
            return r.status === 0;
        }
        const browser = (() => {
            if (isWsl()) {
                const candidates = [
                    findWindowsExe("chrome.exe"),
                    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
                ].filter(Boolean);
                return candidates.find((c) => existsPath(c)) || null;
            }
            return findOnPath("chrome") || findOnPath("google-chrome") || findOnPath("chromium");
        })();
        if (!browser)
            return false;
        const b = browser.replace(/'/g, "''");
        const script = `Start-Process -FilePath '${b}' -ArgumentList '${safe}'`;
        const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
        return r.status === 0;
    }
    if (process.platform === "darwin") {
        const r = spawnSync("open", [url], { encoding: "utf8" });
        return r.status === 0;
    }
    const r = spawnSync("xdg-open", [url], { encoding: "utf8" });
    return r.status === 0;
}
function resolvePyplotPythonCli(envVars) {
    return resolvePyplotPythonBinary(envVars);
}
function runPython(pythonExe, args) {
    if (isWsl() && isWindowsPath(pythonExe)) {
        const res = spawnSync("cmd.exe", ["/c", pythonExe, ...args], { encoding: "utf8" });
        const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
        return { ok: res.status === 0, out };
    }
    const res = spawnSync(pythonExe, args, { encoding: "utf8" });
    const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
    return { ok: res.status === 0, out };
}
function ensurePythonModule(pythonExe, moduleName, installName, dryRun) {
    const check = runPython(pythonExe, ["-c", `import ${moduleName}`]);
    if (check.ok)
        return `OK: ${moduleName}`;
    if (dryRun)
        return `NEEDS: ${moduleName} (pip install ${installName})`;
    let install = runPython(pythonExe, ["-m", "pip", "install", installName]);
    if (!install.ok) {
        const out = (install.out || "").toLowerCase();
        if (out.includes("externally-managed-environment") || out.includes("externally managed")) {
            install = runPython(pythonExe, ["-m", "pip", "install", "--break-system-packages", installName]);
            if (install.ok)
                return `INSTALLED: ${installName} (--break-system-packages)`;
        }
    }
    return install.ok ? `INSTALLED: ${installName}` : `FAIL: ${installName} (${install.out || "erro"})`;
}
function detectCudaVersion() {
    const tryParse = (out) => {
        const match = out.match(/CUDA Version:\s*([0-9]+(?:\.[0-9]+)?)/i);
        if (match)
            return match[1];
        const m2 = out.match(/cuda[_\\s]?version\\s*[:=]\\s*([0-9]+(?:\\.[0-9]+)?)/i);
        if (m2)
            return m2[1];
        return null;
    };
    try {
        if (isWsl()) {
            const res = spawnSync("cmd.exe", ["/c", "nvidia-smi"], { encoding: "utf8" });
            const out = `${res.stdout || ""}${res.stderr || ""}`;
            const ver = tryParse(out);
            if (ver)
                return ver;
        }
        const res = spawnSync("nvidia-smi", [], { encoding: "utf8" });
        const out = `${res.stdout || ""}${res.stderr || ""}`;
        return tryParse(out);
    }
    catch {
        return null;
    }
}
function pickCupyPackage(cudaVersion) {
    if (!cudaVersion)
        return { pkg: "cupy-cuda12x", note: "cuda desconhecido; usando cupy-cuda12x" };
    const major = parseInt(cudaVersion.split(".")[0] || "0", 10);
    if (major === 11)
        return { pkg: "cupy-cuda11x" };
    if (major === 12)
        return { pkg: "cupy-cuda12x" };
    if (major >= 13) {
        return { pkg: "cupy-cuda12x", note: `cuda ${cudaVersion} sem wheel oficial; usando cupy-cuda12x` };
    }
    return { pkg: "cupy-cuda12x", note: `cuda ${cudaVersion} inesperado; usando cupy-cuda12x` };
}
function ensureCupy(pythonExe, dryRun, outputs) {
    const cudaVer = detectCudaVersion();
    if (cudaVer)
        outputs.push(`cuda detectado: ${cudaVer}`);
    const choice = pickCupyPackage(cudaVer);
    if (choice.note)
        outputs.push(`cupy: ${choice.note}`);
    outputs.push(ensurePythonModule(pythonExe, "cupy", choice.pkg, dryRun));
}
function readJsonFile(filePath) {
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
function writeJsonFile(filePath, data) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function resolveAuthEnvPath(configPath, configObj) {
    const envOverride = (process.env.CMDMT_ENV || "").trim();
    if (envOverride) {
        const p = envOverride.startsWith("~") ? path.join(os.homedir(), envOverride.slice(1)) : envOverride;
        return isWindowsPath(p) ? toWslPath(p) : path.resolve(p);
    }
    const fromConfig = typeof configObj.envPath === "string" ? configObj.envPath.trim() : "";
    if (fromConfig) {
        const p = fromConfig.startsWith("~") ? path.join(os.homedir(), fromConfig.slice(1)) : fromConfig;
        return isWindowsPath(p) ? toWslPath(p) : path.resolve(p);
    }
    return path.join(os.homedir(), ".cmdmt", ".env");
}
function upsertDotEnv(filePath, updates) {
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
async function main() {
    const isDockerBrand = ((process.env.CMDMT_BRAND || "").trim().toLowerCase() === "dockermt");
    const cliName = isDockerBrand ? "dockermt" : "cmdmt";
    const defaultPort = HOST_CMDMT_PORT;
    const program = new Command();
    program
        .name(cliName)
        .description("TelnetMT CLI (socket)")
        .version("2.0.0")
        .option("--config <path>", "caminho do config JSON")
        .option("--profile <name>", "perfil do config")
        .option("--test-host <host>", "host do sandbox (override)")
        .option("--test-hosts <hosts>", "hosts do sandbox (override)")
        .option("--test-port <port>", "porta do sandbox", (v) => parseInt(v, 10))
        .option("--test-timeout <ms>", "timeout do sandbox", (v) => parseInt(v, 10))
        .option("--symbol <symbol>", "symbol default")
        .option("--tf <tf>", "timeframe default")
        .option("--sub <n>", "subwindow/indice default", (v) => parseInt(v, 10))
        .option("--base-tpl <tpl>", "template base para expert run")
        .option("--compile-path <path>", "script/exe de compile")
        .option("--host <host>", "host unico (ex: 127.0.0.1)")
        .option("--hosts <hosts>", "lista separada por virgula")
        .option("-p, --port <port>", "porta (interno)", (v) => parseInt(v, 10), defaultPort)
        .option("-t, --timeout <ms>", "timeout em ms", (v) => parseInt(v, 10), 3000)
        .option("--visual", "tester visual (override)")
        .option("--no-visual", "tester sem visual (override)")
        .option("--from <date>", "tester fromDate (YYYY.MM.DD)")
        .option("--to <date>", "tester toDate (YYYY.MM.DD)")
        .option("--shutdown", "fecha o terminal ao final do tester (override)")
        .option("--no-shutdown", "nao fecha o terminal ao final do tester (override)")
        .option("--win <WxH>", "tamanho da janela do terminal (ex: 1400x900)")
        .option("--pos <X,Y>", "posicao da janela do terminal (ex: 100,40)")
        .option("--fullscreen", "terminal fullscreen (override)")
        .option("--no-fullscreen", "terminal sem fullscreen (override)")
        .option("--keep-open", "nao fecha o terminal sandbox e nao encerra ao final do tester")
        .option("--json", "saida em JSON", false)
        .option("--quiet", "nao imprime banner no modo interativo", false)
        .option("--trace", "debug: loga comandos/respostas e verificacoes", false)
        .argument("[cmd...]", "comando e parametros")
        .option("--repo <path>", "override do caminho do repo TelnetMT")
        .option("--dry-run", "nao altera arquivos (apenas mostra plano)", false)
        .option("-y, --yes", "assume sim para confirmacoes de escrita", false)
        .allowUnknownOption(true)
        .configureOutput({
        writeErr: (str) => process.stderr.write(str),
        writeOut: (str) => process.stdout.write(str)
    });
    await program.parseAsync(process.argv);
    const opts = program.opts();
    TRACE = Boolean(opts.trace || process.env.CMDMT_TRACE);
    const resolved = resolveConfig({
        configPath: opts.config,
        profile: opts.profile,
        symbol: opts.symbol,
        tf: opts.tf,
        sub: opts.sub,
        baseTpl: opts.baseTpl,
        compilePath: opts.compilePath,
        repoPath: opts.repo,
        host: opts.host,
        hosts: opts.hosts,
        port: opts.port,
        timeoutMs: opts.timeout,
        testHost: opts.testHost,
        testHosts: opts.testHosts,
        testPort: opts.testPort,
        testTimeoutMs: opts.testTimeout
    });
    const hasTransportOverride = Boolean(opts.host || opts.hosts || opts.testHost || opts.testHosts) ||
        (typeof opts.port === "number" && opts.port !== defaultPort) ||
        (typeof opts.testPort === "number" && opts.testPort !== defaultPort);
    if (hasTransportOverride) {
        process.stderr.write(`${cliName}: override de transporte desabilitado (host/hosts/port/test-*) para evitar cruzamento entre cmdmt e dockermt.\n`);
        process.exitCode = 1;
        return;
    }
    resolved.transport = {
        hosts: ["127.0.0.1"],
        port: defaultPort,
        timeoutMs: resolved.transport.timeoutMs
    };
    if (resolved.testerTransport) {
        resolved.testerTransport = {
            hosts: ["127.0.0.1"],
            port: defaultPort,
            timeoutMs: resolved.testerTransport.timeoutMs
        };
    }
    CONFIRM_FALLBACK = async (lines) => {
        try {
            const transport = requireTransport(resolved);
            const title = cliName;
            const message = lines.join("\n");
            const resp = await executeSend({ type: "CONFIRM", params: [title, message] }, transport);
            if (isErrorResponse(resp)) {
                const errLines = extractErrorLines(resp);
                process.stderr.write(errLines || "confirmacao recusada pelo MT5.\n");
                return false;
            }
            const data = extractDataLines(resp);
            const val = (data[0] || "").trim().toLowerCase();
            if (val === "yes" || val === "sim" || val === "y")
                return true;
            if (val === "no" || val === "n")
                return false;
            const msgLine = resp.split(/\r?\n/)[1]?.trim().toLowerCase();
            if (msgLine === "yes" || msgLine === "sim" || msgLine === "y")
                return true;
            if (msgLine === "no" || msgLine === "n")
                return false;
            return false;
        }
        catch (err) {
            process.stderr.write(`confirmacao falhou via MT5: ${String(err)}\n`);
            return false;
        }
    };
    if (!process.env.CMDMT_DELEGATED) {
        const repoRoot = resolveRepoRoot(resolved.repoPath ?? opts.repo);
        if (repoRoot) {
            const autoBuild = resolved.repoAutoBuild !== false;
            if (maybeDelegateToRepo(repoRoot, autoBuild))
                return;
        }
    }
    const visualOverrideProvided = typeof opts.visual === "boolean";
    const testerOverride = {};
    if (typeof opts.visual === "boolean")
        testerOverride.visual = opts.visual ? 1 : 0;
    if (typeof opts.fullscreen === "boolean")
        testerOverride.windowFullscreen = opts.fullscreen ? 1 : 0;
    if (typeof opts.shutdown === "boolean")
        testerOverride.shutdownTerminal = opts.shutdown ? 1 : 0;
    if (typeof opts.from === "string" && opts.from.trim())
        testerOverride.fromDate = opts.from.trim();
    if (typeof opts.to === "string" && opts.to.trim())
        testerOverride.toDate = opts.to.trim();
    if (opts.win) {
        const m = String(opts.win).match(/^(\d+)\s*[x,]\s*(\d+)$/i);
        if (m) {
            testerOverride.windowWidth = parseInt(m[1], 10);
            testerOverride.windowHeight = parseInt(m[2], 10);
        }
        else {
            process.stderr.write("WARN --win esperado no formato WxH (ex: 1400x900)\n");
        }
    }
    if (opts.pos) {
        const m = String(opts.pos).match(/^(-?\d+)\s*[,x]\s*(-?\d+)$/i);
        if (m) {
            testerOverride.windowLeft = parseInt(m[1], 10);
            testerOverride.windowTop = parseInt(m[2], 10);
        }
        else {
            process.stderr.write("WARN --pos esperado no formato X,Y (ex: 100,40)\n");
        }
    }
    if (Object.keys(testerOverride).length) {
        resolved.tester = { ...resolved.tester, ...testerOverride };
    }
    if (opts.keepOpen) {
        resolved.tester = { ...resolved.tester, allowOpen: true, shutdownTerminal: 0 };
    }
    const autoMacrosPath = resolveAutoMacrosPath(resolved.configPath);
    const ctx = {
        symbol: resolved.context.symbol,
        tf: resolved.context.tf,
        sub: resolved.context.sub,
        baseTpl: resolved.baseTpl,
        profile: resolved.profile,
        autoMacros: loadAutoMacros(autoMacrosPath),
        autoMacrosPath
    };
    const args = program.args;
    const invokeAs = process.env.CMDMT_INVOKE_AS?.trim();
    if (!args || args.length === 0) {
        if (invokeAs) {
            const res = dispatch([invokeAs], ctx);
            if (res.kind === "error") {
                process.stderr.write(res.message + "\n");
                process.exitCode = 1;
                return;
            }
        }
        const transport = requireTransport(resolved);
        const bannerVariant = isDockerBrand ? "container" : "default";
        const bannerLabel = cliName;
        await runRepl({ ...transport, json: opts.json, quiet: opts.quiet, bannerVariant, bannerLabel }, ctx, resolved);
        return;
    }
    const tokensRaw = args.length === 1 ? splitArgs(args[0]) : args;
    const tokens = invokeAs ? [invokeAs, ...tokensRaw] : tokensRaw;
    const low0 = tokens[0]?.toLowerCase();
    if (!opts.quiet) {
        const bannerVariant = isDockerBrand ? "container" : "default";
        const bannerLabel = invokeAs || cliName;
        process.stdout.write(renderBanner({
            label: bannerLabel,
            owner: "Eduardo Candeiro Gonçalves",
            socket: `${resolved.transport.hosts.join(",")}:${resolved.transport.port}`,
            variant: bannerVariant
        }));
    }
    if (low0 === "pyplot" || low0 === "pyplotmt") {
        const uiPath = resolvePyplotUiPath(resolved.repoPath);
        if (!uiPath) {
            process.stderr.write("pyplot: UI nao encontrada. Defina PYPLOT_UI ou use o caminho padrao.\n");
            process.exitCode = 1;
            return;
        }
        const pythonExe = resolvePyplotPython();
        if (!pythonExe) {
            process.stderr.write("pyplot: python nao encontrado. Defina PYPLOT_PYTHON.\n");
            process.exitCode = 1;
            return;
        }
        const commanderRoot = resolveCommanderRoot(resolved);
        const env = buildPyplotEnv(resolved, commanderRoot);
        launchPyplotUiResolved(uiPath, pythonExe, env);
        process.stdout.write("OK\n");
        return;
    }
    if (tokens[0]?.toLowerCase() === "compile") {
        let compileArgs = tokens.slice(1);
        if (!compileArgs.length && ctx.watchName) {
            compileArgs = [ctx.watchName];
        }
        if (!compileArgs.length) {
            process.stderr.write("uso: compile <arquivo.mq5|diretorio> (ou defina watch)\n");
            process.exitCode = 1;
            return;
        }
        const envCompile = process.env.CMDMT_COMPILE?.trim();
        const userSpecified = Boolean(resolved.compilePath || envCompile);
        let compilePath = resolveCompilePath(resolved);
        if (!compilePath) {
            throw new Error("compile nao configurado. Use --compile-path, CMDMT_COMPILE ou defaults.compilePath no config.");
        }
        if (compileArgs.length) {
            const resolvedSrc = resolveMqSourceFromRunner(compileArgs[0], resolved.runner?.dataPath);
            if (resolvedSrc) {
                compileArgs[0] = resolvedSrc;
            }
        }
        // Mantem o compilador configurado (mt5-compile.exe por padrao).
        // MetaEditor so e usado se for explicitamente configurado como compilePath.
        const finalArgs = isMetaEditorPath(compilePath) && compileArgs.length
            ? buildMetaEditorArgs(compileArgs[0], compileArgs)
            : compileArgs;
        const env = buildCompileEnv(resolved);
        if (!env.MT5_HOME && compileArgs.length) {
            const dataPath = inferDataPathFromSource(compileArgs[0]);
            const inferred = deriveMt5HomeFromDataPath(dataPath ?? undefined);
            if (inferred)
                env.MT5_HOME = inferred;
        }
        await runCompile(compilePath, toWindowsArgsIfNeeded(finalArgs, compilePath), env);
        return;
    }
    const res = dispatch(tokens, ctx);
    if (res.kind === "local") {
        if (opts.json) {
            process.stdout.write(JSON.stringify({ kind: "local", output: res.output }) + "\n");
        }
        else {
            process.stdout.write(res.output + "\n");
        }
        return;
    }
    if (res.kind === "error") {
        if (opts.json) {
            process.stdout.write(JSON.stringify({ kind: "error", message: res.message }) + "\n");
        }
        else {
            process.stderr.write(res.message + "\n");
        }
        process.exitCode = 1;
        return;
    }
    if (res.kind === "exit") {
        return;
    }
    if (res.kind === "config_ui") {
        await runConfigUi(resolved, {
            target: res.target ?? "menu",
            yes: Boolean(opts.yes),
            dryRun: Boolean(opts.dryRun)
        });
        return;
    }
    if (res.kind === "auth") {
        const cfgObj = readJsonFile(resolved.configPath);
        const envPath = resolveAuthEnvPath(resolved.configPath, cfgObj);
        if (res.action === "show") {
            const login = String(resolved.tester.login ?? "");
            const server = String(resolved.tester.server ?? "");
            const password = String(resolved.tester.password ?? "");
            const masked = password ? "*".repeat(Math.max(4, Math.min(12, password.length))) : "";
            const lines = [
                "auth source: " + toWindowsPath(envPath),
                "login: " + (login || "(vazio)"),
                "server: " + (server || "(vazio)"),
                "password: " + (masked || "(vazio)")
            ];
            process.stdout.write(lines.join("\n") + "\n");
            return;
        }
        if (res.action === "set") {
            const login = String(res.login ?? "").trim();
            const password = String(res.password ?? "");
            const server = String(res.server ?? "").trim();
            if (!login || !password || !server) {
                process.stderr.write("uso: auth set LOGIN PASSWORD SERVER | auth set --login LOGIN --password PASSWORD --server SERVER\n");
                process.exitCode = 1;
                return;
            }
            upsertDotEnv(envPath, {
                CMDMT_LOGIN: login,
                CMDMT_PASSWORD: password,
                CMDMT_SERVER: server,
                MT5_LOGIN: login,
                MT5_PASSWORD: password,
                MT5_SERVER: server
            });
            const tester = typeof cfgObj.tester === "object" && cfgObj.tester
                ? { ...cfgObj.tester }
                : {};
            tester.login = login;
            tester.password = password;
            tester.server = server;
            cfgObj.tester = tester;
            writeJsonFile(resolved.configPath, cfgObj);
            process.stdout.write("auth atualizado em " + toWindowsPath(envPath) + "\n");
            process.stdout.write("config atualizado em " + toWindowsPath(resolved.configPath) + "\n");
            return;
        }
    }
    if (res.kind === "container") {
        const dockerDir = resolveMt5DockerDir(resolved);
        if (!dockerDir) {
            process.stderr.write("container: projeto docker nao encontrado (esperado em dockermt).\n");
            process.exitCode = 1;
            return;
        }
        if (res.action === "status") {
            const st = runDockerCompose(dockerDir, ["ps"]);
            if (opts.json) {
                process.stdout.write(JSON.stringify({ kind: "container", action: "status", dockerDir: toWindowsPath(dockerDir), ok: st.ok, output: st.out }) + "\n");
            }
            else {
                process.stdout.write(`dockerDir: ${toWindowsPath(dockerDir)}\n`);
                if (st.out)
                    process.stdout.write(st.out + "\n");
            }
            if (!st.ok)
                process.exitCode = 1;
            return;
        }
        if (res.action === "map") {
            const env = parseEnvFileSimple(path.join(dockerDir, ".env"));
            const service = resolveDockerServiceNameFromCompose(dockerDir) || "mt5";
            const ps = runDockerCompose(dockerDir, ["ps", service]);
            const img = runDockerCompose(dockerDir, ["config", "--images"]);
            const image = (img.out || "")
                .split(/\r?\n/)
                .map((l) => l.trim())
                .find((l) => l.length > 0 && !/^WARN/i.test(l)) || "";
            const inspect = runDockerCli(dockerDir, ["inspect", service, "--format", "{{.Id}}|{{.Name}}|{{.State.Status}}"]);
            const inspectLine = inspect.ok ? (inspect.out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "") : "";
            const [containerId, containerNameRaw, containerState] = inspectLine.split("|");
            const containerName = containerNameRaw ? containerNameRaw.replace(/^\//, "") : service;
            const map = {
                kind: "container",
                action: "map",
                dockerDir: toWindowsPath(dockerDir),
                service,
                container: {
                    id: containerId || "",
                    name: containerName,
                    state: containerState || "unknown",
                    image: image || ""
                },
                ports: {
                    webHost: env.MT5_WEB_PORT || "3000",
                    pythonHost: env.MT5_PY_PORT || "8001",
                    telnetHost: env.TELNETMT_PORT || "1122",
                    webContainer: "3000",
                    pythonContainer: "8001",
                    telnetContainer: env.TELNETMT_PORT || "1122"
                },
                paths: {
                    configVolume: "/config",
                    mt5Root: "/config/.wine/drive_c/Program Files/MetaTrader 5",
                    mt5Mql5: "/config/.wine/drive_c/Program Files/MetaTrader 5/MQL5",
                    mt5Config: "/config/.wine/drive_c/Program Files/MetaTrader 5/Config",
                    telnetServiceIni: "/config/.wine/drive_c/Program Files/MetaTrader 5/Config/services.ini",
                    telnetServiceEx5: "/config/.wine/drive_c/Program Files/MetaTrader 5/MQL5/Services/TelnetMT_SocketTelnetService.ex5",
                    internalCli: "/usr/local/bin/cmdmtc",
                    internalMap: "/usr/local/bin/cmdmt-map"
                },
                commands: {
                    host: [
                        "dockermt container up",
                        "dockermt container open --app",
                        "dockermt container status",
                        "dockermt container map"
                    ],
                    insideContainer: [
                        "cmdmt-map",
                        "cmdmtc 1|PING",
                        "cmdmtc RAW|1700000000000|PING"
                    ]
                },
                composePs: ps.out || ""
            };
            if (opts.json) {
                process.stdout.write(JSON.stringify(map) + "\n");
            }
            else {
                console.log(`dockerDir: ${map.dockerDir}`);
                console.log(`service: ${map.service}`);
                console.log(`container: ${map.container.name} (${map.container.state})`);
                if (map.container.image)
                    console.log(`image: ${map.container.image}`);
                console.log("ports:");
                console.log(` - web: localhost:${map.ports.webHost} -> ${map.ports.webContainer}`);
                console.log(` - python: localhost:${map.ports.pythonHost} -> ${map.ports.pythonContainer}`);
                console.log(` - telnet: localhost:${map.ports.telnetHost} -> ${map.ports.telnetContainer}`);
                console.log("paths:");
                console.log(` - /config: ${map.paths.configVolume}`);
                console.log(` - MT5 root: ${map.paths.mt5Root}`);
                console.log(` - MT5 MQL5: ${map.paths.mt5Mql5}`);
                console.log(` - service ini: ${map.paths.telnetServiceIni}`);
                console.log(` - internal cli: ${map.paths.internalCli}`);
                console.log("commands (host):");
                for (const c of map.commands.host)
                    console.log(` - ${c}`);
                console.log("commands (container):");
                for (const c of map.commands.insideContainer)
                    console.log(` - ${c}`);
            }
            return;
        }
        if (res.action === "list") {
            const root = containerStatesStorePath(dockerDir);
            const states = listContainerStates(dockerDir);
            if (opts.json) {
                process.stdout.write(JSON.stringify({
                    kind: "container",
                    action: "list",
                    dockerDir: toWindowsPath(dockerDir),
                    storePath: toWindowsPath(root),
                    count: states.length,
                    states: states.map((s) => ({
                        name: s.meta.name,
                        createdAt: s.meta.createdAt,
                        stateImage: s.meta.stateImage,
                        volumeName: s.meta.volumeName,
                        archivePath: toWindowsPath(s.archivePath),
                        archiveSizeBytes: s.archiveSizeBytes
                    }))
                }) + "\n");
            }
            else {
                process.stdout.write(`dockerDir: ${toWindowsPath(dockerDir)}\n`);
                process.stdout.write(`states: ${toWindowsPath(root)}\n`);
                process.stdout.write(`count: ${states.length}\n`);
                for (const st of states) {
                    process.stdout.write(` - ${st.meta.name} | ${st.meta.createdAt} | image=${st.meta.stateImage} | volume=${st.meta.volumeName} | archive=${toWindowsPath(st.archivePath)} (${st.archiveSizeBytes} bytes)\n`);
                }
            }
            return;
        }
        if (res.action === "save") {
            const stateName = (res.stateName || "").trim();
            if (!stateName) {
                process.stderr.write("container save: nome do estado ausente.\n");
                process.exitCode = 1;
                return;
            }
            let saved;
            try {
                saved = saveContainerState(dockerDir, stateName);
            }
            catch (err) {
                process.stderr.write("container save falhou: " + String(err) + "\n");
                process.exitCode = 1;
                return;
            }
            if (opts.json) {
                process.stdout.write(JSON.stringify({
                    kind: "container",
                    action: "save",
                    dockerDir: toWindowsPath(dockerDir),
                    stateName: saved.meta.name,
                    stateDir: toWindowsPath(saved.stateDir),
                    stateImage: saved.meta.stateImage,
                    volumeName: saved.meta.volumeName,
                    archivePath: toWindowsPath(saved.archivePath),
                    archiveSizeBytes: saved.archiveSizeBytes,
                    createdAt: saved.meta.createdAt
                }) + "\n");
            }
            else {
                process.stdout.write(`container state salvo: ${saved.meta.name}\n`);
                process.stdout.write(`dockerDir: ${toWindowsPath(dockerDir)}\n`);
                process.stdout.write(`state.dir: ${toWindowsPath(saved.stateDir)}\n`);
                process.stdout.write(`state.image: ${saved.meta.stateImage}\n`);
                process.stdout.write(`state.volume: ${saved.meta.volumeName}\n`);
                process.stdout.write(`state.archive: ${toWindowsPath(saved.archivePath)} (${saved.archiveSizeBytes} bytes)\n`);
            }
            return;
        }
        if (res.action === "restore") {
            const stateName = (res.stateName || "").trim();
            if (!stateName) {
                process.stderr.write("container restore: nome do estado ausente.\n");
                process.exitCode = 1;
                return;
            }
            if (!opts.yes) {
                const ok = await confirmPlan([
                    "Restore de container state vai sobrescrever volume /config atual e a imagem ativa do compose.",
                    "estado: " + stateName,
                    "Use -y para suprimir esta confirmacao."
                ]);
                if (!ok) {
                    process.stderr.write("container restore: cancelado.\n");
                    process.exitCode = 1;
                    return;
                }
            }
            let restored;
            try {
                restored = restoreContainerState(dockerDir, stateName);
            }
            catch (err) {
                process.stderr.write("container restore falhou: " + String(err) + "\n");
                process.exitCode = 1;
                return;
            }
            if (opts.json) {
                process.stdout.write(JSON.stringify({
                    kind: "container",
                    action: "restore",
                    dockerDir: toWindowsPath(dockerDir),
                    stateName: restored.meta.name,
                    stateImage: restored.meta.stateImage,
                    volumeName: restored.meta.volumeName,
                    archivePath: toWindowsPath(restored.archivePath),
                    archiveSizeBytes: restored.archiveSizeBytes
                }) + "\n");
            }
            else {
                process.stdout.write(`container state restaurado: ${restored.meta.name}\n`);
                process.stdout.write(`dockerDir: ${toWindowsPath(dockerDir)}\n`);
                process.stdout.write(`state.image: ${restored.meta.stateImage}\n`);
                process.stdout.write(`state.volume: ${restored.meta.volumeName}\n`);
            }
            return;
        }
        const upArgs = ["up", "-d"];
        if (res.build)
            upArgs.push("--build");
        const up = runDockerCompose(dockerDir, upArgs);
        if (!up.ok) {
            process.stderr.write((up.out || "container up falhou") + "\n");
            process.exitCode = 1;
            return;
        }
        const url = resolveMt5WebUrl(dockerDir, res.url);
        const shouldOpen = res.action === "open" && !res.noOpen;
        const opened = shouldOpen ? openExternalUrl(url, Boolean(res.app)) : false;
        if (opts.json) {
            process.stdout.write(JSON.stringify({
                kind: "container",
                action: res.action,
                dockerDir: toWindowsPath(dockerDir),
                up: up.ok,
                opened,
                url,
                appMode: Boolean(res.app)
            }) + "\n");
        }
        else {
            process.stdout.write(`dockerDir: ${toWindowsPath(dockerDir)}\n`);
            process.stdout.write("container: ativo\n");
            process.stdout.write(`url: ${url}\n`);
            if (shouldOpen) {
                process.stdout.write(opened ? "ui: aberta\n" : "ui: nao foi possivel abrir automaticamente\n");
            }
        }
        return;
    }
    if (res.kind === "addons") {
        const runner = requireRunner(resolved);
        const dataPath = runner.dataPath ?? "";
        if (res.action === "init") {
            const dirs = ensureAddonPacksDirs(dataPath);
            if (opts.json) {
                process.stdout.write(JSON.stringify({
                    kind: "addons",
                    action: "init",
                    workspaceRoot: toWindowsPath(dirs.workspaceRoot),
                    packsRoot: toWindowsPath(dirs.packsRoot),
                    packsExperts: toWindowsPath(dirs.packsExperts),
                    packsIndicators: toWindowsPath(dirs.packsIndicators),
                    packsLibraries: toWindowsPath(dirs.packsLibraries)
                }) + "\n");
            }
            else {
                process.stdout.write("addons: packs inicializado\n");
                process.stdout.write("workspace: " + toWindowsPath(dirs.workspaceRoot) + "\n");
                process.stdout.write("packs: " + toWindowsPath(dirs.packsRoot) + "\n");
                process.stdout.write("packs.libraries: " + toWindowsPath(dirs.packsLibraries) + "\n");
            }
            return;
        }
        const source = res.source ?? "";
        const mode = res.mode === "sync" ? "sync" : "merge";
        const packLayout = detectFilesPackLayout(source);
        const isPackFlow = res.action === "add" || Boolean(packLayout);
        if (isPackFlow) {
            if (!packLayout) {
                process.stderr.write("addons: layout de pacote nao detectado (esperado EXP-* e IND-*).\n");
                process.exitCode = 1;
                return;
            }
            if (!opts.yes) {
                const expNames = packLayout.expDirs.map((d) => path.basename(d));
                const indNames = packLayout.indDirs.map((d) => path.basename(d));
                const ok = await confirmPlan([
                    "Detectado pacote em Files/ com layout EXP-/IND-",
                    "origem: " + toWindowsPath(packLayout.sourceResolved),
                    "Experts: " + (expNames.length ? expNames.join(", ") : "(none)"),
                    "Indicators: " + (indNames.length ? indNames.join(", ") : "(none)"),
                    "Prosseguir com ingestao desse pacote?"
                ]);
                if (!ok) {
                    process.stderr.write("addons: ingestao cancelada.\n");
                    process.exitCode = 1;
                    return;
                }
            }
            const importedPack = importFilesPackLayout({ source, dataPath, mode });
            const totals = importedPack.imported.reduce((acc, item) => {
                acc.pack += item.filesCopiedToPack;
                acc.mql5 += item.filesCopiedToMql5;
                acc.delPack += item.filesDeletedFromPack || 0;
                acc.delMql5 += item.filesDeletedFromMql5 || 0;
                return acc;
            }, { pack: 0, mql5: 0, delPack: 0, delMql5: 0 });
            if (opts.json) {
                process.stdout.write(JSON.stringify({
                    kind: "addons",
                    action: "add",
                    mode,
                    sourceResolved: toWindowsPath(importedPack.sourceResolved),
                    imported: importedPack.imported.map((x) => ({
                        kind: x.kind,
                        mode: x.mode,
                        sourceResolved: toWindowsPath(x.sourceResolved),
                        packPath: toWindowsPath(x.packPath),
                        mql5Path: toWindowsPath(x.mql5Path),
                        filesCopiedToPack: x.filesCopiedToPack,
                        filesCopiedToMql5: x.filesCopiedToMql5,
                        filesDeletedFromPack: x.filesDeletedFromPack || 0,
                        filesDeletedFromMql5: x.filesDeletedFromMql5 || 0
                    })),
                    totalFilesCopiedToPack: totals.pack,
                    totalFilesCopiedToMql5: totals.mql5,
                    totalFilesDeletedFromPack: totals.delPack,
                    totalFilesDeletedFromMql5: totals.delMql5
                }) + "\n");
            }
            else {
                process.stdout.write("addons: pacote importado\n");
                process.stdout.write("mode: " + mode + "\n");
                process.stdout.write("source: " + toWindowsPath(importedPack.sourceResolved) + "\n");
                for (const item of importedPack.imported) {
                    process.stdout.write(" - " + item.kind + ": " + toWindowsPath(item.packPath) + " -> " + toWindowsPath(item.mql5Path) +
                        " (copied " + item.filesCopiedToPack + "/" + item.filesCopiedToMql5 +
                        ", deleted " + (item.filesDeletedFromPack || 0) + "/" + (item.filesDeletedFromMql5 || 0) + ")\n");
                }
                process.stdout.write("copied.total(pack/mql5): " + totals.pack + "/" + totals.mql5 + "\n");
                process.stdout.write("deleted.total(pack/mql5): " + totals.delPack + "/" + totals.delMql5 + "\n");
            }
            return;
        }
        const result = importAddonFromPath({
            kind: res.action,
            source,
            dataPath,
            mode
        });
        if (opts.json) {
            process.stdout.write(JSON.stringify({
                kind: "addons",
                action: result.kind,
                mode: result.mode,
                source: result.source,
                sourceResolved: toWindowsPath(result.sourceResolved),
                packPath: toWindowsPath(result.packPath),
                mql5Path: toWindowsPath(result.mql5Path),
                filesCopiedToPack: result.filesCopiedToPack,
                filesCopiedToMql5: result.filesCopiedToMql5,
                filesDeletedFromPack: result.filesDeletedFromPack || 0,
                filesDeletedFromMql5: result.filesDeletedFromMql5 || 0
            }) + "\n");
        }
        else {
            process.stdout.write("addons: " + result.kind + " importado\n");
            process.stdout.write("mode: " + result.mode + "\n");
            process.stdout.write("source: " + toWindowsPath(result.sourceResolved) + "\n");
            process.stdout.write("pack: " + toWindowsPath(result.packPath) + "\n");
            process.stdout.write("mql5: " + toWindowsPath(result.mql5Path) + "\n");
            process.stdout.write("copied(pack/mql5): " + result.filesCopiedToPack + "/" + result.filesCopiedToMql5 + "\n");
            process.stdout.write("deleted(pack/mql5): " + (result.filesDeletedFromPack || 0) + "/" + (result.filesDeletedFromMql5 || 0) + "\n");
        }
        return;
    }
    if (res.kind === "test") {
        try {
            const dockerDir = resolveMt5DockerDir(resolved);
            let out = null;
            if (dockerDir) {
                let transport = null;
                try {
                    transport = requireTransport(resolved);
                }
                catch {
                    transport = null;
                }
                out = await runTesterInContainer(res.spec, resolved.tester, {
                    dockerDir,
                    transport
                });
            }
            else {
                const runner = requireRunner(resolved);
                out = await runTester(res.spec, runner, resolved.tester, {
                    assumeYes: opts.yes === true,
                    interactive: process.stdin.isTTY && process.stdout.isTTY,
                    confirm: opts.yes === true ? async () => true : undefined
                });
            }
            if (opts.json) {
                process.stdout.write(JSON.stringify({
                    kind: "test",
                    ok: true,
                    runDir: out?.runDir ?? "",
                    reportPath: out?.reportPath ?? "",
                    summary: out?.summary ?? {}
                }) + "\n");
            }
            else {
                process.stdout.write("tester: iniciado\n");
                if (out?.runDir)
                    process.stdout.write("runDir: " + out.runDir + "\n");
                if (out?.reportPath)
                    process.stdout.write("report: " + out.reportPath + "\n");
                if (out?.summary) {
                    const s = out.summary;
                    if (s?.headline)
                        process.stdout.write("summary: " + s.headline + "\n");
                }
            }
        }
        catch (err) {
            process.stderr.write("tester falhou: " + String(err) + "\n");
            process.exitCode = 1;
        }
        return;
    }
    if (res.kind === "data_import") {
        const runner = requireRunner(resolved);
        const transport = requireTransport(resolved);
        await ensureRuntimeReachable(resolved, transport);
        try {
            await performDataImport(res, runner, transport);
        }
        catch (err) {
            process.stderr.write(String(err) + "\n");
            process.exitCode = 1;
            return;
        }
        return;
    }
    if (res.kind === "diag") {
        const runner = requireRunner(resolved);
        const dataPath = runner.dataPath ?? "";
        const base = path.join(toWslPath(dataPath), "MQL5");
        let lines = [];
        if (res.target === "indicator") {
            const info = resolveIndicatorFiles(res.name, dataPath);
            lines.push(`indicator: ${res.name}`);
            if (info.rel)
                lines.push(`resolved: ${info.rel}`);
            if (info.mq5)
                lines.push(`mq5: ${info.mq5} ${fs.existsSync(info.mq5) ? "(ok)" : "(missing)"}`);
            if (info.ex5)
                lines.push(`ex5: ${info.ex5} ${fs.existsSync(info.ex5) ? "(ok)" : "(missing)"}`);
            if (!info.rel && !info.mq5 && !info.ex5)
                lines.push(`not found under ${path.join(base, "Indicators")}`);
            lines.push("note: iCustom usa caminho relativo em MQL5/Indicators (sem extensao).");
        }
        else {
            const info = resolveExpertFiles(res.name, dataPath);
            lines.push(`expert: ${res.name}`);
            if (info.rel)
                lines.push(`resolved: ${info.rel}`);
            if (info.mq5)
                lines.push(`mq5: ${info.mq5} ${fs.existsSync(info.mq5) ? "(ok)" : "(missing)"}`);
            if (info.ex5)
                lines.push(`ex5: ${info.ex5} ${fs.existsSync(info.ex5) ? "(ok)" : "(missing)"}`);
            if (!info.rel && !info.mq5 && !info.ex5)
                lines.push(`not found under ${path.join(base, "Experts")}`);
        }
        const output = lines.join("\n");
        if (opts.json) {
            process.stdout.write(JSON.stringify({ kind: "diag", output }) + "\n");
        }
        else {
            process.stdout.write(output + "\n");
        }
        if (lines.some((l) => l.includes("(missing)") || l.includes("not found"))) {
            process.exitCode = 1;
        }
        return;
    }
    if (res.kind === "log") {
        const runner = requireRunner(resolved);
        const logFile = findLatestLogFile(runner.dataPath);
        if (!logFile || !fs.existsSync(logFile)) {
            process.stderr.write("log nao encontrado\n");
            process.exitCode = 1;
            return;
        }
        const text = fs.readFileSync(logFile, "utf8");
        const output = tailLines(text, res.tail || 200);
        if (opts.json) {
            process.stdout.write(JSON.stringify({ kind: "log", file: logFile, output }) + "\n");
        }
        else {
            process.stdout.write(output + "\n");
        }
        return;
    }
    if (res.kind === "auto_run") {
        const runner = requireRunner(resolved);
        const termPath = runner.terminalPath;
        if (!termPath) {
            process.stderr.write("auto: runner sem terminalPath configurado\n");
            process.exitCode = 1;
            return;
        }
        if (res.unknown?.length) {
            process.stderr.write(`auto: ignorando codigos desconhecidos: ${res.unknown.join(", ")}\n`);
        }
        const winPath = isWindowsPath(termPath) ? termPath : toWindowsPath(termPath);
        const tokens = toSendKeysTokens(res.keys);
        if (!tokens.length) {
            process.stderr.write("auto: nenhuma tecla valida para enviar\n");
            process.exitCode = 1;
            return;
        }
        const script = buildPowerShellSendKeysScript(winPath, tokens, 80);
        const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
            encoding: "utf8"
        });
        const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
        if (stderr)
            process.stderr.write(stderr + "\n");
        if (result.status !== 0) {
            process.exitCode = result.status ?? 1;
            return;
        }
        process.stdout.write("ok\n");
        return;
    }
    if (res.kind === "hotkey") {
        const runner = requireRunner(resolved);
        const dataWsl = toWslPath(runner.dataPath ?? "");
        const lower = path.join(dataWsl, "config");
        const upper = path.join(dataWsl, "Config");
        const configDir = fs.existsSync(lower) ? lower : (fs.existsSync(upper) ? upper : lower);
        const filePath = path.join(configDir, "hotkeys.ini");
        const exists = fs.existsSync(filePath);
        const action = res.action;
        if (!exists && action === "list") {
            process.stdout.write("(empty)\n");
            return;
        }
        if (!exists && action !== "set") {
            process.stderr.write("hotkeys.ini nao encontrado\n");
            process.exitCode = 1;
            return;
        }
        let current = exists ? readTextWithEncoding(filePath) : { text: "", encoding: "utf16le", bom: true };
        if (action === "list") {
            const text = current.text.trim();
            process.stdout.write(text ? text + "\n" : "(empty)\n");
            return;
        }
        const updated = updateHotkeyText(current.text, action === "del" ? "del" : action, res.key, res.value);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        writeTextWithEncoding(filePath, updated, current.encoding, current.bom);
        process.stdout.write("ok\n");
        return;
    }
    if (res.kind === "ind_detach_index") {
        const transport = requireTransport(resolved);
        await ensureRuntimeReachable(resolved, transport);
        const detachResp = await executeSend({ type: "DETACH_IND_INDEX", params: [res.sym, res.tf, res.sub, String(res.index)] }, transport);
        const lower = detachResp.toLowerCase();
        const unsupported = lower.includes("unknown") || lower.includes("code=4113");
        if (unsupported) {
            const nameResp = await executeSend({ type: "IND_NAME", params: [res.sym, res.tf, res.sub, String(res.index)] }, transport);
            if (isErrorResponse(nameResp)) {
                if (opts.json) {
                    process.stdout.write(JSON.stringify({ kind: "send", type: "IND_NAME", params: [res.sym, res.tf, res.sub, String(res.index)], response: nameResp }) + "\n");
                }
                else {
                    process.stdout.write(nameResp);
                    maybeExplainError(nameResp);
                }
                process.exitCode = 1;
                return;
            }
            const lines = extractDataLines(nameResp);
            const name = lines[0] ?? "";
            if (!name) {
                process.stderr.write("ERR indicador nao encontrado nesse indice\n");
                process.exitCode = 1;
                return;
            }
            const fallbackResp = await executeSend({ type: "DETACH_IND_FULL", params: [res.sym, res.tf, name, res.sub] }, transport);
            if (opts.json) {
                process.stdout.write(JSON.stringify({ kind: "send", type: "DETACH_IND_FULL", params: [res.sym, res.tf, name, res.sub], response: fallbackResp }) + "\n");
            }
            else {
                process.stdout.write(fallbackResp);
                if (isErrorResponse(fallbackResp))
                    maybeExplainError(fallbackResp);
            }
            if (isErrorResponse(fallbackResp))
                process.exitCode = 1;
            return;
        }
        if (opts.json) {
            process.stdout.write(JSON.stringify({ kind: "send", type: "DETACH_IND_INDEX", params: [res.sym, res.tf, res.sub, String(res.index)], response: detachResp }) + "\n");
        }
        else {
            process.stdout.write(detachResp);
            if (isErrorResponse(detachResp))
                maybeExplainError(detachResp);
        }
        if (isErrorResponse(detachResp))
            process.exitCode = 1;
        return;
    }
    const transport = requireTransport(resolved);
    await ensureRuntimeReachable(resolved, transport);
    if (res.kind === "send") {
        let logStart = null;
        if (res.type === "DETACH_IND_FULL") {
            try {
                const runner = requireRunner(resolved);
                const p = res.params[2] ?? "";
                const resolvedPath = resolveIndicatorFromRunner(p, runner.dataPath);
                if (resolvedPath) {
                    res.params[2] = path.win32.basename(resolvedPath);
                }
            }
            catch {
                // ignore resolve failure
            }
        }
        if (res.attach) {
            try {
                const runner = requireRunner(resolved);
                if (res.type === "ATTACH_IND_FULL") {
                    const p = res.params[2] ?? "";
                    const resolvedPath = resolveIndicatorFromRunner(p, runner.dataPath);
                    if (resolvedPath) {
                        res.params[2] = resolvedPath;
                    }
                }
                const logFile = findLatestLogFile(runner.dataPath);
                if (logFile && fs.existsSync(logFile)) {
                    const stat = fs.statSync(logFile);
                    logStart = { file: logFile, offset: stat.size };
                    trace(`logStart ${logFile} offset=${stat.size}`);
                }
            }
            catch {
                // ignore logStart
            }
        }
        if (res.attach) {
            const runner = requireRunner(resolved);
            const ops = [];
            if (res.type === "ATTACH_IND_FULL") {
                const p = res.params[2] ?? "";
                const resolvedPath = resolveIndicatorFromRunner(p, runner.dataPath);
                if (resolvedPath) {
                    res.params[2] = resolvedPath;
                }
            }
            if (res.type === "ATTACH_EA_FULL") {
                const p = res.params[2] ?? "";
                const resolvedPath = resolveExpertFromRunner(p, runner.dataPath);
                if (resolvedPath?.name) {
                    res.params[2] = resolvedPath.name;
                }
            }
            // ATTACH_SCRIPT_FULL: sem resolveScriptFromRunner no CLI (mantido sem confirmacao extra).
            if (ops.length) {
                const ok = await confirmUserFileOps(ops, Boolean(opts.yes));
                if (!ok) {
                    process.exitCode = 1;
                    return;
                }
            }
        }
        let action = { type: res.type, params: res.params };
        let response = "";
        if (res.type === "SAVE_TPL_EA") {
            const local = runLocalSaveTplEA(res.params, resolved);
            response = local.response;
            if (local.ok) {
                action.params[1] = local.outTpl;
            }
        }
        else {
            response = await executeSend(action, transport);
            if (res.type === "DETACH_EA_FULL" && isErrorResponse(response)) {
                try {
                    const runner = requireRunner(resolved);
                    const sym = res.params[0] ?? "";
                    const tf = res.params[1] ?? "";
                    const fallbackTpl = resolveBaseTplName("", runner.dataPath ?? "");
                    if (sym && tf && fallbackTpl) {
                        const applyResp = await executeSend({ type: "APPLY_TPL", params: [sym, tf, fallbackTpl] }, transport);
                        if (!isErrorResponse(applyResp)) {
                            response = `OK\nea detached (fallback template: ${fallbackTpl})\n`;
                        }
                    }
                }
                catch {
                    // keep original detach error
                }
            }
        }
        let report = null;
        const attachMeta = res.meta ?? DEFAULT_ATTACH_META;
        if (!isErrorResponse(response) && res.attach && attachMeta.report) {
            try {
                const runner = requireRunner(resolved);
                report = await buildAttachReport({
                    kind: res.attach.kind,
                    name: res.attach.name,
                    symbol: res.attach.symbol,
                    tf: res.attach.tf,
                    sub: res.attach.sub,
                    meta: attachMeta,
                    runner,
                    send: (action) => executeSend(action, transport),
                    logStart: logStart ?? undefined
                });
            }
            catch (err) {
                process.stderr.write(`WARN attach_report: ${String(err)}\n`);
            }
        }
        if (opts.json) {
            process.stdout.write(JSON.stringify({ kind: "send", type: res.type, params: res.params, response, report }) + "\n");
        }
        else {
            process.stdout.write(response);
            if (report)
                process.stdout.write(formatAttachReport(report) + "\n");
        }
        if (isErrorResponse(response)) {
            maybeExplainError(response);
            process.exitCode = 1;
        }
        return;
    }
    if (res.kind === "multi") {
        let logStart = null;
        if (res.attach) {
            try {
                const runner = requireRunner(resolved);
                if (res.attach.kind === "indicator") {
                    const step = res.steps.find((s) => s.type === "ATTACH_IND_FULL");
                    if (step) {
                        const p = step.params[2] ?? "";
                        const resolvedPath = resolveIndicatorFromRunner(p, runner.dataPath);
                        if (resolvedPath) {
                            step.params[2] = resolvedPath;
                        }
                    }
                }
                const logFile = findLatestLogFile(runner.dataPath);
                if (logFile && fs.existsSync(logFile)) {
                    const stat = fs.statSync(logFile);
                    logStart = { file: logFile, offset: stat.size };
                    trace(`logStart ${logFile} offset=${stat.size}`);
                }
            }
            catch {
                // ignore logStart
            }
        }
        const applyStep = res.steps.find((s) => s.type === "APPLY_TPL");
        if (applyStep && applyStep.params.length >= 2) {
            try {
                await ensureChartOpen(applyStep.params[0], applyStep.params[1], transport);
            }
            catch (err) {
                process.stderr.write(`WARN chart_open: ${String(err)}\n`);
            }
        }
        const saveStep = res.steps.find((s) => s.type === "SAVE_TPL_EA");
        const attachMeta = res.meta ?? DEFAULT_ATTACH_META;
        if (saveStep) {
            const expertPath = saveStep.params[0] ?? "";
            if (expertPath && (expertPath.toLowerCase().endsWith(".mq5") || expertPath.toLowerCase().endsWith(".ex5") || expertPath.includes(":\\") || expertPath.includes("/"))) {
                const kind = detectMqlKind(expertPath);
                if (kind === "indicator") {
                    process.stderr.write("ERR arquivo informado é indicador, nao Expert Advisor\n");
                    process.exitCode = 1;
                    return;
                }
                if (kind === "script") {
                    process.stderr.write("ERR arquivo informado é script, nao Expert Advisor\n");
                    process.exitCode = 1;
                    return;
                }
            }
        }
        const steps = [...res.steps];
        const responses = [];
        let lastApplyOk = false;
        let lastExpertName = saveStep?.params[0] ?? "";
        let hadFatalError = false;
        for (const step of steps) {
            let response = "";
            if (step.type === "SAVE_TPL_EA") {
                const local = runLocalSaveTplEA(step.params, resolved);
                response = local.response;
                if (local.ok) {
                    step.params[1] = local.outTpl;
                }
            }
            else {
                response = await executeSend(step, transport);
            }
            responses.push({ type: step.type, params: step.params, response });
            if (isErrorResponse(response)) {
                maybeExplainError(response);
                process.exitCode = 1;
                hadFatalError = true;
                break;
            }
            if (step.type === "APPLY_TPL")
                lastApplyOk = true;
            if (step.type === "SAVE_TPL_EA")
                lastExpertName = step.params[0];
        }
        if (lastApplyOk && lastExpertName) {
            try {
                const runner = requireRunner(resolved);
                const apply = res.steps.find((s) => s.type === "APPLY_TPL");
                if (apply) {
                    const ok = await verifyExpertAttached(apply.params[0], apply.params[1], lastExpertName, transport, runner.dataPath ?? "");
                    if (!ok) {
                        process.stderr.write("WARN ea_attach_unverified (template aplicado, mas verificacao por snapshot falhou)\n");
                    }
                }
            }
            catch (err) {
                process.stderr.write(`WARN verify_ea: ${String(err)}\n`);
            }
        }
        let report = null;
        if (!hadFatalError && res.attach && attachMeta.report) {
            try {
                const runner = requireRunner(resolved);
                report = await buildAttachReport({
                    kind: res.attach.kind,
                    name: res.attach.name,
                    symbol: res.attach.symbol,
                    tf: res.attach.tf,
                    sub: res.attach.sub,
                    meta: attachMeta,
                    runner,
                    send: (action) => executeSend(action, transport),
                    logStart: logStart ?? undefined
                });
            }
            catch (err) {
                process.stderr.write(`WARN attach_report: ${String(err)}\n`);
            }
        }
        if (opts.json) {
            process.stdout.write(JSON.stringify({ kind: "multi", responses, report }) + "\n");
        }
        else if (hadFatalError) {
            for (const r of responses) {
                const errs = extractErrorLines(r.response);
                if (errs)
                    process.stderr.write(errs);
            }
        }
        else {
            for (const r of responses) {
                process.stdout.write(r.response);
            }
            if (report)
                process.stdout.write(formatAttachReport(report) + "\n");
        }
        return;
    }
}
main().catch(handleError);
