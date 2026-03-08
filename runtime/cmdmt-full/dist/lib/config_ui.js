import fs from "node:fs";
import path from "node:path";
import { checkbox, confirm, input, number, password, select } from "@inquirer/prompts";
import { MT5_INI } from "../types/mt5IniKeys.js";
import { applyIniPatch, readIniValue } from "./iniMap.js";
import { isWindowsPath, isWsl, toWslPath, toWindowsPath } from "./config.js";
import { readTextWithEncoding, writeTextWithEncoding } from "./textfile.js";
import { resolveAuthEnvPath, upsertDotEnv } from "./auth_env.js";
function readJsonObject(filePath) {
    try {
        if (!fs.existsSync(filePath))
            return {};
        const raw = fs.readFileSync(filePath, "utf8");
        const obj = JSON.parse(raw);
        return obj && typeof obj === "object" ? obj : {};
    }
    catch {
        return {};
    }
}
function writeJsonObject(filePath, data) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function maskSecret(v) {
    if (!v)
        return "";
    return "*".repeat(Math.max(4, Math.min(12, v.length)));
}
function parseIniBool(v, fallback) {
    if (v === null)
        return fallback;
    const t = String(v).trim();
    if (t === "1")
        return true;
    if (t === "0")
        return false;
    return fallback;
}
function resolveConfigDir(dataPathWsl) {
    const lower = path.join(dataPathWsl, "config");
    const upper = path.join(dataPathWsl, "Config");
    if (fs.existsSync(lower))
        return lower;
    if (fs.existsSync(upper))
        return upper;
    return lower;
}
function toWslMaybe(p) {
    if (!p)
        return p;
    if (!isWsl())
        return p;
    if (!isWindowsPath(p))
        return p;
    return toWslPath(p);
}
async function editAuth(resolved, cfgObj, opts) {
    const envPath = resolveAuthEnvPath(resolved.configPath, cfgObj);
    const curLogin = resolved.tester.login !== undefined ? String(resolved.tester.login) : "";
    const curServer = String(resolved.tester.server ?? "");
    const curPass = String(resolved.tester.password ?? "");
    const login = (await input({
        message: `Login (env: ${toWindowsPath(envPath)})`,
        default: curLogin,
        validate: (v) => (String(v).trim() ? true : "obrigatorio")
    }))
        .trim();
    const server = (await input({
        message: "Servidor",
        default: curServer,
        validate: (v) => (String(v).trim() ? true : "obrigatorio")
    }))
        .trim();
    const passIn = await password({
        message: `Senha (ENTER para manter atual: ${maskSecret(curPass) || "(vazio)"})`,
        mask: "*"
    });
    const nextPass = passIn ? String(passIn) : curPass;
    const updates = {
        CMDMT_LOGIN: login,
        CMDMT_PASSWORD: nextPass,
        CMDMT_SERVER: server,
        MT5_LOGIN: login,
        MT5_PASSWORD: nextPass,
        MT5_SERVER: server
    };
    if (!opts.yes) {
        const ok = await confirm({
            message: `Salvar credenciais em ${toWindowsPath(envPath)}?`,
            default: true
        });
        if (!ok)
            return;
    }
    if (opts.dryRun) {
        process.stdout.write("[DRY] auth set env=" + toWindowsPath(envPath) + " login=" + login + " server=" + server + "\n");
        return;
    }
    upsertDotEnv(envPath, updates);
    process.stdout.write("OK auth atualizado (env: " + toWindowsPath(envPath) + ")\n");
}
async function editTester(resolved, cfgObj, opts) {
    const cfgTester = (cfgObj.tester && typeof cfgObj.tester === "object") ? cfgObj.tester : {};
    const curFrom = String(cfgTester.fromDate ?? (resolved.tester.fromDate ?? ""));
    const curTo = String(cfgTester.toDate ?? (resolved.tester.toDate ?? ""));
    const curMaxDaysRaw = cfgTester.maxTestDays ?? resolved.tester.maxTestDays ?? 2;
    const curMaxDays = typeof curMaxDaysRaw === "number" ? curMaxDaysRaw : parseInt(String(curMaxDaysRaw), 10) || 2;
    const fromDate = (await input({
        message: "FromDate (YYYY.MM.DD)",
        default: curFrom,
        validate: (v) => (/^\d{4}\.\d{2}\.\d{2}$/.test(String(v).trim()) ? true : "use YYYY.MM.DD")
    }))
        .trim();
    const toDate = (await input({
        message: "ToDate (YYYY.MM.DD)",
        default: curTo,
        validate: (v) => (/^\d{4}\.\d{2}\.\d{2}$/.test(String(v).trim()) ? true : "use YYYY.MM.DD")
    }))
        .trim();
    const maxTestDays = await number({
        message: "MaxTestDays (0 desativa truncamento)",
        default: curMaxDays,
        min: 0
    });
    const curVisual = Number(cfgTester.visual ?? resolved.tester.visual ?? 0) !== 0;
    const curAllowOpen = Boolean(cfgTester.allowOpen ?? resolved.tester.allowOpen ?? false);
    const curShutdown = Number(cfgTester.shutdownTerminal ?? resolved.tester.shutdownTerminal ?? 1) !== 0;
    const curSyncCommon = Boolean(cfgTester.syncCommon ?? resolved.tester.syncCommon ?? false);
    const flags = await checkbox({
        message: "Flags (SPACE marca/desmarca)",
        choices: [
            { name: "Visual", value: "visual", checked: curVisual },
            { name: "KeepOpen (nao fechar janela)", value: "allowOpen", checked: curAllowOpen },
            { name: "ShutdownTerminal (fechar ao final)", value: "shutdownTerminal", checked: curShutdown },
            { name: "SyncCommon (escrever login em common.ini)", value: "syncCommon", checked: curSyncCommon }
        ]
    });
    const nextTester = {
        ...cfgTester,
        fromDate,
        toDate,
        maxTestDays,
        visual: flags.includes("visual") ? 1 : 0,
        allowOpen: flags.includes("allowOpen"),
        shutdownTerminal: flags.includes("shutdownTerminal") ? 1 : 0,
        syncCommon: flags.includes("syncCommon")
    };
    const nextCfg = { ...cfgObj, tester: nextTester };
    if (!opts.yes) {
        const ok = await confirm({
            message: `Salvar tester defaults em ${toWindowsPath(resolved.configPath)}?`,
            default: true
        });
        if (!ok)
            return;
    }
    if (opts.dryRun) {
        process.stdout.write("[DRY] write config: " + toWindowsPath(resolved.configPath) + "\n");
        return;
    }
    writeJsonObject(resolved.configPath, nextCfg);
    process.stdout.write("OK tester defaults atualizado (config: " + toWindowsPath(resolved.configPath) + ")\n");
}
async function editCommonIni(resolved, cfgObj, opts) {
    const dataPathWin = String(resolved.testerRunner?.dataPath ?? "");
    if (!dataPathWin) {
        process.stderr.write("common.ini: tester runner nao configurado (dataPath vazio)\n");
        return;
    }
    const dataPathWsl = toWslMaybe(dataPathWin);
    const configDir = resolveConfigDir(dataPathWsl);
    const commonPath = path.join(configDir, "common.ini");
    const exists = fs.existsSync(commonPath);
    const file = exists
        ? readTextWithEncoding(commonPath)
        : { text: "", encoding: "utf16le", bom: true };
    const curAllowDll = parseIniBool(readIniValue(file.text, MT5_INI.SECTION.EXPERTS, MT5_INI.KEY.ALLOW_DLL_IMPORT), true);
    const curAllowLive = parseIniBool(readIniValue(file.text, MT5_INI.SECTION.EXPERTS, MT5_INI.KEY.ALLOW_LIVE_TRADING), true);
    const curSyncCommon = Boolean((cfgObj.tester && typeof cfgObj.tester === "object" && cfgObj.tester.syncCommon !== undefined)
        ? Boolean(cfgObj.tester.syncCommon)
        : Boolean(resolved.tester.syncCommon ?? true));
    const picks = await checkbox({
        message: `common.ini (${toWindowsPath(commonPath)})`,
        choices: [
            { name: "AllowDllImport", value: "allowDll", checked: curAllowDll },
            { name: "AllowLiveTrading", value: "allowLive", checked: curAllowLive },
            { name: "Sync login/password/server (from env)", value: "syncAuth", checked: curSyncCommon }
        ]
    });
    const allowDll = picks.includes("allowDll");
    const allowLive = picks.includes("allowLive");
    const syncAuth = picks.includes("syncAuth");
    const login = resolved.tester.login !== undefined ? String(resolved.tester.login) : "";
    const server = String(resolved.tester.server ?? "");
    const pass = String(resolved.tester.password ?? "");
    if (syncAuth && (!login || !server || !pass)) {
        process.stderr.write("common.ini: faltam credenciais. Rode 'cmdmt auth set ...' primeiro.\n");
        return;
    }
    const patch = {
        [MT5_INI.SECTION.EXPERTS]: {
            [MT5_INI.KEY.ALLOW_DLL_IMPORT]: allowDll ? "1" : "0",
            [MT5_INI.KEY.ALLOW_LIVE_TRADING]: allowLive ? "1" : "0"
        },
        [MT5_INI.SECTION.COMMON]: {
            [MT5_INI.KEY.LOGIN]: null,
            [MT5_INI.KEY.PASSWORD]: null,
            [MT5_INI.KEY.SERVER]: null
        }
    };
    if (syncAuth) {
        patch[MT5_INI.SECTION.COMMON] = {
            [MT5_INI.KEY.LOGIN]: login,
            [MT5_INI.KEY.PASSWORD]: pass,
            [MT5_INI.KEY.SERVER]: server
        };
    }
    const next = applyIniPatch(file.text, patch);
    if (!opts.yes) {
        const ok = await confirm({
            message: `Salvar common.ini em ${toWindowsPath(commonPath)}?`,
            default: true
        });
        if (!ok)
            return;
    }
    if (opts.dryRun) {
        process.stdout.write("[DRY] write ini: " + toWindowsPath(commonPath) + "\n");
        return;
    }
    fs.mkdirSync(configDir, { recursive: true });
    writeTextWithEncoding(commonPath, next, file.encoding, file.bom);
    process.stdout.write("OK common.ini atualizado\n");
}
export async function runConfigUi(resolved, opts = {}) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write("config: precisa de terminal interativo (TTY)\n");
        process.stderr.write("dica: rode direto no terminal, sem pipe/redirecionamento\n");
        return;
    }
    const cfgObj = readJsonObject(resolved.configPath);
    let target = opts.target ?? "menu";
    for (;;) {
        if (target === "menu") {
            const pick = await select({
                message: "Configurar:",
                choices: [
                    { name: "Auth (login/server/password)", value: "auth" },
                    { name: "Tester defaults (.ini)", value: "tester" },
                    { name: "common.ini (AllowDll/AllowLive + sync login)", value: "common" },
                    { name: "Sair", value: "exit" }
                ]
            });
            if (pick === "exit")
                return;
            target = pick;
        }
        if (target === "auth")
            await editAuth(resolved, cfgObj, opts);
        else if (target === "tester")
            await editTester(resolved, cfgObj, opts);
        else if (target === "common")
            await editCommonIni(resolved, cfgObj, opts);
        else
            return;
        if (opts.target && opts.target !== "menu")
            return;
        const again = await confirm({ message: "Editar outra coisa?", default: true });
        if (!again)
            return;
        target = "menu";
    }
}
