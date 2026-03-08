import fs from "node:fs";
import path from "node:path";
import { isTf, parseSub, resolveSymTf, splitArgs } from "./args.js";
import { renderHelp, renderExamples } from "./help.js";
import { formatAutoList, parseAutoCodes, normalizeAutoMacroName, resolveAutoCodes, codesToHotkeys } from "./auto.js";
import { saveAutoMacros } from "./auto_store.js";
import { safeFileBase, stableHash } from "./naming.js";
import { DEFAULT_ATTACH_META } from "./attach_report.js";
function err(msg) {
    return { kind: "error", message: msg };
}
const PARAMS_HINT = "params devem ser passados com --params k=v ... (ex: --params depth=12 deviation=5)";
const DEFAULT_SYMBOL = "EURUSD";
const DEFAULT_TF = "M5";
function normalizeInstallTarget(raw) {
    const v = raw.trim().toLowerCase();
    if (!v)
        return null;
    if (v === "all" || v === "tudo")
        return "all";
    if (v === "mt5" || v === "terminal" || v === "runner")
        return "mt5";
    if (v === "mt5ide")
        return "mt5ide";
    if (v === "pyplot" || v === "pyplotmt")
        return "pyplot";
    if (v === "telnet" || v === "telnetmt" || v === "telnetservice" || v === "telnetmtservice")
        return "telnet";
    return null;
}
function parseKindFlags(args) {
    let kind;
    const rest = [];
    for (const tok of args) {
        const low = tok.toLowerCase();
        if (low === "--ind" || low === "-i") {
            kind = "indicator";
            continue;
        }
        if (low === "--exp" || low === "-e") {
            kind = "expert";
            continue;
        }
        rest.push(tok);
    }
    return { kind, rest };
}
function parseSymTfDefault(args, ctx) {
    const a = [...args];
    let sym = ctx.symbol?.trim() || DEFAULT_SYMBOL;
    let tf = ctx.tf?.trim() || DEFAULT_TF;
    if (a.length >= 2 && isTf(a[1])) {
        sym = a[0];
        tf = a[1];
        a.splice(0, 2);
    }
    else if (a.length >= 1 && isTf(a[0])) {
        tf = a[0];
        a.splice(0, 1);
    }
    return { sym, tf, rest: a };
}
// Flexible SYMBOL/TF parsing for commands that accept either:
// - SYMBOL TF NAME
// - NAME SYMBOL TF
function parseSymTfFlexible(args, ctx) {
    const a = [...args];
    let sym = ctx.symbol?.trim() || DEFAULT_SYMBOL;
    let tf = ctx.tf?.trim() || DEFAULT_TF;
    if (a.length >= 2 && isTf(a[1])) {
        sym = a[0];
        tf = a[1];
        a.splice(0, 2);
        return { sym, tf, rest: a };
    }
    if (a.length >= 1 && isTf(a[0])) {
        tf = a[0];
        a.splice(0, 1);
        return { sym, tf, rest: a };
    }
    if (a.length >= 2 && isTf(a[a.length - 1])) {
        const maybeSym = a[a.length - 2];
        if (maybeSym && !maybeSym.startsWith("--") && !maybeSym.includes("=")) {
            tf = a[a.length - 1];
            sym = maybeSym;
            a.splice(a.length - 2, 2);
            return { sym, tf, rest: a };
        }
    }
    return { sym, tf, rest: a };
}
function requireSymTf(args, ctx) {
    return resolveSymTf(args, ctx, true);
}
function parseBoolFlag(val, defaultValue) {
    if (val === undefined || val === "")
        return defaultValue;
    const v = val.toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(v))
        return true;
    if (["0", "false", "no", "n", "off"].includes(v))
        return false;
    return defaultValue;
}
function parseIntFlag(val, min, max) {
    if (!val)
        return null;
    const n = parseInt(val, 10);
    if (!Number.isFinite(n))
        return null;
    return Math.max(min, Math.min(max, n));
}
function parseCsvFlags(tokens) {
    let csv;
    const rest = [];
    const readValue = (tok, i) => {
        if (tok.includes("=")) {
            return { value: tok.slice(tok.indexOf("=") + 1), skip: 0 };
        }
        if (i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
            return { value: tokens[i + 1], skip: 1 };
        }
        return { value: "", skip: 0 };
    };
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        const lower = tok.toLowerCase();
        if (lower === "--csv-rates" || lower.startsWith("--csv-rates=")) {
            const { value, skip } = readValue(tok, i);
            i += skip;
            csv = { mode: "rates", csv: value, symbol: "" };
            continue;
        }
        if (lower === "--csv-ticks" || lower.startsWith("--csv-ticks=")) {
            const { value, skip } = readValue(tok, i);
            i += skip;
            csv = { mode: "ticks", csv: value, symbol: "" };
            continue;
        }
        if (lower === "--csv-symbol" || lower.startsWith("--csv-symbol=")) {
            const { value, skip } = readValue(tok, i);
            i += skip;
            csv = csv ?? { mode: "rates", csv: "", symbol: "" };
            csv.symbol = value;
            continue;
        }
        if (lower === "--csv-tf" || lower.startsWith("--csv-tf=")) {
            const { value, skip } = readValue(tok, i);
            i += skip;
            csv = csv ?? { mode: "rates", csv: "", symbol: "" };
            csv.tf = value;
            continue;
        }
        if (lower === "--csv-base" || lower.startsWith("--csv-base=")) {
            const { value, skip } = readValue(tok, i);
            i += skip;
            csv = csv ?? { mode: "rates", csv: "", symbol: "" };
            csv.base = value;
            continue;
        }
        if (lower === "--csv-digits" || lower.startsWith("--csv-digits=")) {
            const { value, skip } = readValue(tok, i);
            i += skip;
            const n = parseIntFlag(value, 0, 12);
            csv = csv ?? { mode: "rates", csv: "", symbol: "" };
            if (n !== null)
                csv.digits = n;
            continue;
        }
        if (lower === "--csv-spread" || lower.startsWith("--csv-spread=")) {
            const { value, skip } = readValue(tok, i);
            i += skip;
            const n = parseIntFlag(value, 0, 1000000);
            csv = csv ?? { mode: "rates", csv: "", symbol: "" };
            if (n !== null)
                csv.spread = n;
            continue;
        }
        if (lower === "--csv-tz" || lower.startsWith("--csv-tz=")) {
            const { value, skip } = readValue(tok, i);
            i += skip;
            const n = parseIntFlag(value, -24, 24);
            csv = csv ?? { mode: "rates", csv: "", symbol: "" };
            if (n !== null)
                csv.tz = n;
            continue;
        }
        if (lower === "--csv-sep" || lower.startsWith("--csv-sep=")) {
            const { value, skip } = readValue(tok, i);
            i += skip;
            csv = csv ?? { mode: "rates", csv: "", symbol: "" };
            csv.sep = value;
            continue;
        }
        if (lower === "--csv-recreate") {
            csv = csv ?? { mode: "rates", csv: "", symbol: "" };
            csv.recreate = true;
            continue;
        }
        if (lower === "--csv-common") {
            csv = csv ?? { mode: "rates", csv: "", symbol: "" };
            csv.common = true;
            continue;
        }
        rest.push(tok);
    }
    return { csv, rest };
}
function extractFlagValue(tokens, name) {
    const rest = [];
    let value;
    const flag = `--${name}`;
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        const low = tok.toLowerCase();
        if (low === flag) {
            const next = tokens[i + 1];
            if (next && !next.startsWith("--")) {
                value = next;
                i += 1;
            }
            else {
                value = "";
            }
            continue;
        }
        if (low.startsWith(`${flag}=`)) {
            value = tok.slice(flag.length + 1);
            continue;
        }
        rest.push(tok);
    }
    return { value, rest };
}
function extractYesFlag(tokens) {
    let yes = false;
    const rest = [];
    for (const tok of tokens) {
        const lower = tok.toLowerCase();
        if (lower === "--yes" || lower === "-y") {
            yes = true;
            continue;
        }
        rest.push(tok);
    }
    return { yes, rest };
}
function parseParamsAndMeta(tokens) {
    const meta = { ...DEFAULT_ATTACH_META };
    if (tokens.length === 0)
        return { params: "", rest: tokens, meta };
    const rest = [];
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        const lower = tok.toLowerCase();
        if (lower === "--params" || lower.startsWith("--params=")) {
            const inline = lower.startsWith("--params=") ? tok.slice("--params=".length) : "";
            const paramsTokens = inline ? [inline] : tokens.slice(i + 1);
            return { params: paramsTokens.join(";"), rest, meta };
        }
        if (lower === "--report" || lower.startsWith("--report=")) {
            const val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
            meta.report = parseBoolFlag(val, true);
            continue;
        }
        if (lower === "--no-report") {
            meta.report = false;
            continue;
        }
        if (lower === "--buffers" || lower.startsWith("--buffers=")) {
            let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
            if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
                val = tokens[i + 1];
                i += 1;
            }
            const n = parseIntFlag(val, 1, 200);
            if (n !== null)
                meta.buffers = n;
            continue;
        }
        if (lower === "--log" || lower.startsWith("--log=")) {
            let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
            if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
                val = tokens[i + 1];
                i += 1;
            }
            const n = parseIntFlag(val, 1, 500);
            if (n !== null)
                meta.logTail = n;
            continue;
        }
        if (lower === "--shot" || lower.startsWith("--shot=")) {
            const val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
            meta.shot = parseBoolFlag(val, true);
            continue;
        }
        if (lower === "--no-shot") {
            meta.shot = false;
            continue;
        }
        if (lower === "--shotname" || lower.startsWith("--shotname=")) {
            let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
            if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
                val = tokens[i + 1];
                i += 1;
            }
            if (val) {
                meta.shotName = val;
                meta.shot = true;
            }
            continue;
        }
        rest.push(tok);
    }
    return { params: "", rest, meta };
}
function hasImplicitParams(tokens) {
    return tokens.some((t) => t.includes("=") && !t.toLowerCase().startsWith("sub="));
}
function maybeResolveLocalPath(name) {
    const trimmed = name.trim().replace(/^"+|"+$/g, "");
    if (!/\.(mq5|ex5)$/i.test(trimmed))
        return name;
    const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
    if (fs.existsSync(abs))
        return abs;
    return name;
}
function requireBaseTpl(ctx) {
    return ctx.baseTpl?.trim() || null;
}
function buildTplName(expert, symbol, tf, params) {
    const base = safeFileBase(`${expert}-${symbol}-${tf}`);
    const hash = stableHash(`${expert}|${symbol}|${tf}|${params}`);
    return `${base}-${hash}.tpl`;
}
function parseInstallArgs(tokens) {
    let allowDll = undefined;
    let allowLive = undefined;
    let syncCommon = undefined;
    let dryRun = undefined;
    let repoPath = undefined;
    let name = undefined;
    let namePrefix = undefined;
    let activate = undefined;
    let all = undefined;
    let auto = undefined;
    const targets = [];
    const web = [];
    const rest = [];
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        const lower = tok.toLowerCase();
        if (lower === "--allow-dll") {
            allowDll = true;
            continue;
        }
        if (lower === "--no-allow-dll") {
            allowDll = false;
            continue;
        }
        if (lower === "--allow-live") {
            allowLive = true;
            continue;
        }
        if (lower === "--no-allow-live") {
            allowLive = false;
            continue;
        }
        if (lower === "--sync-common") {
            syncCommon = true;
            continue;
        }
        if (lower === "--no-sync-common") {
            syncCommon = false;
            continue;
        }
        if (lower === "--dry-run") {
            dryRun = true;
            continue;
        }
        if (lower === "--auto" || lower === "--last") {
            auto = true;
            continue;
        }
        if (lower === "--all") {
            all = true;
            continue;
        }
        if (lower === "--activate") {
            activate = true;
            continue;
        }
        if (lower === "--no-activate") {
            activate = false;
            continue;
        }
        if (lower === "--web" || lower.startsWith("--web=")) {
            let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
            if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
                val = tokens[i + 1];
                i += 1;
            }
            if (val)
                web.push(val);
            continue;
        }
        if (lower === "--repo" || lower.startsWith("--repo=")) {
            let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
            if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
                val = tokens[i + 1];
                i += 1;
            }
            if (val)
                repoPath = val;
            continue;
        }
        if (lower === "--name" || lower.startsWith("--name=")) {
            let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
            if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
                val = tokens[i + 1];
                i += 1;
            }
            if (val)
                name = val;
            continue;
        }
        if (lower === "--name-prefix" || lower.startsWith("--name-prefix=")) {
            let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
            if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
                val = tokens[i + 1];
                i += 1;
            }
            if (val)
                namePrefix = val;
            continue;
        }
        if (!lower.startsWith("--")) {
            const target = normalizeInstallTarget(lower);
            if (target) {
                if (target === "all") {
                    all = true;
                }
                else {
                    targets.push(target);
                }
                continue;
            }
        }
        rest.push(tok);
    }
    if (rest.length)
        return null;
    return {
        allowDll,
        allowLive,
        syncCommon,
        web,
        dryRun,
        repoPath,
        name,
        namePrefix,
        activate,
        targets: targets.length ? targets : undefined,
        all,
        auto
    };
}
function parseDoctorArgs(tokens) {
    let allowDll = undefined;
    let allowLive = undefined;
    let syncCommon = undefined;
    let apply = undefined;
    let repoPath = undefined;
    let name = undefined;
    let namePrefix = undefined;
    const web = [];
    const rest = [];
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        const lower = tok.toLowerCase();
        if (lower === "--allow-dll") {
            allowDll = true;
            continue;
        }
        if (lower === "--no-allow-dll") {
            allowDll = false;
            continue;
        }
        if (lower === "--allow-live") {
            allowLive = true;
            continue;
        }
        if (lower === "--no-allow-live") {
            allowLive = false;
            continue;
        }
        if (lower === "--sync-common") {
            syncCommon = true;
            continue;
        }
        if (lower === "--no-sync-common") {
            syncCommon = false;
            continue;
        }
        if (lower === "--apply") {
            apply = true;
            continue;
        }
        if (lower === "--dry-run") {
            apply = false;
            continue;
        }
        if (lower === "--web" || lower.startsWith("--web=")) {
            let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
            if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
                val = tokens[i + 1];
                i += 1;
            }
            if (val)
                web.push(val);
            continue;
        }
        if (lower === "--repo" || lower.startsWith("--repo=")) {
            let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
            if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
                val = tokens[i + 1];
                i += 1;
            }
            if (val)
                repoPath = val;
            continue;
        }
        if (lower === "--name" || lower.startsWith("--name=")) {
            let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
            if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
                val = tokens[i + 1];
                i += 1;
            }
            if (val)
                name = val;
            continue;
        }
        if (lower === "--name-prefix" || lower.startsWith("--name-prefix=")) {
            let val = lower.includes("=") ? tok.slice(tok.indexOf("=") + 1) : "";
            if (!val && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
                val = tokens[i + 1];
                i += 1;
            }
            if (val)
                namePrefix = val;
            continue;
        }
        rest.push(tok);
    }
    if (rest.length)
        return null;
    return { apply, allowDll, allowLive, syncCommon, web, repoPath, name, namePrefix };
}
export function dispatch(tokens, ctx) {
    if (tokens.length === 0)
        return { kind: "local", output: renderHelp().join("\n") };
    const macros = ctx.autoMacros ?? (ctx.autoMacros = {});
    const firstRaw = tokens[0];
    if (firstRaw && firstRaw.startsWith("@")) {
        const name = normalizeAutoMacroName(firstRaw);
        const macro = macros[name];
        if (macro && !Array.isArray(macro)) {
            const cmdTokens = splitArgs(macro.cmd);
            if (!cmdTokens.length)
                return err(`auto: macro vazia: ${name}`);
            return dispatch(cmdTokens, ctx);
        }
        return dispatch(["auto", "run", ...tokens], ctx);
    }
    const cmd = tokens[0].toLowerCase();
    const rest = tokens.slice(1);
    if (cmd === "help") {
        const key = rest.join(" ").trim();
        if (key)
            return { kind: "local", output: renderExamples(key) };
        return { kind: "local", output: renderHelp().join("\n") };
    }
    if (cmd === "examples") {
        const key = rest.join(" ").trim();
        return { kind: "local", output: renderExamples(key) };
    }
    if (cmd === "watch") {
        if (!rest.length) {
            if (ctx.watchKind && ctx.watchName) {
                return { kind: "local", output: `watching: ${ctx.watchKind} ${ctx.watchName}` };
            }
            return { kind: "local", output: "watching: (none)" };
        }
        const { kind, rest: r2 } = parseKindFlags(rest);
        if (r2.length && r2[0].toLowerCase() === "clear") {
            ctx.watchKind = undefined;
            ctx.watchName = undefined;
            return { kind: "local", output: "watching: (none)" };
        }
        if (!kind)
            return err("uso: watch -i NOME | watch -e NOME | watch clear");
        const name = r2.join(" ").trim();
        if (!name)
            return err("uso: watch -i NOME | watch -e NOME | watch clear");
        ctx.watchKind = kind;
        ctx.watchName = name;
        return { kind: "local", output: `watching: ${kind} ${name}` };
    }
    if (cmd === "auto") {
        const sub = rest[0]?.toLowerCase();
        const listCodes = (tokens) => {
            const { value: codeVal, rest: afterCode } = extractFlagValue(tokens, "code");
            const tailCodes = afterCode.filter((t) => !t.startsWith("--"));
            const codes = [
                ...parseAutoCodes(codeVal),
                ...tailCodes.flatMap((t) => parseAutoCodes(t))
            ];
            const output = formatAutoList(codes.length ? codes : undefined, macros);
            return { kind: "local", output };
        };
        if (!sub || sub === "ls" || sub.startsWith("--")) {
            const args = sub === "ls" ? rest.slice(1) : rest;
            return listCodes(args);
        }
        if (sub === "add") {
            const args = rest.slice(1);
            const { value: nameVal, rest: afterName } = extractFlagValue(args, "name");
            const { value: cmdVal, rest: afterCmd } = extractFlagValue(afterName, "cmd");
            const { value: codeVal, rest: afterCode } = extractFlagValue(afterCmd, "code");
            const name = normalizeAutoMacroName(nameVal ?? "");
            if (!name)
                return err("uso: auto add --code C1,C2 --name @macro");
            if (cmdVal) {
                if (codeVal || afterCode.length)
                    return err("uso: auto add --cmd \"comando\" --name @macro");
                macros[name] = { cmd: cmdVal };
                if (ctx.autoMacrosPath)
                    saveAutoMacros(ctx.autoMacrosPath, macros);
                return { kind: "local", output: `ok ${name} = cmd: ${cmdVal}` };
            }
            const codesRaw = codeVal ? parseAutoCodes(codeVal) : afterCode.flatMap((t) => parseAutoCodes(t));
            if (!codesRaw.length)
                return err("uso: auto add --code C1,C2 --name @macro");
            const resolved = resolveAutoCodes(codesRaw, macros);
            if (!resolved.codes.length) {
                return err(`auto: nenhum codigo valido (${resolved.unknown.join(", ")})`);
            }
            macros[name] = resolved.codes;
            if (ctx.autoMacrosPath)
                saveAutoMacros(ctx.autoMacrosPath, macros);
            const suffix = resolved.unknown.length ? ` (ignored: ${resolved.unknown.join(", ")})` : "";
            return { kind: "local", output: `ok ${name} = ${macros[name].join(",")}${suffix}` };
        }
        if (sub === "run" || sub === "send") {
            const args = rest.slice(1);
            const sandbox = args.some((t) => t.toLowerCase() === "--sandbox" || t.toLowerCase() === "--test");
            const argsNoTarget = args.filter((t) => {
                const low = t.toLowerCase();
                return low !== "--sandbox" && low !== "--test";
            });
            if (argsNoTarget.length === 1 && argsNoTarget[0].startsWith("@")) {
                const name = normalizeAutoMacroName(argsNoTarget[0]);
                const macro = macros[name];
                if (macro && !Array.isArray(macro)) {
                    const cmdTokens = splitArgs(macro.cmd);
                    if (!cmdTokens.length)
                        return err(`auto: macro vazia: ${name}`);
                    return dispatch(cmdTokens, ctx);
                }
            }
            const { value: codeVal, rest: afterCode } = extractFlagValue(argsNoTarget, "code");
            const { value: keysVal, rest: afterKeys } = extractFlagValue(afterCode, "keys");
            const codeTokens = [];
            const keyTokens = [];
            const codePattern = /^[a-zA-Z]\d+$/;
            const sectionPattern = /^[a-zA-Z]$/;
            const sectionWildcard = /^[a-zA-Z]\*$/;
            const pushToken = (tok) => {
                if (!tok)
                    return;
                if (tok.startsWith("@") || codePattern.test(tok) || sectionPattern.test(tok) || sectionWildcard.test(tok)) {
                    codeTokens.push(tok);
                }
                else {
                    keyTokens.push(tok);
                }
            };
            parseAutoCodes(codeVal).forEach((t) => codeTokens.push(t));
            parseAutoCodes(keysVal).forEach((t) => keyTokens.push(t));
            afterKeys.forEach((t) => pushToken(t));
            const resolved = resolveAutoCodes(codeTokens, macros);
            const hotkeys = codesToHotkeys(resolved.codes);
            const combined = [...hotkeys, ...keyTokens];
            if (!combined.length) {
                return err("uso: auto run --code M1,M2 | auto run --keys \"ALT+6,ENTER\"");
            }
            return {
                kind: "auto_run",
                target: sandbox ? "test" : "runner",
                keys: combined,
                unknown: resolved.unknown.length ? resolved.unknown : undefined
            };
        }
        if (sub === "rm" || sub === "remove" || sub === "rl" || sub === "del") {
            const args = rest.slice(1);
            const { value: nameVal, rest: afterName } = extractFlagValue(args, "name");
            const name = normalizeAutoMacroName(nameVal ?? afterName.join(" "));
            if (!name)
                return err("uso: auto rm --name @macro");
            if (!macros[name])
                return err(`auto: macro nao encontrada: ${name}`);
            delete macros[name];
            if (ctx.autoMacrosPath)
                saveAutoMacros(ctx.autoMacrosPath, macros);
            return { kind: "local", output: `ok removed ${name}` };
        }
        if (sub === "show" || sub.startsWith("@")) {
            const name = normalizeAutoMacroName(sub === "show" ? rest[1] ?? "" : rest[0] ?? "");
            if (!name)
                return err("uso: auto show @macro");
            if (!macros[name])
                return err(`auto: macro nao encontrada: ${name}`);
            return { kind: "local", output: formatAutoList([name], macros) };
        }
        return listCodes(rest);
    }
    if (cmd === "add") {
        const { kind: kindFlag, rest: restArgs } = parseKindFlags(rest);
        const kind = kindFlag ?? ctx.watchKind;
        if (!kind)
            return err("uso: add -i NOME | add -e NOME");
        if (kind === "indicator") {
            const { params, rest: rest2, meta } = parseParamsAndMeta(restArgs);
            const { sub: subw, rest: rest3 } = parseSub(rest2, ctx);
            const r = parseSymTfFlexible(rest3, ctx);
            if (!params && hasImplicitParams(r.rest)) {
                return err(PARAMS_HINT);
            }
            let name = r.rest.join(" ").trim();
            if (!name && ctx.watchKind === "indicator")
                name = ctx.watchName ?? "";
            if (!name)
                return err("uso: add -i NOME [SYMBOL TF] [sub=N] [--params k=v ...]");
            name = maybeResolveLocalPath(name);
            const payload = [r.sym, r.tf, name, subw];
            if (params)
                payload.push(params);
            return {
                kind: "send",
                type: "ATTACH_IND_FULL",
                params: payload,
                attach: { kind: "indicator", name, symbol: r.sym, tf: r.tf, sub: Number(subw) },
                meta
            };
        }
        const { params, rest: rest2, meta } = parseParamsAndMeta(restArgs);
        const nameTokens = [...rest2];
        const tplIdx = nameTokens.findIndex((t) => t.toLowerCase().endsWith(".tpl"));
        let baseTpl = "";
        if (tplIdx >= 0) {
            baseTpl = nameTokens[tplIdx];
            nameTokens.splice(tplIdx, 1);
        }
        const r = parseSymTfFlexible(nameTokens, ctx);
        let name = r.rest.join(" ").trim();
        if (!name && ctx.watchKind === "expert")
            name = ctx.watchName ?? "";
        if (!name)
            return err("uso: add -e NOME [SYMBOL TF] [BASE_TPL] [--params k=v ...]");
        if (!baseTpl && ctx.baseTpl)
            baseTpl = ctx.baseTpl;
        if (!baseTpl)
            return err("base template nao definido. Use --base-tpl ou baseTpl no config.");
        const hash = stableHash(`${name}|${r.sym}|${r.tf}|${params}`);
        const outTpl = `cmdmt_ea_${hash}.tpl`;
        const saveParams = [name, outTpl, baseTpl];
        if (params)
            saveParams.push(params);
        const steps = [
            { type: "SAVE_TPL_EA", params: saveParams },
            { type: "APPLY_TPL", params: [r.sym, r.tf, outTpl] }
        ];
        return {
            kind: "multi",
            steps,
            attach: { kind: "expert", name, symbol: r.sym, tf: r.tf },
            meta
        };
    }
    if (cmd === "rm") {
        const { kind: kindFlag, rest: restArgs } = parseKindFlags(rest);
        const kind = kindFlag ?? ctx.watchKind;
        if (!kind)
            return err("uso: rm -i NOME|INDEX | rm -e [SYMBOL TF]");
        if (kind === "indicator") {
            const r = parseSymTfDefault(restArgs, ctx);
            const hasExplicitSub = r.rest.some((t) => {
                const low = t.toLowerCase();
                if (low.startsWith("sub="))
                    return true;
                if ((t.startsWith("#") || t.startsWith("@")) && /^\d+$/.test(t.slice(1)))
                    return true;
                return false;
            });
            const subParsed = hasExplicitSub ? parseSub(r.rest, ctx) : { sub: String(ctx.sub ?? 1), rest: r.rest };
            const { sub: subw, rest: rest2 } = subParsed;
            let name = rest2.join(" ").trim();
            if (!name && ctx.watchKind === "indicator")
                name = ctx.watchName ?? "";
            if (!name)
                return err("uso: rm -i NOME|INDEX [SYMBOL TF] [sub=N]");
            if (/^\d+$/.test(name)) {
                return { kind: "ind_detach_index", sym: r.sym, tf: r.tf, sub: subw, index: parseInt(name, 10) };
            }
            return { kind: "send", type: "DETACH_IND_FULL", params: [r.sym, r.tf, name, subw] };
        }
        const r = resolveSymTf(restArgs, ctx, false);
        if (!r || !r.sym || !r.tf)
            return err("uso: rm -e [SYMBOL TF]");
        return { kind: "send", type: "DETACH_EA_FULL", params: [r.sym, r.tf] };
    }
    if (cmd === "inspect") {
        const { kind: kindFlag, rest: restArgs } = parseKindFlags(rest);
        const kind = kindFlag ?? ctx.watchKind;
        if (!kind)
            return err("uso: inspect -i <total|name|handle|get|release> ... | inspect -e [find] NOME");
        if (kind === "expert") {
            const sub = restArgs[0]?.toLowerCase() ?? "";
            const name = (sub === "find" ? restArgs.slice(1) : restArgs).join(" ").trim() || (ctx.watchKind === "expert" ? ctx.watchName ?? "" : "");
            if (!name)
                return err("uso: inspect -e [find] NOME");
            return { kind: "send", type: "FIND_EA", params: [name] };
        }
        const subRaw = restArgs[0]?.toLowerCase() ?? "";
        const known = ["total", "name", "handle", "get", "release"];
        const sub = known.includes(subRaw) ? subRaw : "get";
        const args = known.includes(subRaw) ? restArgs.slice(1) : restArgs;
        if (sub === "release") {
            if (!args.length)
                return err("uso: inspect -i release HANDLE");
            return { kind: "send", type: "IND_RELEASE", params: [args[0]] };
        }
        if (sub === "total") {
            const r = parseSymTfDefault(args, ctx);
            const { sub: subw, rest: rest2 } = parseSub(r.rest, ctx);
            if (rest2.length) {
                return { kind: "send", type: "IND_TOTAL", params: [r.sym, r.tf, rest2[0]] };
            }
            return { kind: "send", type: "IND_TOTAL", params: [r.sym, r.tf, subw] };
        }
        const r = parseSymTfDefault(args, ctx);
        const { sub: subw, rest: rest2 } = parseSub(r.rest, ctx);
        let name = rest2.join(" ").trim();
        if (!name && ctx.watchKind === "indicator")
            name = ctx.watchName ?? "";
        if (!name)
            return err(`uso: inspect -i ${sub} [SYMBOL TF] NAME|INDEX [sub=N]`);
        const type = sub === "name" ? "IND_NAME" : sub === "handle" ? "IND_HANDLE" : "IND_GET";
        return { kind: "send", type, params: [r.sym, r.tf, subw, name] };
    }
    if (cmd === "debug") {
        const { kind, rest: restArgs } = parseKindFlags(rest);
        if (kind) {
            let name = restArgs.join(" ").trim();
            if (!name && ctx.watchKind === kind)
                name = ctx.watchName ?? "";
            if (!name)
                return err("uso: debug -i NOME | debug -e NOME");
            return { kind: "diag", target: kind, name };
        }
        if (!rest.length)
            return err("uso: debug MSG | debug -i NOME | debug -e NOME");
        return { kind: "send", type: "DEBUG_MSG", params: [rest.join(" ")] };
    }
    if (cmd === "log") {
        let tail = 200;
        const idx = rest.findIndex((t) => t.startsWith("--tail"));
        if (idx >= 0) {
            const tok = rest[idx];
            const val = tok.includes("=") ? tok.split("=")[1] : rest[idx + 1];
            const num = parseInt(val ?? "", 10);
            if (Number.isFinite(num))
                tail = num;
        }
        else if (rest.length && /^\d+$/.test(rest[0])) {
            tail = parseInt(rest[0], 10);
        }
        return { kind: "log", tail };
    }
    if (cmd === "hotkey") {
        const sub = rest[0]?.toLowerCase() ?? "list";
        if (sub === "list")
            return { kind: "hotkey", action: "list" };
        if (sub === "clear")
            return { kind: "hotkey", action: "clear" };
        if (sub === "set") {
            const args = rest.slice(1);
            if (!args.length)
                return err("uso: hotkey set TECLA COMANDO");
            let key = "";
            let value = "";
            if (args[0].includes("=")) {
                const idx = args[0].indexOf("=");
                key = args[0].slice(0, idx);
                value = args[0].slice(idx + 1);
                if (!value && args.length > 1)
                    value = args.slice(1).join(" ");
            }
            else {
                key = args[0];
                value = args.slice(1).join(" ");
            }
            if (!key || !value)
                return err("uso: hotkey set TECLA COMANDO");
            return { kind: "hotkey", action: "set", key, value };
        }
        if (sub === "del") {
            const key = rest.slice(1).join(" ").trim();
            if (!key)
                return err("uso: hotkey del TECLA");
            return { kind: "hotkey", action: "del", key };
        }
        return err("uso: hotkey <list|set|del|clear>");
    }
    if (cmd === "quit") {
        return { kind: "exit" };
    }
    if (cmd === "config" || cmd === "cfg" || cmd === "settings") {
        const sub = rest[0]?.toLowerCase() ?? "";
        if (!sub)
            return { kind: "config_ui", target: "menu" };
        if (sub === "auth")
            return { kind: "config_ui", target: "auth" };
        if (sub === "tester")
            return { kind: "config_ui", target: "tester" };
        if (sub === "common" || sub === "common.ini" || sub === "ini")
            return { kind: "config_ui", target: "common" };
        return err("uso: config [auth|tester|common]");
    }
    if (cmd === "workspace" || cmd === "workspaces") {
        const sub = rest[0]?.toLowerCase() ?? "list";
        const args = rest.slice(1);
        if (sub === "list" || sub === "ls") {
            return { kind: "workspace", action: "list" };
        }
        if (sub === "info" || sub === "show") {
            const name = args[0];
            if (!name)
                return err("uso: workspace info <NOME>");
            return { kind: "workspace", action: "info", name };
        }
        if (sub === "create" || sub === "new" || sub === "add") {
            const name = args[0];
            if (!name)
                return err("uso: workspace create <NOME>");
            return { kind: "workspace", action: "create", name };
        }
        if (sub === "use" || sub === "switch") {
            if (args.some((t) => t === "--runner" || t.startsWith("--runner=") || t === "--test-runner" || t.startsWith("--test-runner="))) {
                return err("uso: workspace use <NOME>");
            }
            const name = args[0];
            if (!name)
                return err("uso: workspace use <NOME>");
            return { kind: "workspace", action: "use", name };
        }
        if (sub === "current") {
            return { kind: "workspace", action: "current" };
        }
        if (sub === "links" || sub === "link" || sub === "ln") {
            const name = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
            return { kind: "workspace", action: "links", name };
        }
        if (sub === "remove" || sub === "rm" || sub === "del" || sub === "forget") {
            const name = args[0];
            if (!name)
                return err("uso: workspace remove <NOME>");
            return { kind: "workspace", action: "remove", name };
        }
        return err("uso: workspace <list|current|use|create|info|links|remove>");
    }
    if (cmd === "auth") {
        const sub = rest[0]?.toLowerCase() ?? "show";
        const args = rest.slice(1);
        if (sub === "show")
            return { kind: "auth", action: "show" };
        if (sub === "set") {
            let login = "";
            let password = "";
            let server = "";
            const positional = [];
            for (let i = 0; i < args.length; i++) {
                const tok = args[i];
                const low = tok.toLowerCase();
                if (low.startsWith("--login=")) {
                    login = tok.slice(tok.indexOf("=") + 1).trim();
                    continue;
                }
                if (low === "--login") {
                    const next = args[i + 1];
                    if (next && !next.startsWith("--")) {
                        login = next.trim();
                        i += 1;
                    }
                    continue;
                }
                if (low.startsWith("--password=")) {
                    password = tok.slice(tok.indexOf("=") + 1);
                    continue;
                }
                if (low === "--password") {
                    const next = args[i + 1];
                    if (next && !next.startsWith("--")) {
                        password = next;
                        i += 1;
                    }
                    continue;
                }
                if (low.startsWith("--server=")) {
                    server = tok.slice(tok.indexOf("=") + 1).trim();
                    continue;
                }
                if (low === "--server") {
                    const next = args[i + 1];
                    if (next && !next.startsWith("--")) {
                        server = next.trim();
                        i += 1;
                    }
                    continue;
                }
                positional.push(tok);
            }
            if (!login && positional.length)
                login = positional.shift() ?? "";
            if (!password && positional.length)
                password = positional.shift() ?? "";
            if (!server && positional.length)
                server = positional.join(" ").trim();
            if (!login || !password || !server) {
                return err("uso: auth set LOGIN PASSWORD SERVER | auth set --login LOGIN --password PASSWORD --server SERVER");
            }
            return { kind: "auth", action: "set", login, password, server };
        }
        return err("uso: auth <show|set>");
    }
    if (cmd === "addons" || cmd === "addon") {
        const parseAddonsArgs = (tokens) => {
            let mode = "merge";
            const sourceTokens = [];
            for (let i = 0; i < tokens.length; i++) {
                const tok = tokens[i];
                const low = tok.toLowerCase();
                if (low === "--mode") {
                    const next = tokens[i + 1];
                    if (!next)
                        return { error: "uso: --mode <merge|sync>" };
                    const val = next.toLowerCase();
                    if (val !== "merge" && val !== "sync")
                        return { error: "addons: --mode invalido (use merge|sync)" };
                    mode = val;
                    i += 1;
                    continue;
                }
                if (low.startsWith("--mode=")) {
                    const val = low.slice("--mode=".length);
                    if (val !== "merge" && val !== "sync")
                        return { error: "addons: --mode invalido (use merge|sync)" };
                    mode = val;
                    continue;
                }
                sourceTokens.push(tok);
            }
            return { mode, source: sourceTokens.join(" ").trim() };
        };
        const sub = rest[0]?.toLowerCase() ?? "init";
        if (sub === "init")
            return { kind: "addons", action: "init" };
        if (sub === "add") {
            const parsed = parseAddonsArgs(rest.slice(1));
            if (parsed.error)
                return err(parsed.error);
            const source = parsed.source;
            if (!source)
                return err("uso: addons add <diretorio_pack>");
            return { kind: "addons", action: "add", source, mode: parsed.mode };
        }
        if (sub === "expert" || sub === "indicator" || sub === "library") {
            const parsed = parseAddonsArgs(rest.slice(1));
            if (parsed.error)
                return err(parsed.error);
            const source = parsed.source;
            if (!source)
                return err("uso: addons <expert|indicator|library> <caminho_windows_ou_wsl>");
            return {
                kind: "addons",
                action: sub,
                source,
                mode: parsed.mode
            };
        }
        return err("uso: addons <init|add|expert|indicator|library> [--mode merge|sync] [caminho]");
    }
    if (cmd === "container" || cmd === "docker") {
        return err("comando removido do cmdmt. Use somente o dockermt oficial (container).");
    }
    if (cmd === "install") {
        const sub = rest[0]?.toLowerCase();
        if (sub === "list" || sub === "ls") {
            return { kind: "install_list" };
        }
        if (sub === "help" || sub === "--help" || sub === "-h") {
            return { kind: "local", output: renderExamples("install") };
        }
        const parsed = parseInstallArgs(rest);
        if (!parsed) {
            return err("uso: install [mt5|mt5ide|telnet|pyplot|all] [--auto] [--all] [--activate|--no-activate] [--name NOME] [--name-prefix PREFIX] [--allow-dll|--no-allow-dll] [--allow-live|--no-allow-live] [--sync-common|--no-sync-common] [--web URL] [--dry-run] [--repo PATH]");
        }
        return { kind: "install", ...parsed };
    }
    if (cmd === "doctor") {
        const parsed = parseDoctorArgs(rest);
        if (!parsed) {
            return err("uso: doctor [--apply|--dry-run] [--name NOME] [--name-prefix PREFIX] [--allow-dll|--no-allow-dll] [--allow-live|--no-allow-live] [--sync-common|--no-sync-common] [--web URL] [--repo PATH]");
        }
        return { kind: "doctor", ...parsed };
    }
    if (cmd === "use") {
        if (rest.length < 2 || !isTf(rest[1]))
            return err("uso: use SYMBOL TF");
        ctx.symbol = rest[0];
        ctx.tf = rest[1];
        return { kind: "local", output: `context: ${ctx.symbol} ${ctx.tf}` };
    }
    if (cmd === "ctx") {
        return {
            kind: "local",
            output: `context: ${ctx.symbol ?? "(none)"} ${ctx.tf ?? ""}`.trim()
        };
    }
    if (cmd === "ping")
        return { kind: "send", type: "PING", params: [] };
    if (cmd === "open") {
        const r = parseSymTfDefault(rest, ctx);
        return { kind: "send", type: "OPEN_CHART", params: [r.sym, r.tf] };
    }
    if (cmd === "run" || cmd === "test" || cmd === "oneshot") {
        return dispatch(["expert", cmd, ...rest], ctx);
    }
    if (cmd === "tester") {
        if (rest.length === 0)
            return err("uso: tester <run|test|oneshot> [args...]");
        const sub = rest[0].toLowerCase();
        if (sub === "run" || sub === "test" || sub === "oneshot") {
            return dispatch(["expert", sub, ...rest.slice(1)], ctx);
        }
        // Sem subcomando: assume "test"
        return dispatch(["expert", "test", ...rest], ctx);
    }
    if (cmd === "chart") {
        if (rest.length === 0)
            return err("uso: chart <open|close|list|closeall|redraw|detachall|find>");
        const sub = rest[0].toLowerCase();
        const args = rest.slice(1);
        if (sub === "list")
            return { kind: "send", type: "LIST_CHARTS", params: [] };
        if (sub === "closeall")
            return { kind: "send", type: "CLOSE_ALL", params: [] };
        if (sub === "open") {
            const r = parseSymTfDefault(args, ctx);
            return { kind: "send", type: "OPEN_CHART", params: [r.sym, r.tf] };
        }
        if (sub === "close") {
            const r = parseSymTfDefault(args, ctx);
            return { kind: "send", type: "CLOSE_CHART", params: [r.sym, r.tf] };
        }
        if (sub === "redraw") {
            const r = parseSymTfDefault(args, ctx);
            return { kind: "send", type: "REDRAW_CHART", params: [r.sym, r.tf] };
        }
        if (sub === "detachall") {
            const r = parseSymTfDefault(args, ctx);
            return { kind: "send", type: "DETACH_ALL", params: [r.sym, r.tf] };
        }
        if (sub === "find") {
            const r = parseSymTfDefault(args, ctx);
            if (r.rest.length < 1)
                return err("uso: chart find [SYMBOL TF] NAME");
            return { kind: "send", type: "WINDOW_FIND", params: [r.sym, r.tf, r.rest.join(" ")] };
        }
    }
    if (cmd === "template") {
        if (rest.length === 0)
            return err("uso: template <apply|save|saveea|savechart>");
        const sub = rest[0].toLowerCase();
        const args = rest.slice(1);
        if (sub === "apply") {
            const r = parseSymTfDefault(args, ctx);
            if (r.rest.length < 1)
                return err("uso: template apply [SYMBOL TF] TEMPLATE");
            return { kind: "send", type: "APPLY_TPL", params: [r.sym, r.tf, r.rest.join(" ")] };
        }
        if (sub === "save") {
            const r = parseSymTfDefault(args, ctx);
            if (r.rest.length < 1)
                return err("uso: template save [SYMBOL TF] TEMPLATE");
            return { kind: "send", type: "SAVE_TPL", params: [r.sym, r.tf, r.rest.join(" ")] };
        }
        if (sub === "savechart") {
            if (args.length < 2)
                return err("uso: template savechart CHART_ID NAME");
            return { kind: "send", type: "CHART_SAVE_TPL", params: [args[0], args[1]] };
        }
        if (sub === "saveea") {
            if (args.length < 2)
                return err("uso: template saveea EA OUT_TPL [BASE_TPL] [k=v;...]");
            const expert = args[0];
            const outTpl = args[1];
            const baseTpl = args.length >= 3 ? args[2] : "";
            const extra = args.length >= 4 ? args.slice(3).join(";") : "";
            const params = [expert, outTpl];
            if (baseTpl)
                params.push(baseTpl);
            if (extra)
                params.push(extra);
            return { kind: "send", type: "SAVE_TPL_EA", params };
        }
    }
    if (cmd === "expert") {
        if (rest.length === 0)
            return err("uso: expert <find|run|test|oneshot>");
        const sub = rest[0].toLowerCase();
        const args = rest.slice(1);
        if (sub === "find") {
            if (!args.length)
                return err("uso: expert find NAME");
            return { kind: "send", type: "FIND_EA", params: [args.join(" ")] };
        }
        if (sub === "run") {
            let symbol = ctx.symbol?.trim() || DEFAULT_SYMBOL;
            let tf = ctx.tf?.trim() || DEFAULT_TF;
            let restArgs = [...args];
            const yesRes = extractYesFlag(restArgs);
            restArgs = yesRes.rest;
            if (restArgs.length >= 2 && isTf(restArgs[1])) {
                symbol = restArgs[0];
                tf = restArgs[1];
                restArgs = restArgs.slice(2);
            }
            else if (restArgs.length >= 1 && isTf(restArgs[0])) {
                tf = restArgs[0];
                restArgs = restArgs.slice(1);
            }
            let baseTpl = requireBaseTpl(ctx) ?? "";
            const tplIdx = restArgs.findIndex((t) => t.toLowerCase().endsWith(".tpl"));
            if (tplIdx >= 0) {
                baseTpl = restArgs[tplIdx];
                restArgs.splice(tplIdx, 1);
            }
            const { csv, rest: restCsv } = parseCsvFlags(restArgs);
            const { params, rest: rest2 } = parseParamsAndMeta(restCsv);
            if (!params && hasImplicitParams(rest2)) {
                return err(PARAMS_HINT);
            }
            const name = rest2.join(" ");
            if (!name)
                return err("uso: expert run [TF] NOME [BASE_TPL] [--params k=v ...]");
            if (csv) {
                if (!csv.csv)
                    return err("uso: --csv-rates/--csv-ticks exige caminho do CSV");
                if (!csv.symbol)
                    csv.symbol = symbol;
                if (csv.mode === "rates" && !csv.tf)
                    csv.tf = tf;
            }
            const spec = { expert: name, symbol, tf, params, oneShot: true, baseTpl, csv, assumeYes: yesRes.yes };
            return { kind: "test", spec };
        }
        if (sub === "test") {
            let symbol = ctx.symbol?.trim() || DEFAULT_SYMBOL;
            let tf = ctx.tf?.trim() || DEFAULT_TF;
            let restArgs = [...args];
            const yesRes = extractYesFlag(restArgs);
            restArgs = yesRes.rest;
            if (restArgs.length >= 2 && isTf(restArgs[1])) {
                symbol = restArgs[0];
                tf = restArgs[1];
                restArgs = restArgs.slice(2);
            }
            else if (restArgs.length >= 1 && isTf(restArgs[0])) {
                tf = restArgs[0];
                restArgs = restArgs.slice(1);
            }
            const { csv, rest: restCsv } = parseCsvFlags(restArgs);
            const { params, rest: rest2 } = parseParamsAndMeta(restCsv);
            if (!params && hasImplicitParams(rest2)) {
                return err(PARAMS_HINT);
            }
            const name = rest2.join(" ");
            if (!name)
                return err("uso: expert test [TF] NOME [--params k=v ...]");
            if (csv) {
                if (!csv.csv)
                    return err("uso: --csv-rates/--csv-ticks exige caminho do CSV");
                if (!csv.symbol)
                    csv.symbol = symbol;
                if (csv.mode === "rates" && !csv.tf)
                    csv.tf = tf;
            }
            const spec = { expert: name, symbol, tf, params, csv, assumeYes: yesRes.yes };
            return { kind: "test", spec };
        }
        if (sub === "oneshot") {
            const symbol = ctx.symbol?.trim() || DEFAULT_SYMBOL;
            if (args.length < 2 || !isTf(args[0]))
                return err("uso: expert oneshot TF NOME [BASE_TPL] [--params k=v ...]");
            const tf = args[0];
            let restArgs = args.slice(1);
            const yesRes = extractYesFlag(restArgs);
            restArgs = yesRes.rest;
            let baseTpl = requireBaseTpl(ctx) ?? "";
            const tplIdx = restArgs.findIndex((t) => t.toLowerCase().endsWith(".tpl"));
            if (tplIdx >= 0) {
                baseTpl = restArgs[tplIdx];
                restArgs.splice(tplIdx, 1);
            }
            const { csv, rest: restCsv } = parseCsvFlags(restArgs);
            const { params, rest: rest2 } = parseParamsAndMeta(restCsv);
            if (!params && hasImplicitParams(rest2)) {
                return err(PARAMS_HINT);
            }
            const name = rest2.join(" ");
            if (!name)
                return err("uso: expert oneshot TF NOME [BASE_TPL] [--params k=v ...]");
            if (csv) {
                if (!csv.csv)
                    return err("uso: --csv-rates/--csv-ticks exige caminho do CSV");
                if (!csv.symbol)
                    csv.symbol = symbol;
                if (csv.mode === "rates" && !csv.tf)
                    csv.tf = tf;
            }
            const spec = { expert: name, symbol, tf, params, oneShot: true, baseTpl, csv, assumeYes: yesRes.yes };
            return { kind: "test", spec };
        }
        return err("uso: expert <find|run|test|oneshot>");
    }
    if (cmd === "script") {
        if (rest.length === 0)
            return err("uso: script run SYMBOL TF TEMPLATE");
        const sub = rest[0].toLowerCase();
        const args = rest.slice(1);
        if (sub === "run") {
            const r = resolveSymTf(args, ctx, false);
            if (!r || !r.sym || !r.tf || r.rest.length < 1)
                return err("uso: script run [SYMBOL TF] TEMPLATE");
            return { kind: "send", type: "RUN_SCRIPT", params: [r.sym, r.tf, r.rest.join(" ")] };
        }
    }
    if (cmd === "data") {
        if (rest.length === 0)
            return err("uso: data import <rates|ticks> CSV SYMBOL [TF] [--base SYM] [--digits N] [--spread N] [--tz H] [--sep auto|tab|comma|semicolon] [--common] [--recreate|--no-recreate]");
        const sub = rest[0].toLowerCase();
        const args = rest.slice(1);
        if (sub === "import") {
            if (args.length < 3)
                return err("uso: data import <rates|ticks> CSV SYMBOL [TF] [--base SYM] [--digits N] [--spread N] [--tz H] [--sep auto|tab|comma|semicolon] [--common] [--recreate|--no-recreate]");
            const mode = args[0].toLowerCase();
            if (mode !== "rates" && mode !== "ticks")
                return err("modo invalido. use rates ou ticks");
            let i = 1;
            const csv = args[i++] ?? "";
            const symbol = args[i++] ?? "";
            if (!csv || !symbol)
                return err("uso: data import <rates|ticks> CSV SYMBOL [TF] ...");
            let tf = "";
            if (mode === "rates" && i < args.length && isTf(args[i])) {
                tf = args[i];
                i++;
            }
            let base;
            let digits;
            let spread;
            let tz;
            let sep;
            let recreate = true;
            let common = false;
            for (; i < args.length; i++) {
                const tok = args[i];
                const lower = tok.toLowerCase();
                if (lower === "--common") {
                    common = true;
                    continue;
                }
                if (lower === "--no-common") {
                    common = false;
                    continue;
                }
                if (lower === "--recreate") {
                    recreate = true;
                    continue;
                }
                if (lower === "--no-recreate") {
                    recreate = false;
                    continue;
                }
                const eq = tok.indexOf("=");
                const key = (eq >= 0 ? tok.slice(0, eq) : tok).toLowerCase();
                let val = eq >= 0 ? tok.slice(eq + 1) : "";
                if (!val && i + 1 < args.length && !args[i + 1].startsWith("--")) {
                    val = args[i + 1];
                    i++;
                }
                if (key === "--base")
                    base = val;
                else if (key === "--digits")
                    digits = parseInt(val, 10);
                else if (key === "--spread")
                    spread = parseInt(val, 10);
                else if (key === "--tz")
                    tz = parseInt(val, 10);
                else if (key === "--sep")
                    sep = val;
            }
            return {
                kind: "data_import",
                mode: mode,
                csv,
                symbol,
                tf: tf || undefined,
                base,
                digits: Number.isFinite(digits) ? digits : undefined,
                spread: Number.isFinite(spread) ? spread : undefined,
                tz: Number.isFinite(tz) ? tz : undefined,
                sep,
                recreate,
                common
            };
        }
    }
    if (cmd === "trade") {
        if (rest.length === 0)
            return err("uso: trade <buy|sell|list|closeall>");
        const sub = rest[0].toLowerCase();
        const args = rest.slice(1);
        if (sub === "list")
            return { kind: "send", type: "TRADE_LIST", params: [] };
        if (sub === "closeall")
            return { kind: "send", type: "TRADE_CLOSE_ALL", params: [] };
        if (sub === "buy" || sub === "sell") {
            let payload = [...args];
            if (payload.length >= 2) {
                const type = sub === "buy" ? "TRADE_BUY" : "TRADE_SELL";
                return { kind: "send", type, params: payload };
            }
            if (payload.length === 1 && ctx.symbol) {
                payload = [ctx.symbol, payload[0]];
                const type = sub === "buy" ? "TRADE_BUY" : "TRADE_SELL";
                return { kind: "send", type, params: payload };
            }
            return err(`uso: trade ${sub} [SYMBOL] LOTS [sl] [tp]`);
        }
    }
    if (cmd === "global") {
        if (rest.length === 0)
            return err("uso: global <set|get|del|delprefix|list>");
        const sub = rest[0].toLowerCase();
        const args = rest.slice(1);
        if (sub === "set")
            return { kind: "send", type: "GLOBAL_SET", params: args };
        if (sub === "get")
            return { kind: "send", type: "GLOBAL_GET", params: args };
        if (sub === "del")
            return { kind: "send", type: "GLOBAL_DEL", params: args };
        if (sub === "delprefix")
            return { kind: "send", type: "GLOBAL_DEL_PREFIX", params: args };
        if (sub === "list")
            return { kind: "send", type: "GLOBAL_LIST", params: args };
    }
    if (cmd === "input") {
        if (rest.length === 0)
            return err("uso: input <list|set>");
        const sub = rest[0].toLowerCase();
        const args = rest.slice(1);
        if (sub === "list")
            return { kind: "send", type: "LIST_INPUTS", params: [] };
        if (sub === "set")
            return { kind: "send", type: "SET_INPUT", params: args };
    }
    if (cmd === "snapshot") {
        if (rest.length === 0)
            return err("uso: snapshot <save|apply|list>");
        const sub = rest[0].toLowerCase();
        const args = rest.slice(1);
        if (sub === "save")
            return { kind: "send", type: "SNAPSHOT_SAVE", params: args };
        if (sub === "apply")
            return { kind: "send", type: "SNAPSHOT_APPLY", params: args };
        if (sub === "list")
            return { kind: "send", type: "SNAPSHOT_LIST", params: [] };
    }
    if (cmd === "object") {
        if (rest.length === 0)
            return err("uso: object <list|delete|delprefix|move|create>");
        const sub = rest[0].toLowerCase();
        const args = rest.slice(1);
        if (sub === "list")
            return { kind: "send", type: "OBJ_LIST", params: args };
        if (sub === "delete")
            return { kind: "send", type: "OBJ_DELETE", params: args };
        if (sub === "delprefix")
            return { kind: "send", type: "OBJ_DELETE_PREFIX", params: args };
        if (sub === "move")
            return { kind: "send", type: "OBJ_MOVE", params: args };
        if (sub === "create")
            return { kind: "send", type: "OBJ_CREATE", params: args };
    }
    if (cmd === "screen") {
        if (rest.length === 0)
            return err("uso: screen <shot|sweep|drop>");
        const sub = rest[0].toLowerCase();
        const args = rest.slice(1);
        if (sub === "shot")
            return { kind: "send", type: "SCREENSHOT", params: args };
        if (sub === "sweep")
            return { kind: "send", type: "SCREENSHOT_SWEEP", params: args };
        if (sub === "drop")
            return { kind: "send", type: "DROP_INFO", params: args };
    }
    if (cmd === "cmd") {
        if (rest.length < 1)
            return err("uso: cmd TYPE [PARAMS...] ");
        const type = rest[0].toUpperCase();
        return { kind: "send", type, params: rest.slice(1) };
    }
    if (cmd === "raw") {
        if (rest.length < 1)
            return err("uso: raw <linha>");
        return { kind: "send", type: "RAW", params: [rest.join(" ")] };
    }
    if (cmd === "json") {
        if (rest.length < 1)
            return err("uso: json <json>");
        return { kind: "send", type: "JSON", params: [rest.join(" ")] };
    }
    return err(`comando desconhecido: ${cmd}`);
}
