import fs from "node:fs";
import path from "node:path";
import { isWindowsPath, toWslPath } from "./config.js";
export const DEFAULT_ATTACH_META = {
    report: true,
    buffers: 5,
    logTail: 30,
    shot: false
};
function readTextMaybeUtf16(p) {
    const raw = fs.readFileSync(p);
    if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
        return raw.slice(2).toString("utf16le");
    }
    return raw.toString("utf8");
}
function readTextFromOffset(p, offset) {
    const raw = fs.readFileSync(p);
    let start = Math.max(0, Math.min(offset, raw.length));
    if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
        if (start < 2)
            start = 2;
        if (start % 2 === 1)
            start -= 1;
        return raw.slice(start).toString("utf16le");
    }
    return raw.slice(start).toString("utf8");
}
function latestFileInfo(dir) {
    if (!fs.existsSync(dir))
        return null;
    const items = fs
        .readdirSync(dir)
        .map((name) => {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        return { file: full, stat };
    })
        .filter((e) => e.stat.isFile())
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (!items.length)
        return null;
    return { file: items[0].file, mtimeMs: items[0].stat.mtimeMs };
}
function pickLatest(infos) {
    const valid = infos.filter((i) => Boolean(i));
    if (!valid.length)
        return null;
    valid.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return valid[0].file;
}
function latestLogCandidates(dataPath) {
    if (!dataPath)
        return [];
    const base = isWindowsPath(dataPath) ? toWslPath(dataPath) : dataPath;
    const dirs = [
        path.join(base, "MQL5", "Logs"),
        path.join(base, "logs"),
        path.join(base, "Logs")
    ];
    const infos = dirs.map((d) => latestFileInfo(d)).filter((v) => Boolean(v));
    infos.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const seen = new Set();
    const out = [];
    for (const info of infos) {
        if (seen.has(info.file))
            continue;
        seen.add(info.file);
        out.push(info.file);
    }
    return out;
}
function tailMatchLines(file, needles, maxLines) {
    if (!file || !fs.existsSync(file))
        return [];
    const text = readTextMaybeUtf16(file);
    const lines = text.split(/\r?\n/).filter(Boolean);
    const lowers = needles.map((n) => n.toLowerCase()).filter(Boolean);
    const hits = lines.filter((l) => {
        const low = l.toLowerCase();
        return lowers.some((n) => low.includes(n));
    });
    if (!hits.length)
        return [];
    return hits.slice(-maxLines);
}
function tailLines(file, maxLines) {
    if (!file || !fs.existsSync(file))
        return [];
    const text = readTextMaybeUtf16(file);
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!lines.length)
        return [];
    return lines.slice(-maxLines);
}
export function findLatestLogFile(dataPath) {
    const files = latestLogCandidates(dataPath);
    return files.length ? files[0] : null;
}
function readLinesFromOffset(file, offset) {
    if (!file || !fs.existsSync(file))
        return [];
    const text = readTextFromOffset(file, offset);
    return text.split(/\r?\n/).filter(Boolean);
}
function parseKeyValueLines(resp) {
    const out = {};
    const lines = resp.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        if (line.startsWith("OK") || line.startsWith("ERR") || line.startsWith("ERROR"))
            continue;
        const idx = line.indexOf("=");
        if (idx <= 0)
            continue;
        out[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return out;
}
function parseBuffers(map) {
    const out = {};
    for (const [k, v] of Object.entries(map)) {
        if (!k.startsWith("buf"))
            continue;
        if (v === "ERR") {
            out[k] = [];
            continue;
        }
        out[k] = v
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean)
            .map((n) => Number(n));
    }
    return out;
}
function parseMtTime(value) {
    if (!value)
        return null;
    const m = value.match(/^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (!m)
        return null;
    const [_, yy, mo, dd, hh, mm, ss] = m;
    return Date.UTC(Number(yy), Number(mo) - 1, Number(dd), Number(hh), Number(mm), Number(ss));
}
function detectDiagnostics(map, buffers, meta) {
    const diags = [];
    const count = map.count ? Number(map.count) : null;
    const bars = map.bars ? Number(map.bars) : null;
    const time0 = parseMtTime(map.time0);
    const timeN = parseMtTime(map.timeN);
    if (count !== null && count <= 0) {
        diags.push("count=0 (sem dados retornados)");
    }
    if (count !== null && count < 2) {
        diags.push("count baixo (poucos dados, possivel falha de copy)");
    }
    if (bars !== null && count !== null && bars > 0 && count > bars) {
        diags.push("count maior que bars (inconsistente)");
    }
    if (time0 !== null && timeN !== null && time0 < timeN) {
        diags.push("time0 < timeN (series possivelmente invertida / nao time-series)");
    }
    if (time0 !== null && timeN !== null && time0 === timeN && count !== null && count > 1) {
        diags.push("time0 == timeN com count>1 (timestamps repetidos)");
    }
    const bufferKeys = Object.keys(buffers);
    const empty = bufferKeys.filter((k) => buffers[k].length === 0);
    if (empty.length) {
        diags.push(`buffers vazios: ${empty.join(", ")}`);
    }
    if (meta.buffers && bufferKeys.length < meta.buffers) {
        diags.push(`buffers retornados (${bufferKeys.length}) < solicitado (${meta.buffers})`);
    }
    return diags;
}
function normalizeIndicatorName(name) {
    let n = name.trim();
    if (n.toLowerCase().startsWith("wpath "))
        n = n.slice(6);
    n = n.replace(/^"+|"+$/g, "");
    n = n.replace(/\//g, "\\");
    const base = path.win32.basename(n);
    let out = base || n;
    const low = out.toLowerCase();
    if (low.endsWith(".mq5") || low.endsWith(".ex5"))
        out = out.slice(0, -4);
    return out || name;
}
export async function buildAttachReport(opts) {
    const report = {
        kind: opts.kind,
        name: opts.name,
        symbol: opts.symbol,
        tf: opts.tf,
        sub: opts.sub
    };
    if (opts.kind === "indicator") {
        const indName = normalizeIndicatorName(opts.name);
        const resp = await opts.send({
            type: "IND_SNAPSHOT",
            params: [opts.symbol, opts.tf, String(opts.sub ?? 1), indName, String(opts.meta.buffers)]
        });
        const map = parseKeyValueLines(resp);
        if (map.time0)
            report.time0 = map.time0;
        if (map.timeN)
            report.timeN = map.timeN;
        if (map.bars)
            report.bars = Number(map.bars);
        report.buffers = parseBuffers(map);
        report.diagnostics = detectDiagnostics(map, report.buffers, opts.meta);
    }
    else {
        const resp = await opts.send({
            type: "BAR_INFO",
            params: [opts.symbol, opts.tf, String(opts.meta.buffers)]
        });
        const map = parseKeyValueLines(resp);
        if (map.time0)
            report.time0 = map.time0;
        if (map.timeN)
            report.timeN = map.timeN;
        if (map.bars)
            report.bars = Number(map.bars);
    }
    const dataPath = opts.runner.dataPath ? (isWindowsPath(opts.runner.dataPath) ? toWslPath(opts.runner.dataPath) : opts.runner.dataPath) : "";
    if (dataPath) {
        const logFiles = latestLogCandidates(dataPath);
        let logFile = opts.logStart?.file ?? (logFiles.length ? logFiles[0] : null);
        const baseName = path.win32.basename(opts.name);
        let lines = [];
        let mode;
        if (logFile && opts.logStart && opts.logStart.file === logFile) {
            lines = readLinesFromOffset(logFile, opts.logStart.offset).slice(-opts.meta.logTail);
            mode = "tail";
        }
        else if (logFile) {
            lines = tailMatchLines(logFile, [opts.name, baseName], opts.meta.logTail);
            mode = lines.length ? "match" : undefined;
            if (lines.length === 0) {
                lines = tailLines(logFile, opts.meta.logTail);
                mode = "tail";
            }
        }
        if (logFile && lines.length === 0 && logFiles.length > 1) {
            for (const alt of logFiles) {
                if (alt === logFile)
                    continue;
                const altMatch = tailMatchLines(alt, [opts.name, baseName], opts.meta.logTail);
                if (altMatch.length) {
                    logFile = alt;
                    lines = altMatch;
                    mode = "match";
                    break;
                }
                const altTail = tailLines(alt, opts.meta.logTail);
                if (altTail.length) {
                    logFile = alt;
                    lines = altTail;
                    mode = "tail";
                    break;
                }
            }
        }
        report.logs = logFile ? { file: logFile, lines, mode } : null;
    }
    if (opts.meta.shot) {
        const resp = await opts.send({
            type: "SCREENSHOT",
            params: [opts.symbol, opts.tf, opts.meta.shotName ?? ""]
        });
        const map = parseKeyValueLines(resp);
        report.screenshot = map.file || null;
    }
    return report;
}
export function formatAttachReport(report) {
    const lines = [];
    lines.push(`attach: ${report.kind} ${report.name} (${report.symbol} ${report.tf})`);
    if (report.time0 || report.timeN) {
        const bars = report.bars !== undefined ? ` count=${report.bars}` : "";
        lines.push(`bars:${bars} time0=${report.time0 ?? "?"} timeN=${report.timeN ?? "?"}`);
    }
    if (report.buffers && Object.keys(report.buffers).length) {
        lines.push(`buffers:`);
        for (const [k, vals] of Object.entries(report.buffers)) {
            const short = vals.slice(0, 20).map((v) => Number.isFinite(v) ? v.toString() : "nan");
            lines.push(`  ${k}=${short.join(",")}`);
        }
    }
    if (report.logs) {
        const mode = report.logs.mode === "tail" ? " (tail)" : "";
        lines.push(`log${mode}: ${report.logs.file}`);
        if (report.logs.lines.length) {
            for (const ln of report.logs.lines)
                lines.push(`  ${ln}`);
        }
        else {
            lines.push(`  (sem linhas relevantes)`);
        }
    }
    if (report.diagnostics && report.diagnostics.length) {
        lines.push(`diagnostics:`);
        for (const d of report.diagnostics)
            lines.push(`  ${d}`);
    }
    if (report.screenshot) {
        lines.push(`screenshot: ${report.screenshot}`);
    }
    return lines.join("\n");
}
