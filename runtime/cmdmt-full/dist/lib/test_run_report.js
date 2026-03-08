import fs from "node:fs";
const DEFAULT_LIMITS = {
    important: 30,
    buffers: 20
};
function readTextWithAutoEncoding(filePath) {
    const buf = fs.readFileSync(filePath);
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return buf.slice(2).toString("utf16le");
    }
    return buf.toString("utf8");
}
function normalizeLine(raw) {
    return raw.replace(/\u0000/g, "").trim();
}
function summarizeFromLines(allLines, limits = {}) {
    const cfg = {
        important: limits.important ?? DEFAULT_LIMITS.important,
        buffers: limits.buffers ?? DEFAULT_LIMITS.buffers
    };
    const indicatorSet = new Set();
    const important = [];
    const buffers = [];
    const seenImportant = new Set();
    const seenBuffers = new Set();
    const indicatorRx = /program file added:\s*\\Indicators\\(.+?)\.ex5/i;
    const importantRx = /\[(ERR|WRN|INF)\]|open error|cannot|failed|tester stopped|entry_block|order_|deal #|market (buy|sell)|take profit|stop loss/i;
    const bufferRx = /\b(buf\d*|buffer|wave=|upper=|lower=|\+DI=|-DI=|ker|scale|pivotcount|auth=|dir=)\b/i;
    const normalized = allLines.map(normalizeLine).filter(Boolean);
    for (const line of normalized) {
        const im = line.match(indicatorRx);
        if (im && im[1])
            indicatorSet.add(im[1]);
        if (importantRx.test(line)) {
            if (!seenImportant.has(line)) {
                seenImportant.add(line);
                important.push(line);
            }
        }
        if (bufferRx.test(line)) {
            if (!seenBuffers.has(line)) {
                seenBuffers.add(line);
                buffers.push(line);
            }
        }
    }
    if (!important.length && normalized.length) {
        important.push(...normalized.slice(-Math.min(cfg.important, 15)));
    }
    return {
        indicators: Array.from(indicatorSet),
        importantLines: important.slice(-cfg.important),
        bufferLines: buffers.slice(-cfg.buffers)
    };
}
export function summarizeTesterLines(lines, limits = {}) {
    return summarizeFromLines(lines, limits);
}
export function summarizeTesterLogs(logFiles, limits = {}) {
    const allLines = [];
    for (const file of logFiles) {
        if (!file || !fs.existsSync(file))
            continue;
        let text = "";
        try {
            text = readTextWithAutoEncoding(file);
        }
        catch {
            continue;
        }
        allLines.push(...text.split(/\r?\n/));
    }
    return summarizeFromLines(allLines, limits);
}
export function formatTesterLogSummary(summary) {
    const lines = [];
    if (summary.indicators.length) {
        lines.push("indicators:");
        for (const name of summary.indicators)
            lines.push(" - " + name);
    }
    if (summary.importantLines.length) {
        lines.push("important-logs:");
        for (const l of summary.importantLines)
            lines.push(" - " + l);
    }
    if (summary.bufferLines.length) {
        lines.push("buffer-lines:");
        for (const l of summary.bufferLines)
            lines.push(" - " + l);
    }
    return lines.join("\n");
}
