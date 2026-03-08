import fs from "node:fs";
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { splitArgs } from "./lib/args.js";
import { dispatch } from "./lib/dispatch.js";
import { sendLine, sendJson } from "./lib/transport.js";
import { requireRunner } from "./lib/config.js";
import { buildAttachReport, formatAttachReport, DEFAULT_ATTACH_META, findLatestLogFile } from "./lib/attach_report.js";
import { renderBanner } from "./lib/banner.js";
async function executeSend(action, opts) {
    if (action.type === "RAW") {
        const line = action.params[0] ?? "";
        return sendLine(line, opts);
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
        return sendJson(obj, opts);
    }
    const id = Date.now().toString();
    const line = [id, action.type, ...action.params].join("|");
    return sendLine(line, opts);
}
function isErrorResponse(resp) {
    const up = resp.trim().toUpperCase();
    return up.startsWith("ERR") || up.includes(" ERR ") || up.includes("CODE=");
}
async function pingTransport(opts) {
    try {
        const resp = await executeSend({ type: "PING", params: [] }, opts);
        return !isErrorResponse(resp);
    }
    catch {
        return false;
    }
}
async function ensureRuntimeReachable(opts, resolved) {
    void resolved;
    if (await pingTransport(opts))
        return;
    throw new Error("servico TelnetMT indisponivel no runner local.");
}
async function handleCommand(tokens, ctx, opts, resolved, confirmIni, confirmUserOps) {
    const cmd0 = (tokens[0] ?? "").toLowerCase();
    // O REPL historicamente não roteava "compile" pelo mesmo fluxo do modo direto.
    // Reaproveitamos o parser principal para manter comportamento idêntico.
    if (cmd0 === "compile") {
        const p = spawnSync(process.execPath, ["/opt/dockermt-full/dist/index.js", "--quiet", ...tokens], {
            env: process.env,
            encoding: "utf8"
        });
        if (p.stdout)
            process.stdout.write(p.stdout);
        if (p.stderr)
            process.stderr.write(p.stderr);
        return;
    }
    const isDockerBrand = ((process.env.CMDMT_BRAND || "").trim().toLowerCase() === "dockermt");
    const res = dispatch(tokens, ctx);
    if (res.kind === "local") {
        if (res.output)
            process.stdout.write(res.output + "\n");
        return;
    }
    if (res.kind === "error") {
        process.stderr.write(res.message + "\n");
        return;
    }
    if (res.kind === "exit") {
        throw new Error("__EXIT__");
    }
    if (res.kind === "test" && !isDockerBrand) {
        process.stderr.write("comando test no cmdmt foi desativado. Use o dockermt para tester/container.\n");
        return;
    }
    if (res.kind === "send") {
        await ensureRuntimeReachable(opts, resolved);
        let logStart = null;
        if (res.attach) {
            try {
                const runner = requireRunner(resolved);
                const logFile = findLatestLogFile(runner.dataPath);
                if (logFile && fs.existsSync(logFile)) {
                    const stat = fs.statSync(logFile);
                    logStart = { file: logFile, offset: stat.size };
                }
            }
            catch {
                // ignore
            }
        }
        const resp = await executeSend({ type: res.type, params: res.params }, opts);
        process.stdout.write(resp);
        const attachMeta = res.meta ?? DEFAULT_ATTACH_META;
        if (!isErrorResponse(resp) && res.attach && attachMeta.report) {
            try {
                const runner = requireRunner(resolved);
                const report = await buildAttachReport({
                    kind: res.attach.kind,
                    name: res.attach.name,
                    symbol: res.attach.symbol,
                    tf: res.attach.tf,
                    sub: res.attach.sub,
                    meta: attachMeta,
                    runner,
                    send: (action) => executeSend(action, opts),
                    logStart: logStart ?? undefined
                });
                process.stdout.write(formatAttachReport(report) + "\n");
            }
            catch (err) {
                process.stderr.write(`WARN attach_report: ${String(err)}\n`);
            }
        }
        return;
    }
    if (res.kind === "multi") {
        await ensureRuntimeReachable(opts, resolved);
        let logStart = null;
        if (res.attach) {
            try {
                const runner = requireRunner(resolved);
                const logFile = findLatestLogFile(runner.dataPath);
                if (logFile && fs.existsSync(logFile)) {
                    const stat = fs.statSync(logFile);
                    logStart = { file: logFile, offset: stat.size };
                }
            }
            catch {
                // ignore
            }
        }
        let hadError = false;
        for (const step of res.steps) {
            const resp = await executeSend(step, opts);
            process.stdout.write(resp);
            if (isErrorResponse(resp)) {
                hadError = true;
                break;
            }
        }
        const attachMeta = res.meta ?? DEFAULT_ATTACH_META;
        if (!hadError && res.attach && attachMeta.report) {
            try {
                const runner = requireRunner(resolved);
                const report = await buildAttachReport({
                    kind: res.attach.kind,
                    name: res.attach.name,
                    symbol: res.attach.symbol,
                    tf: res.attach.tf,
                    sub: res.attach.sub,
                    meta: attachMeta,
                    runner,
                    send: (action) => executeSend(action, opts),
                    logStart: logStart ?? undefined
                });
                process.stdout.write(formatAttachReport(report) + "\n");
            }
            catch (err) {
                process.stderr.write(`WARN attach_report: ${String(err)}\n`);
            }
        }
        return;
    }
}
export async function runRepl(opts, ctx, resolved) {
    const isDockerBrand = ((process.env.CMDMT_BRAND || "").trim().toLowerCase() === "dockermt");
    if (!opts.quiet) {
        const hosts = opts.hosts.join(",");
        const defaultLabel = isDockerBrand ? "dockermt" : "cmdmt";
        const label = process.env.CMDMT_INVOKE_AS?.trim() || opts.bannerLabel || defaultLabel;
        process.stdout.write(renderBanner({
            label,
            owner: "Eduardo Candeiro Gonçalves",
            socket: `${hosts}:${opts.port}`,
            variant: opts.bannerVariant ?? "default"
        }));
        process.stdout.write("Dica: digite help\n");
    }
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true
    });
    const basePrompt = "mt> ";
    let confirmPending = null;
    const confirmWithPrompt = async (lines, promptText) => {
        for (const line of lines)
            process.stdout.write(line + "\n");
        return new Promise((resolve) => {
            confirmPending = {
                resolve: (val) => {
                    const v = val.trim().toLowerCase();
                    resolve(v === "y" || v === "yes" || v === "s" || v === "sim");
                }
            };
            rl.setPrompt(promptText);
            rl.prompt();
        });
    };
    const confirmIni = (lines) => confirmWithPrompt(lines, "Aplicar alteracoes em INI? (s/N) ");
    const confirmUserOps = (ops) => {
        const lines = ["Operacoes em arquivos locais:", ...ops.map((op) => `- ${op}`)];
        return confirmWithPrompt(lines, "Aplicar operacoes de arquivo? (s/N) ");
    };
    const prompt = () => rl.prompt();
    rl.setPrompt(basePrompt);
    prompt();
    rl.on("line", async (line) => {
        if (confirmPending) {
            const pending = confirmPending;
            confirmPending = null;
            rl.setPrompt(basePrompt);
            pending.resolve(line);
            return;
        }
        const trimmed = line.trim();
        if (!trimmed) {
            prompt();
            return;
        }
        try {
            const tokens = splitArgs(trimmed);
            await handleCommand(tokens, ctx, opts, resolved, confirmIni, confirmUserOps);
        }
        catch (err) {
            if (err instanceof Error && err.message === "__EXIT__") {
                rl.close();
                return;
            }
            process.stderr.write(String(err) + "\n");
        }
        prompt();
    });
    rl.on("close", () => process.stdout.write("\n"));
}
