import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { INTERNAL_TELNET_HOSTS, INTERNAL_TELNET_PORT } from "../types/internalDefaults.js";
const DEFAULT_PORT = INTERNAL_TELNET_PORT;
const DEFAULT_TIMEOUT = 3000;
const DEFAULT_HOSTS = [...INTERNAL_TELNET_HOSTS];
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".cmdmt", "config.json");
const LOCAL_CONFIG_FILENAME = "cmdmt.config.json";
const INTERNAL_RUNNER_ID = "internal";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_CONFIG_PATHS = [
    path.join(process.cwd(), LOCAL_CONFIG_FILENAME),
    path.resolve(__dirname, "..", "..", LOCAL_CONFIG_FILENAME)
];
const DEFAULT_TESTER = {
    artifactsDir: "cmdmt-artifacts",
    reportDir: "reports",
    allowOpen: false,
    allowDllImport: 1,
    allowLiveTrading: 1,
    expertsEnabled: 1,
    expertsDisableOnAccountChange: 0,
    expertsDisableOnProfileChange: 0,
    maxTestDays: 2,
    startConfirmSec: 120,
    model: 0,
    executionMode: 0,
    optimization: 0,
    useLocal: 1,
    useRemote: 0,
    useCloud: 0,
    syncCommon: true,
    visual: 0,
    replaceReport: 1,
    shutdownTerminal: 1
};
function parseDotEnv(text) {
    const out = {};
    const lines = text.split(/\r?\n/);
    for (let raw of lines) {
        let line = raw.trim();
        if (!line || line.startsWith("#"))
            continue;
        if (line.startsWith("export "))
            line = line.slice(7).trim();
        const idx = line.indexOf("=");
        if (idx <= 0)
            continue;
        const key = line.slice(0, idx).trim();
        let val = line.slice(idx + 1).trim();
        if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
            val = val.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
        }
        if (key)
            out[key] = val;
    }
    return out;
}
function applyEnv(base, extra, opts = {}) {
    const out = { ...base };
    for (const [k, v] of Object.entries(extra)) {
        if (opts.locked?.has(k))
            continue;
        if (!opts.override && out[k] !== undefined)
            continue;
        out[k] = v;
    }
    return out;
}
function loadDotEnvFile(filePath) {
    try {
        if (!fs.existsSync(filePath))
            return {};
        const text = fs.readFileSync(filePath, "utf8");
        return parseDotEnv(text);
    }
    catch {
        return {};
    }
}
function collectEnv(cliPath, env = process.env, opts = {}) {
    const locked = new Set(Object.keys(env));
    let merged = { ...env };
    const toFsPath = (p) => (isWsl() && isWindowsPath(p) ? toWslPath(p) : p);
    const baseCandidates = [];
    const fromEnv = env.CMDMT_ENV?.trim();
    if (fromEnv) {
        baseCandidates.push(toFsPath(expandHome(fromEnv)));
    }
    else {
        baseCandidates.push(path.join(process.cwd(), ".env"));
        baseCandidates.push(path.join(os.homedir(), ".cmdmt", ".env"));
    }
    if (cliPath) {
        baseCandidates.push(toFsPath(path.join(path.dirname(cliPath), ".env")));
    }
    for (const p of baseCandidates) {
        merged = applyEnv(merged, loadDotEnvFile(p), { override: false, locked });
    }
    const overrideCandidates = [];
    const suffixes = [opts.profile].filter(Boolean);
    for (const suffix of suffixes) {
        for (const base of baseCandidates) {
            overrideCandidates.push(`${base}.${suffix}`);
        }
    }
    for (const p of overrideCandidates) {
        merged = applyEnv(merged, loadDotEnvFile(p), { override: true, locked });
    }
    return merged;
}
function expandHome(p) {
    if (p.startsWith("~"))
        return path.join(os.homedir(), p.slice(1));
    return p;
}
export function isWindowsPath(p) {
    return /^[A-Za-z]:\\/.test(p) || /^\\\\/.test(p);
}
export function isWsl() {
    return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}
export function toWslPath(p) {
    if (!p)
        return p;
    if (!isWsl())
        return p;
    if (!isWindowsPath(p))
        return p;
    const match = /^([A-Za-z]):\\(.*)$/.exec(p);
    if (match) {
        const drive = match[1].toLowerCase();
        const rest = match[2].replace(/\\/g, "/");
        return `/mnt/${drive}/${rest}`;
    }
    try {
        return execFileSync("wslpath", ["-u", p], { encoding: "utf8" }).trim();
    }
    catch {
        return p;
    }
}
export function toWindowsPath(p) {
    if (!p)
        return p;
    if (isWindowsPath(p))
        return p;
    if (!isWsl())
        return p;
    if (p.startsWith("/mnt/")) {
        const drive = p.slice(5, 6).toUpperCase();
        const rest = p.slice(7).replace(/\//g, "\\");
        return `${drive}:\\${rest}`;
    }
    try {
        return execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim();
    }
    catch {
        return p;
    }
}
function normalizePath(p) {
    if (!p)
        return undefined;
    const expanded = expandHome(p);
    if (isWindowsPath(expanded))
        return expanded;
    return path.resolve(expanded);
}
function coerceNumber(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string") {
        const n = Number(value);
        if (Number.isFinite(n))
            return n;
    }
    return undefined;
}
function coerceBool(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === "boolean")
        return value;
    if (typeof value === "number")
        return value !== 0;
    const v = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(v))
        return true;
    if (["0", "false", "no", "n", "off"].includes(v))
        return false;
    return undefined;
}
function parseHostsValue(value) {
    if (!value)
        return [];
    if (Array.isArray(value))
        return value.map((h) => h.trim()).filter(Boolean);
    return value
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
}
function detectWslNameserver() {
    if (!isWsl())
        return [];
    try {
        const text = fs.readFileSync("/etc/resolv.conf", "utf8");
        const match = text.match(/^nameserver\s+([0-9.]+)/m);
        if (match?.[1])
            return [match[1]];
    }
    catch {
        // ignore
    }
    return [];
}
function defaultHosts() {
    const out = [];
    if (isWsl()) {
        out.push(...detectWslNameserver());
        out.push("192.168.64.1");
    }
    out.push(...DEFAULT_HOSTS);
    return Array.from(new Set(out.filter(Boolean)));
}
function pickConfigLayer(file) {
    const { defaults, profiles, workspace, workspaces, profile, ...rest } = file;
    return rest;
}
function mergeLayer(base, overlay) {
    const mergeDefined = (src, extra) => {
        const out = { ...src };
        if (!extra)
            return out;
        for (const [key, value] of Object.entries(extra)) {
            if (value !== undefined)
                out[key] = value;
        }
        return out;
    };
    return {
        transport: mergeDefined(base.transport ?? {}, overlay.transport),
        testerTransport: mergeDefined(base.testerTransport ?? {}, overlay.testerTransport),
        context: mergeDefined(base.context ?? {}, overlay.context),
        baseTpl: overlay.baseTpl ?? base.baseTpl,
        compilePath: overlay.compilePath ?? base.compilePath,
        repoPath: overlay.repoPath ?? base.repoPath,
        repoAutoBuild: overlay.repoAutoBuild ?? base.repoAutoBuild,
        tester: mergeDefined(base.tester ?? {}, overlay.tester)
    };
}
function resolveHosts(layers) {
    for (const layer of layers) {
        const transport = layer.transport;
        if (!transport)
            continue;
        const hosts = parseHostsValue(transport.hosts);
        if (hosts.length)
            return hosts;
        const host = transport.host?.trim();
        if (host)
            return [host];
    }
    return defaultHosts();
}
function normalizeTester(cfg) {
    const merged = { ...DEFAULT_TESTER, ...(cfg ?? {}) };
    const syncCommonVal = coerceBool(merged.syncCommon);
    return {
        ...merged,
        allowDllImport: coerceNumber(merged.allowDllImport),
        allowLiveTrading: coerceNumber(merged.allowLiveTrading),
        expertsEnabled: coerceNumber(merged.expertsEnabled),
        expertsDisableOnAccountChange: coerceNumber(merged.expertsDisableOnAccountChange),
        expertsDisableOnProfileChange: coerceNumber(merged.expertsDisableOnProfileChange),
        maxTestDays: coerceNumber(merged.maxTestDays),
        startConfirmSec: coerceNumber(merged.startConfirmSec),
        maxBars: coerceNumber(merged.maxBars),
        maxBarsInChart: coerceNumber(merged.maxBarsInChart),
        model: coerceNumber(merged.model),
        executionMode: coerceNumber(merged.executionMode),
        optimization: coerceNumber(merged.optimization),
        useLocal: coerceNumber(merged.useLocal),
        useRemote: coerceNumber(merged.useRemote),
        useCloud: coerceNumber(merged.useCloud),
        syncCommon: syncCommonVal === undefined ? true : syncCommonVal,
        visual: coerceNumber(merged.visual),
        replaceReport: coerceNumber(merged.replaceReport),
        shutdownTerminal: coerceNumber(merged.shutdownTerminal),
        deposit: coerceNumber(merged.deposit),
        forwardMode: coerceNumber(merged.forwardMode),
        windowLeft: coerceNumber(merged.windowLeft),
        windowTop: coerceNumber(merged.windowTop),
        windowRight: coerceNumber(merged.windowRight),
        windowBottom: coerceNumber(merged.windowBottom),
        windowWidth: coerceNumber(merged.windowWidth),
        windowHeight: coerceNumber(merged.windowHeight),
        windowFullscreen: coerceNumber(merged.windowFullscreen)
    };
}
function normalizeContext(cfg) {
    const symbol = cfg?.symbol?.trim() || undefined;
    const tf = cfg?.tf?.trim() || undefined;
    const sub = coerceNumber(cfg?.sub);
    return { symbol, tf, sub };
}
function normalizeRunner(cfg) {
    if (!cfg)
        return undefined;
    return {
        ...cfg,
        terminalPath: normalizePath(cfg.terminalPath),
        dataPath: normalizePath(cfg.dataPath),
        metaeditorPath: normalizePath(cfg.metaeditorPath),
    };
}
function resolveWorkspaceRootInternal(_configPath, _repoPath) {
    // Workspace root is internal to cmdmt itself (no user override, no external paths).
    // This eliminates any chance of accidentally pointing to a real MT5 user Terminal folder.
    return path.resolve(__dirname, "..", "..", "workspaces");
}
function sanitizeWorkspaceNameFromConfig(name) {
    const trimmed = (name || "").trim();
    if (!trimmed)
        return "";
    if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
        throw new Error("workspace invalido no config (nao use /, \\ ou ..).");
    }
    return trimmed;
}
function resolveActiveWorkspaceDataPath(configPath, repoPath, cfg) {
    const rawActive = typeof cfg.workspace === "string" ? cfg.workspace : "";
    const activeName = rawActive ? sanitizeWorkspaceNameFromConfig(rawActive) : "";
    const root = resolveWorkspaceRootInternal(configPath, repoPath);
    if (activeName) {
        return path.join(root, activeName);
    }
    const names = Object.keys(cfg.workspaces ?? {})
        .map((k) => {
        try {
            return sanitizeWorkspaceNameFromConfig(k);
        }
        catch {
            return "";
        }
    })
        .filter(Boolean)
        .sort();
    const firstName = names[0];
    if (firstName)
        return path.join(root, firstName);
    return path.join(root, "default");
}
function resolveInternalRepoRoot(configPath, repoPath) {
    const candidates = [
        repoPath ? normalizePath(repoPath) : undefined,
        path.resolve(__dirname, "..", ".."),
        path.dirname(configPath)
    ].filter(Boolean);
    for (const c of candidates) {
        const exe = path.join(c, "mt5", "terminal", "terminal64.exe");
        if (fs.existsSync(exe))
            return c;
    }
    return candidates[0] ?? path.resolve(__dirname, "..", "..");
}
function loadConfigFile(filePath, required) {
    if (!fs.existsSync(filePath)) {
        if (required)
            throw new Error(`config nao encontrado: ${filePath}`);
        return {};
    }
    const raw = fs.readFileSync(filePath, "utf8");
    try {
        return JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`config invalido em ${filePath}: ${err.message}`);
    }
}
export function resolveConfigPath(cliPath, env = process.env) {
    const p = cliPath ?? env.CMDMT_CONFIG;
    if (!p) {
        for (const candidate of LOCAL_CONFIG_PATHS) {
            try {
                if (fs.existsSync(candidate))
                    return normalizePath(candidate) ?? candidate;
            }
            catch {
                // ignore
            }
        }
    }
    const fallback = p ?? DEFAULT_CONFIG_PATH;
    return normalizePath(fallback) ?? fallback;
}
export function resolveConfig(cli, env = process.env) {
    const envPre = collectEnv(cli.configPath, env);
    const configPath = resolveConfigPath(cli.configPath, envPre);
    const configFile = loadConfigFile(configPath, Boolean(cli.configPath || envPre.CMDMT_CONFIG));
    const envOverride = configFile.envPath && !env.CMDMT_ENV ? { ...env, CMDMT_ENV: configFile.envPath } : env;
    const envBase = collectEnv(configPath, envOverride);
    const profile = cli.profile ?? envBase.CMDMT_PROFILE ?? configFile.profile;
    const profileLayer = profile ? configFile.profiles?.[profile] : undefined;
    if (profile && !profileLayer) {
        throw new Error(`perfil nao encontrado: ${profile}`);
    }
    const envMerged = collectEnv(cli.configPath, envOverride, { profile });
    // Internal, stable auth source (inside container volume): /config/.cmdmt/.env
    // This prevents accidental auth drift from project .env files.
    const internalEnvPath = path.join(path.dirname(configPath), ".env");
    const internalEnv = loadDotEnvFile(internalEnvPath);
    const defaultsLayer = configFile.defaults ?? {};
    const configLayer = pickConfigLayer(configFile);
    const envLayer = {
        transport: {
            host: envMerged.CMDMT_HOST,
            hosts: envMerged.CMDMT_HOSTS,
            port: envMerged.CMDMT_PORT,
            timeoutMs: envMerged.CMDMT_TIMEOUT
        },
        testerTransport: {
            host: envMerged.CMDMT_TEST_HOST,
            hosts: envMerged.CMDMT_TEST_HOSTS,
            port: envMerged.CMDMT_TEST_PORT,
            timeoutMs: envMerged.CMDMT_TEST_TIMEOUT
        },
        context: {
            symbol: envMerged.CMDMT_SYMBOL,
            tf: envMerged.CMDMT_TF,
            sub: envMerged.CMDMT_SUB
        },
        baseTpl: envMerged.CMDMT_BASE_TPL,
        compilePath: envMerged.CMDMT_COMPILE,
        repoPath: envMerged.CMDMT_REPO,
        repoAutoBuild: envMerged.CMDMT_REPO_AUTOBUILD === undefined ? undefined : envMerged.CMDMT_REPO_AUTOBUILD !== "0",
        tester: {
            login: envMerged.CMDMT_LOGIN ?? envMerged.MT5_LOGIN,
            password: envMerged.CMDMT_PASSWORD ?? envMerged.MT5_PASSWORD,
            server: envMerged.CMDMT_SERVER ?? envMerged.MT5_SERVER,
            syncCommon: coerceBool(envMerged.CMDMT_SYNC_COMMON),
            maxBars: envMerged.CMDMT_MAXBARS,
            maxBarsInChart: envMerged.CMDMT_MAXBARS_CHART
        }
    };
    const internalAuthLayer = {
        tester: {
            login: internalEnv.CMDMT_LOGIN ?? internalEnv.MT5_LOGIN,
            password: internalEnv.CMDMT_PASSWORD ?? internalEnv.MT5_PASSWORD,
            server: internalEnv.CMDMT_SERVER ?? internalEnv.MT5_SERVER,
            syncCommon: coerceBool(internalEnv.CMDMT_SYNC_COMMON)
        }
    };
    const cliLayer = {
        transport: {
            host: cli.host,
            hosts: cli.hosts,
            port: cli.port,
            timeoutMs: cli.timeoutMs
        },
        testerTransport: {
            host: cli.testHost,
            hosts: cli.testHosts,
            port: cli.testPort,
            timeoutMs: cli.testTimeoutMs
        },
        context: {
            symbol: cli.symbol,
            tf: cli.tf,
            sub: cli.sub
        },
        baseTpl: cli.baseTpl,
        compilePath: cli.compilePath,
        repoPath: cli.repoPath
    };
    const merged = [defaultsLayer, profileLayer ?? {}, configLayer, envLayer, internalAuthLayer, cliLayer].reduce((acc, layer) => mergeLayer(acc, layer), {});
    // Dedicated internal transport (not user-configurable).
    const hosts = [...INTERNAL_TELNET_HOSTS];
    const port = INTERNAL_TELNET_PORT;
    const timeoutMs = DEFAULT_TIMEOUT;
    const testerTransport = { hosts, port, timeoutMs };
    const repoPathNormalized = merged.repoPath ? normalizePath(merged.repoPath) : undefined;
    // Avoid confusing workspace IDs that equal legacy Terminal/<HASH> folder names.
    const workspacePath = resolveActiveWorkspaceDataPath(configPath, repoPathNormalized, configFile);
    const workspaceWsl = isWsl() && isWindowsPath(workspacePath) ? toWslPath(workspacePath) : workspacePath;
    // Prefer the live container MT5 runtime when present; fallback to internal workspace.
    const liveDataRoot = "/config/.wine/drive_c/Program Files/MetaTrader 5";
    const internalDataRoot = fs.existsSync(path.join(liveDataRoot, "terminal64.exe"))
        ? liveDataRoot
        : path.join(workspaceWsl, ".cmdmt", "terminal");
    const runner = normalizeRunner({
        terminalPath: path.join(internalDataRoot, "terminal64.exe"),
        metaeditorPath: path.join(internalDataRoot, "MetaEditor64.exe"),
        dataPath: internalDataRoot,
        portable: true
    });
    const testerRunner = normalizeRunner({
        terminalPath: path.join(internalDataRoot, "terminal64.exe"),
        metaeditorPath: path.join(internalDataRoot, "MetaEditor64.exe"),
        dataPath: internalDataRoot,
        portable: true
    });
    const context = normalizeContext(merged.context);
    const tester = normalizeTester(merged.tester);
    return {
        configPath,
        profile,
        transport: { hosts, port, timeoutMs },
        testerTransport,
        context,
        baseTpl: merged.baseTpl,
        compilePath: merged.compilePath,
        repoPath: repoPathNormalized ?? merged.repoPath,
        repoAutoBuild: merged.repoAutoBuild,
        runnerId: INTERNAL_RUNNER_ID,
        runner,
        testerRunnerId: INTERNAL_RUNNER_ID,
        testerRunner,
        tester
    };
}
export function requireTransport(config) {
    if (!config.transport.hosts || config.transport.hosts.length === 0) {
        throw new Error("host nao configurado. Use --host/--hosts, CMDMT_HOST(S) ou transport.host(s) no config.");
    }
    return config.transport;
}
export function requireTestTransport(config) {
    if (config.testerTransport)
        return config.testerTransport;
    return requireTransport(config);
}
function assertInternalRunnerDataPath(rawDataPath, label) {
    const dataPath = isWsl() && isWindowsPath(rawDataPath) ? toWslPath(rawDataPath) : rawDataPath;
    const norm = path.resolve(dataPath).replace(/\\/g, "/").toLowerCase();
    const liveRoot = "/config/.wine/drive_c/program files/metatrader 5";
    if (norm === liveRoot || norm.startsWith(liveRoot + "/")) {
        return;
    }
    const root = path.resolve(__dirname, "..", "..", "workspaces");
    const abs = path.resolve(dataPath);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`${label} bloqueado: dataPath fora do workspace interno.`);
    }
    const normWs = abs.replace(/\\/g, "/").toLowerCase();
    if (!normWs.endsWith("/.cmdmt/terminal")) {
        throw new Error(`${label} bloqueado: dataPath invalido (esperado .../.cmdmt/terminal).`);
    }
    if (!fs.existsSync(abs))
        return;
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
        throw new Error(`${label} bloqueado: dataPath e um link/junction.`);
    }
    const mql5 = path.join(abs, "MQL5");
    if (fs.existsSync(mql5) && fs.lstatSync(mql5).isSymbolicLink()) {
        throw new Error(`${label} bloqueado: MQL5 e um link/junction.`);
    }
    const scan = (dir, name) => {
        if (!fs.existsSync(dir))
            return;
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            try {
                if (fs.lstatSync(full).isSymbolicLink()) {
                    throw new Error(`${label} bloqueado: ${name} contem link/junction (${ent.name}).`);
                }
            }
            catch (err) {
                if (err instanceof Error)
                    throw err;
            }
        }
    };
    scan(path.join(mql5, "Experts"), "Experts");
    scan(path.join(mql5, "Indicators"), "Indicators");
}
function requireRunnerBase(runner, label) {
    if (!runner) {
        throw new Error(`${label} interno nao inicializado.`);
    }
    const terminalPath = runner.terminalPath;
    const dataPath = runner.dataPath;
    if (!terminalPath) {
        throw new Error(`${label} interno sem terminalPath.`);
    }
    if (!dataPath) {
        throw new Error(`${label} interno sem dataPath (workspace ativo ausente).`);
    }
    assertInternalRunnerDataPath(dataPath, label);
    return { ...runner, terminalPath, dataPath };
}
export function requireRunner(config) {
    return requireRunnerBase(config.runner, "runner");
}
export function requireTestRunner(config) {
    if (config.testerRunner)
        return requireRunnerBase(config.testerRunner, "runner de teste");
    return requireRunnerBase(config.runner, "runner");
}
