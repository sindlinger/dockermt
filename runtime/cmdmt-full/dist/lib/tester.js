import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { isWsl, isWindowsPath, toWslPath, toWindowsPath } from "./config.js";
import { safeFileBase, stableHash } from "./naming.js";
import { createExpertTemplate } from "./template.js";
import { performDataImport } from "./data_import.js";
import { summarizeTesterLines } from "./test_run_report.js";
function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}
function openTerminalLog(runDir, terminalExec, args) {
    const logPath = path.join(runDir, "terminal-run.log");
    const stream = fs.createWriteStream(logPath, { flags: "a" });
    const started = new Date().toISOString();
    stream.write(`[${started}] launch: ${terminalExec} ${args.join(" ")}` + "\n");
    return { path: logPath, stream };
}
function readTextWithEncoding(filePath) {
    const buf = fs.readFileSync(filePath);
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return { text: buf.slice(2).toString("utf16le"), encoding: "utf16le", bom: true };
    }
    return { text: buf.toString("utf8"), encoding: "utf8", bom: false };
}
function writeTextWithEncoding(filePath, text, encoding, bom) {
    if (encoding === "utf16le") {
        const content = Buffer.from(text, "utf16le");
        const out = bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), content]) : content;
        fs.writeFileSync(filePath, out);
        return;
    }
    fs.writeFileSync(filePath, text, "utf8");
}
function parseParams(params) {
    if (!params)
        return [];
    return params
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((entry) => {
        const idx = entry.indexOf("=");
        if (idx <= 0)
            return { key: entry, value: "" };
        return { key: entry.slice(0, idx).trim(), value: entry.slice(idx + 1).trim() };
    });
}
function writeSetFile(filePath, inputs) {
    const lines = inputs.map((pair) => `${pair.key}=${pair.value}`);
    fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}
function formatIniSection(name, entries) {
    const lines = Object.entries(entries)
        .filter(([, value]) => value !== undefined && value !== "")
        .map(([key, value]) => `${key}=${value}`);
    return [`[${name}]`, ...lines, ""].join("\n");
}
function resolveRunnerPaths(runner) {
    const terminalPath = runner.terminalPath ?? "";
    const dataPath = runner.dataPath ?? "";
    if (!terminalPath || !dataPath) {
        throw new Error("runner incompleto: terminalPath e dataPath sao obrigatorios para o tester");
    }
    return { terminalPath, dataPath };
}
function resolveDataPathWsl(dataPath) {
    if (isWsl() && isWindowsPath(dataPath))
        return toWslPath(dataPath);
    return dataPath;
}
function shouldSkipEntry(name) {
    const lower = name.toLowerCase();
    if (lower === ".git" || lower === ".svn" || lower === ".hg")
        return true;
    if (lower === "node_modules")
        return true;
    return false;
}
function collectTerminalErrorHint(dataPathWsl, after) {
    const logDir = path.join(dataPathWsl, "Logs");
    const latest = pickLatestLog(logDir, after - 60_000) ?? pickLatestLog(logDir, 0);
    if (!latest)
        return null;
    let text = "";
    try {
        text = readTextWithEncoding(latest).text;
    }
    catch {
        return null;
    }
    const patterns = [
        /tester didn't start/i,
        /not found/i,
        /authorization .* failed/i,
        /invalid account/i,
        /not synchronized/i,
        /cannot load config/i,
        /shutdown with/i
    ];
    const start = new Date(after);
    const startSec = start.getHours() * 3600 +
        start.getMinutes() * 60 +
        start.getSeconds() +
        start.getMilliseconds() / 1000;
    const parseLineSec = (line) => {
        const m = line.match(/	(\d{2}):(\d{2}):(\d{2})\.(\d{3})	/);
        if (!m)
            return null;
        const hh = Number(m[1]);
        const mm = Number(m[2]);
        const ss = Number(m[3]);
        const ms = Number(m[4]);
        if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss) || !Number.isFinite(ms))
            return null;
        return hh * 3600 + mm * 60 + ss + ms / 1000;
    };
    const all = text
        .split(/\r?\n/)
        .map((l) => l.replace(/\u0000/g, "").trim())
        .filter((l) => l.length > 0)
        .filter((l) => patterns.some((rx) => rx.test(l)));
    if (!all.length)
        return null;
    const recent = all.filter((line) => {
        const sec = parseLineSec(line);
        if (sec === null)
            return true;
        return sec >= (startSec - 5);
    });
    const picked = recent.length ? recent : all;
    return picked.slice(-4).join(" | ");
}
function collectContainerRecentLogLines(dockerDir, serviceName, mt5DataRootContainer, maxLinesPerFile = 200) {
    const roots = [
        `${mt5DataRootContainer}/Logs`,
        `${mt5DataRootContainer}/logs`,
        `${mt5DataRootContainer}/Tester/Logs`,
        `${mt5DataRootContainer}/Tester/logs`,
        `${mt5DataRootContainer}/MQL5/Logs`,
        `${mt5DataRootContainer}/MQL5/logs`,
        `${mt5DataRootContainer}/MQL5/Tester/Logs`,
        `${mt5DataRootContainer}/MQL5/Tester/logs`
    ];
    const dirsLit = roots.map((d) => shQuote(d)).join(" ");
    const script = [
        "set -eu",
        `max=${Math.max(50, Number(maxLinesPerFile) || 200)}`,
        'tmp="/tmp/cmdmt-log-dirs.txt"; : > "$tmp"',
        `for d in ${dirsLit}; do [ -d "$d" ] && printf "%s\\n" "$d" >> "$tmp" || true; done`,
        "find /config/.wine/drive_c -type d \\( -path '*/MetaTrader 5/Logs' -o -path '*/MetaTrader 5/logs' -o -path '*/MetaTrader 5/Tester/Logs' -o -path '*/MetaTrader 5/Tester/logs' -o -path '*/MetaTrader 5/MQL5/Logs' -o -path '*/MetaTrader 5/MQL5/logs' -o -path '*/MetaTrader 5/MQL5/Tester/Logs' -o -path '*/MetaTrader 5/MQL5/Tester/logs' \\) 2>/dev/null >> \"$tmp\" || true",
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
    const rs = dockerExecSh(dockerDir, serviceName, script);
    if (!rs.ok || !rs.out)
        return [];
    return rs.out
        .split(/\r?\n/)
        .map((l) => l.replace(/\u0000/g, "").trim())
        .filter((l) => l.length > 0 && !/^WARN/i.test(l));
}
function toDisplayPath(p) {
    return isWsl() ? toWindowsPath(p) : p;
}
function isWithinRoot(target, root) {
    const rel = path.relative(root, target);
    if (!rel)
        return true;
    if (rel === "." || rel === path.sep)
        return true;
    return !rel.startsWith("..") && !path.isAbsolute(rel);
}
function normalizeExpertId(expert) {
    let e = expert.replace(/\//g, "\\");
    const lower = e.toLowerCase();
    const marker = "\\mql5\\experts\\";
    const idx = lower.indexOf(marker);
    if (idx >= 0)
        e = e.slice(idx + marker.length);
    if (e.toLowerCase().startsWith("experts\\"))
        e = e.slice("experts\\".length);
    const tail = e.slice(-4).toLowerCase();
    if (tail === ".ex5" || tail === ".mq5")
        e = e.slice(0, -4);
    return e;
}
function joinExpertPath(base, expertId, ext) {
    const parts = expertId.split("\\").filter(Boolean);
    return path.join(base, ...parts) + ext;
}
function findExpertByName(base, name) {
    const results = [];
    const stack = [base];
    while (stack.length) {
        const dir = stack.pop();
        if (!dir)
            break;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const p = path.join(dir, entry.name);
            let isDir = entry.isDirectory();
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                try {
                    const stat = fs.statSync(p);
                    if (stat.isDirectory())
                        isDir = true;
                    if (stat.isFile())
                        isFile = true;
                }
                catch {
                    // ignore broken symlink
                }
            }
            if (isDir) {
                stack.push(p);
                continue;
            }
            if (!isFile)
                continue;
            const lower = entry.name.toLowerCase();
            if (lower === `${name.toLowerCase()}.ex5`)
                results.push({ path: p, ext: ".ex5" });
            if (lower === `${name.toLowerCase()}.mq5`)
                results.push({ path: p, ext: ".mq5" });
        }
    }
    return results;
}
function resolveExpertFiles(dataPathWsl, expert) {
    const base = path.join(dataPathWsl, "MQL5", "Experts");
    const expertId = normalizeExpertId(expert);
    const directEx5 = joinExpertPath(base, expertId, ".ex5");
    const directMq5 = joinExpertPath(base, expertId, ".mq5");
    if (fs.existsSync(directEx5) || fs.existsSync(directMq5)) {
        return { expertId, ex5Path: fs.existsSync(directEx5) ? directEx5 : undefined, mq5Path: fs.existsSync(directMq5) ? directMq5 : undefined };
    }
    const nameOnly = expertId.split("\\").pop() ?? expertId;
    const matches = findExpertByName(base, nameOnly);
    const ex5 = matches.find((m) => m.ext === ".ex5")?.path;
    const mq5 = matches.find((m) => m.ext === ".mq5")?.path;
    if (!ex5 && !mq5) {
        throw new Error(`expert nao encontrado em ${base}: ${expert}`);
    }
    const chosen = ex5 ?? mq5;
    const rel = path.relative(base, chosen).replace(/\//g, "\\");
    const resolvedId = rel.replace(/\.(mq5|ex5)$/i, "");
    return { expertId: resolvedId, ex5Path: ex5, mq5Path: mq5 };
}
function compileMq5(mq5Path, metaeditorPath, logPath) {
    if (!metaeditorPath) {
        throw new Error("metaeditorPath interno ausente. Rode: cmdmt install mt5 (workspace ativo).");
    }
    const execPath = isWsl() && isWindowsPath(metaeditorPath) ? toWslPath(metaeditorPath) : metaeditorPath;
    const winMq5 = toWindowsPath(mq5Path);
    const winLog = logPath ? toWindowsPath(logPath) : undefined;
    const args = ["/compile:" + winMq5];
    if (winLog)
        args.push("/log:" + winLog);
    const result = spawnSync(execPath, args, { stdio: "inherit" });
    if (result.error)
        throw result.error;
    if (result.status && result.status !== 0) {
        let tail = "";
        let okByLog = false;
        if (logPath && fs.existsSync(logPath)) {
            const { text } = readTextWithEncoding(logPath);
            const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
            tail = lines.slice(-40).join("\n");
            okByLog = /Result:\s*0\s+errors?/i.test(text) || /0\s+error\(s\)\s*,\s*0\s+warning/i.test(text);
        }
        if (okByLog)
            return;
        if (tail) {
            throw new Error(`metaeditor retornou ${result.status}\n${tail}`);
        }
        throw new Error(`metaeditor retornou ${result.status}`);
    }
}
function updateIniValue(text, section, key, value) {
    if (value === undefined || value === "")
        return text;
    const escapedSection = section.replace(/[[\]{}()*+?.\\^$|]/g, "\\$&");
    const escapedKey = key.replace(/[[\]{}()*+?.\\^$|]/g, "\\$&");
    const sectionRe = new RegExp(`(^\\[${escapedSection}\\][\\s\\S]*?)(?=^\\[|\\Z)`, "m");
    const match = text.match(sectionRe);
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const line = `${key}=${value}`;
    if (!match) {
        return text + newline + `[${section}]` + newline + line + newline;
    }
    const block = match[1];
    const lines = block.split(/\r?\n/);
    let found = false;
    const keyRe = new RegExp(`^\\s*${escapedKey}\\s*=`, "i");
    for (let i = 1; i < lines.length; i++) {
        if (keyRe.test(lines[i])) {
            lines[i] = line;
            found = true;
            break;
        }
    }
    if (!found) {
        lines.push(line);
    }
    const updated = lines.join(newline);
    return text.replace(block, updated);
}
function readIniValue(text, section, key) {
    const escapedSection = section.replace(/[[\]{}()*+?.\\^$|]/g, "\\$&");
    const escapedKey = key.replace(/[[\]{}()*+?.\\^$|]/g, "\\$&");
    const sectionRe = new RegExp(`^\\[${escapedSection}\\][\\s\\S]*?(?=^\\[|\\Z)`, "m");
    const match = text.match(sectionRe);
    if (!match)
        return null;
    const block = match[0];
    const lineRe = new RegExp(`^\\s*${escapedKey}\\s*=\\s*(.*)$`, "mi");
    const lm = block.match(lineRe);
    return lm ? lm[1] : null;
}
const MS_PER_DAY = 24 * 60 * 60 * 1000;
function parseMt5DateYmd(raw) {
    const v = String(raw ?? "").trim();
    if (!v)
        return null;
    const head = v.split(/[ T]/)[0];
    const m = head.match(/^(\d{4})[.\/-](\d{2})[.\/-](\d{2})$/);
    if (!m)
        return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d))
        return null;
    if (mo < 1 || mo > 12)
        return null;
    if (d < 1 || d > 31)
        return null;
    return { y, m: mo, d };
}
function ymdToUtcMs(ymd) {
    return Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0, 0, 0);
}
function utcMsToMt5Ymd(ms) {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return String(y) + "." + m + "." + day;
}
function truncateDateRange(fromDate, toDate, maxDays) {
    const cap = typeof maxDays === "number" ? maxDays : Number(maxDays ?? 0);
    if (!Number.isFinite(cap) || cap <= 0) {
        return { fromDate, toDate, changed: false };
    }
    const fromYmd = parseMt5DateYmd(fromDate);
    const toYmd = parseMt5DateYmd(toDate);
    // If no dates are provided, keep behavior unchanged.
    if (!fromYmd && !toYmd)
        return { fromDate, toDate, changed: false };
    const fromMs = fromYmd ? ymdToUtcMs(fromYmd) : null;
    const toMs = toYmd ? ymdToUtcMs(toYmd) : null;
    if (fromMs !== null && toMs !== null) {
        const diffDays = Math.round((toMs - fromMs) / MS_PER_DAY);
        if (diffDays > cap) {
            const newFrom = toMs - cap * MS_PER_DAY;
            return {
                fromDate: utcMsToMt5Ymd(newFrom),
                toDate: utcMsToMt5Ymd(toMs),
                changed: true,
                note: "range truncado para " + cap + " dias (mantendo ToDate)"
            };
        }
        return { fromDate: utcMsToMt5Ymd(fromMs), toDate: utcMsToMt5Ymd(toMs), changed: false };
    }
    if (fromMs !== null && toMs === null) {
        const newTo = fromMs + cap * MS_PER_DAY;
        return {
            fromDate: utcMsToMt5Ymd(fromMs),
            toDate: utcMsToMt5Ymd(newTo),
            changed: true,
            note: "ToDate gerado (" + cap + " dias a partir de FromDate)"
        };
    }
    if (fromMs === null && toMs !== null) {
        const newFrom = toMs - cap * MS_PER_DAY;
        return {
            fromDate: utcMsToMt5Ymd(newFrom),
            toDate: utcMsToMt5Ymd(toMs),
            changed: true,
            note: "FromDate gerado (" + cap + " dias antes de ToDate)"
        };
    }
    return { fromDate, toDate, changed: false };
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
function formatIniValue(value, mask) {
    if (mask) {
        return value ? "******" : "(vazio)";
    }
    if (value === null || value === undefined || value === "")
        return "(vazio)";
    return String(value);
}
function planCommonIni(dataPathWsl, tester) {
    const configDir = resolveConfigDir(dataPathWsl);
    const commonPath = path.join(configDir, "common.ini");
    if (!fs.existsSync(commonPath))
        return null;
    const shouldSync = tester.syncCommon === true ||
        tester.login !== undefined ||
        tester.password !== undefined ||
        tester.server !== undefined ||
        tester.maxBars !== undefined ||
        tester.maxBarsInChart !== undefined ||
        tester.allowDllImport !== undefined ||
        tester.allowLiveTrading !== undefined ||
        tester.expertsEnabled !== undefined ||
        tester.expertsDisableOnAccountChange !== undefined ||
        tester.expertsDisableOnProfileChange !== undefined;
    if (!shouldSync)
        return null;
    const { text, encoding, bom } = readTextWithEncoding(commonPath);
    let next = text;
    const changes = [];
    const addChange = (section, key, value, mask) => {
        if (value === undefined || value === "")
            return;
        const desired = String(value);
        const current = readIniValue(next, section, key);
        if (current !== desired) {
            changes.push({ file: commonPath, section, key, from: current, to: desired, mask });
            next = updateIniValue(next, section, key, value);
        }
    };
    addChange("Common", "Login", tester.login);
    addChange("Common", "Password", tester.password, true);
    addChange("Common", "Server", tester.server);
    addChange("Charts", "MaxBars", tester.maxBars);
    addChange("Charts", "MaxBarsInChart", tester.maxBarsInChart);
    addChange("Experts", "AllowDllImport", tester.allowDllImport);
    addChange("Experts", "AllowLiveTrading", tester.allowLiveTrading);
    addChange("Experts", "Enabled", tester.expertsEnabled);
    addChange("Experts", "Account", tester.expertsDisableOnAccountChange);
    addChange("Experts", "Profile", tester.expertsDisableOnProfileChange);
    if (!changes.length || next === text)
        return null;
    return {
        changes,
        apply: () => writeTextWithEncoding(commonPath, next, encoding, bom)
    };
}
function planTerminalIni(dataPathWsl, tester) {
    const configDir = resolveConfigDir(dataPathWsl);
    const terminalPath = path.join(configDir, "terminal.ini");
    if (!fs.existsSync(terminalPath))
        return null;
    const wantsWindow = tester.windowLeft !== undefined ||
        tester.windowTop !== undefined ||
        tester.windowRight !== undefined ||
        tester.windowBottom !== undefined ||
        tester.windowWidth !== undefined ||
        tester.windowHeight !== undefined ||
        tester.windowFullscreen !== undefined;
    if (!wantsWindow)
        return null;
    const { text, encoding, bom } = readTextWithEncoding(terminalPath);
    const curLeft = parseInt(readIniValue(text, "Window", "Left") ?? "0", 10);
    const curTop = parseInt(readIniValue(text, "Window", "Top") ?? "0", 10);
    const curRight = parseInt(readIniValue(text, "Window", "Right") ?? "0", 10);
    const curBottom = parseInt(readIniValue(text, "Window", "Bottom") ?? "0", 10);
    const coerceInt = (val, fallback) => {
        if (val === undefined || val === "")
            return fallback;
        const n = typeof val === "number" ? val : parseInt(String(val), 10);
        return Number.isFinite(n) ? n : fallback;
    };
    let left = coerceInt(tester.windowLeft, Number.isFinite(curLeft) ? curLeft : 0);
    let top = coerceInt(tester.windowTop, Number.isFinite(curTop) ? curTop : 0);
    let right = coerceInt(tester.windowRight, Number.isFinite(curRight) ? curRight : left + 1280);
    let bottom = coerceInt(tester.windowBottom, Number.isFinite(curBottom) ? curBottom : top + 720);
    const width = tester.windowWidth !== undefined ? coerceInt(tester.windowWidth, right - left) : undefined;
    const height = tester.windowHeight !== undefined ? coerceInt(tester.windowHeight, bottom - top) : undefined;
    if (width !== undefined)
        right = left + width;
    if (height !== undefined)
        bottom = top + height;
    let next = text;
    const changes = [];
    const addChange = (key, value) => {
        if (value === undefined || value === "")
            return;
        const desired = String(value);
        const current = readIniValue(next, "Window", key);
        if (current !== desired) {
            changes.push({ file: terminalPath, section: "Window", key, from: current, to: desired });
            next = updateIniValue(next, "Window", key, value);
        }
    };
    addChange("Left", left);
    addChange("Top", top);
    addChange("Right", right);
    addChange("Bottom", bottom);
    addChange("LSave", left);
    addChange("TSave", top);
    addChange("RSave", right);
    addChange("BSave", bottom);
    if (tester.windowFullscreen !== undefined) {
        addChange("Fullscreen", tester.windowFullscreen);
    }
    if (!changes.length || next === text)
        return null;
    return {
        changes,
        apply: () => writeTextWithEncoding(terminalPath, next, encoding, bom)
    };
}
async function confirmUserOps(ops, options) {
    if (ops.length === 0)
        return true;
    if (options.assumeYes)
        return true;
    const lines = ["Operacoes no workspace interno:", ...ops.map((op) => `- ${op}`)];
    if (options.confirm) {
        return options.confirm(lines);
    }
    if (!options.interactive) {
        process.stderr.write("Confirmacao obrigatoria; sem TTY (use --yes).\n");
        return false;
    }
    for (const line of lines) {
        process.stdout.write(line + "\n");
    }
    const answer = await new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question("Aplicar operacoes? (s/N) ", (val) => {
            rl.close();
            resolve(val);
        });
    });
    const val = answer.trim().toLowerCase();
    return val === "y" || val === "yes" || val === "s" || val === "sim";
}
function ensureExpertReady(dataPathWsl, expert, metaeditorPath, logDir) {
    const resolved = resolveExpertFiles(dataPathWsl, expert);
    const mq5 = resolved.mq5Path;
    let ex5 = resolved.ex5Path;
    if (!ex5 && mq5) {
        const logPath = logDir ? path.join(logDir, "metaeditor.log") : undefined;
        compileMq5(mq5, metaeditorPath, logPath);
        const base = path.join(dataPathWsl, "MQL5", "Experts");
        ex5 = joinExpertPath(base, resolved.expertId, ".ex5");
    }
    if (mq5 && ex5) {
        const mq5Stat = fs.statSync(mq5);
        const ex5Stat = fs.existsSync(ex5) ? fs.statSync(ex5) : undefined;
        if (!ex5Stat || mq5Stat.mtimeMs > ex5Stat.mtimeMs) {
            const logPath = logDir ? path.join(logDir, "metaeditor.log") : undefined;
            compileMq5(mq5, metaeditorPath, logPath);
        }
    }
    if (!ex5 || !fs.existsSync(ex5)) {
        throw new Error(`expert ex5 nao encontrado: ${resolved.expertId}`);
    }
    return { expertId: resolved.expertId, ex5Path: ex5 };
}
function pickLatestLog(dir, after) {
    if (!fs.existsSync(dir))
        return null;
    const entries = fs
        .readdirSync(dir)
        .map((name) => ({ name, path: path.join(dir, name) }))
        .filter((entry) => entry.name.toLowerCase().endsWith(".log"))
        .map((entry) => ({ ...entry, stat: fs.statSync(entry.path) }))
        .filter((entry) => entry.stat.mtimeMs >= after);
    if (entries.length === 0)
        return null;
    entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    return entries[0].path;
}
function copyIfExists(src, destDir) {
    if (!src)
        return null;
    if (!fs.existsSync(src))
        return null;
    const base = path.basename(src);
    const dest = path.join(destDir, base);
    fs.copyFileSync(src, dest);
    return dest;
}
export async function runTester(spec, runner, tester, options = {}) {
    const { terminalPath, dataPath } = resolveRunnerPaths(runner);
    const dataPathWsl = resolveDataPathWsl(dataPath);
    const plans = [];
    const commonPlan = planCommonIni(dataPathWsl, tester);
    if (commonPlan)
        plans.push(commonPlan);
    const terminalPlan = planTerminalIni(dataPathWsl, tester);
    if (terminalPlan)
        plans.push(terminalPlan);
    const inputs = parseParams(spec.params);
    const runDirRoot = tester.artifactsDir || "cmdmt-artifacts";
    const runDir = path.isAbsolute(runDirRoot) || isWindowsPath(runDirRoot)
        ? resolveDataPathWsl(runDirRoot)
        : path.join(dataPathWsl, runDirRoot);
    const tempHash = stableHash(`${spec.expert}|${spec.symbol}|${spec.tf}|${spec.params ?? ""}`);
    const runId = `${Date.now()}-${tempHash}`;
    const runDirFinal = path.join(runDir, runId);
    const resolvedExpert = resolveExpertFiles(dataPathWsl, spec.expert);
    const expertId = resolvedExpert.expertId;
    let compileNeeded = false;
    if (!resolvedExpert.ex5Path && resolvedExpert.mq5Path) {
        compileNeeded = true;
    }
    else if (resolvedExpert.ex5Path && resolvedExpert.mq5Path) {
        const mq5Stat = fs.statSync(resolvedExpert.mq5Path);
        const ex5Stat = fs.existsSync(resolvedExpert.ex5Path) ? fs.statSync(resolvedExpert.ex5Path) : undefined;
        if (!ex5Stat || mq5Stat.mtimeMs > ex5Stat.mtimeMs)
            compileNeeded = true;
    }
    const baseName = safeFileBase(`${expertId}-${spec.symbol}-${spec.tf}`);
    const fileBaseRaw = baseName || "run";
    const fileBase = fileBaseRaw.length > 48 ? fileBaseRaw.slice(0, 48) : fileBaseRaw;
    const hash = stableHash(`${expertId}|${spec.symbol}|${spec.tf}|${spec.params ?? ""}`);
    let baseTplResolved = "";
    if (spec.oneShot) {
        const templatesDir = path.join(dataPathWsl, "MQL5", "Profiles", "Templates");
        const ensureTplExt = (name) => name.toLowerCase().endsWith(".tpl") ? name : `${name}.tpl`;
        const resolveTplPath = (name) => {
            const withExt = ensureTplExt(name);
            if (isWindowsPath(withExt))
                return isWsl() ? toWslPath(withExt) : withExt;
            return path.join(templatesDir, withExt);
        };
        let baseTpl = spec.baseTpl?.trim() ?? "";
        if (baseTpl) {
            const basePath = resolveTplPath(baseTpl);
            if (!fs.existsSync(basePath))
                baseTpl = "";
        }
        if (!baseTpl) {
            const candidates = ["Moving Average.tpl", "Default.tpl", "default.tpl"];
            const found = candidates.find((name) => fs.existsSync(path.join(templatesDir, name)));
            if (found)
                baseTpl = found;
        }
        if (!baseTpl) {
            try {
                const anyTpl = fs
                    .readdirSync(templatesDir, { withFileTypes: true })
                    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".tpl"))
                    .map((e) => e.name)
                    .sort()[0];
                if (anyTpl)
                    baseTpl = anyTpl;
            }
            catch {
                // ignore
            }
        }
        if (!baseTpl) {
            throw new Error("base template ausente para expert run. Use --base-tpl/CMDMT_BASE_TPL.");
        }
        baseTplResolved = baseTpl;
    }
    const profilesTesterDir = path.join(dataPathWsl, "MQL5", "Profiles", "Tester");
    const setFileName = `${fileBase}-${hash}.set`;
    const setFilePath = path.join(profilesTesterDir, setFileName);
    const reportDir = tester.reportDir || "reports";
    const reportFile = `${fileBase}-${hash}.html`;
    const reportDirIsAbs = path.isAbsolute(reportDir) || isWindowsPath(reportDir);
    const reportAbs = reportDirIsAbs
        ? path.join(resolveDataPathWsl(reportDir), reportFile)
        : path.join(dataPathWsl, path.win32.join(reportDir, reportFile).replace(/\\/g, path.sep));
    const reportIni = reportDirIsAbs ? toWindowsPath(reportAbs) : path.win32.join(reportDir, reportFile);
    const iniPath = path.join(runDirFinal, `${fileBase}-${hash}.ini`);
    const userOps = [];
    const dataRoot = path.resolve(dataPathWsl);
    const maybeAddCreate = (label, target) => {
        const targetAbs = path.resolve(target);
        if (!isWithinRoot(targetAbs, dataRoot))
            return;
        if (fs.existsSync(targetAbs))
            return;
        userOps.push(`${label}: ${toDisplayPath(targetAbs)}`);
    };
    if (spec.oneShot) {
        const templatesDir = path.join(dataPathWsl, "MQL5", "Profiles", "Templates");
        const outTplPath = path.join(templatesDir, "tester.tpl");
        maybeAddCreate("criar template", outTplPath);
    }
    maybeAddCreate("criar artifacts", runDir);
    maybeAddCreate("criar run", runDirFinal);
    maybeAddCreate("criar set", setFilePath);
    maybeAddCreate("criar ini", iniPath);
    maybeAddCreate("criar report", reportAbs);
    const assumeYes = options.assumeYes ?? spec.assumeYes ?? false;
    const interactive = options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
    if (userOps.length) {
        const shouldApply = await confirmUserOps(userOps, { assumeYes, interactive, confirm: options.confirm });
        if (!shouldApply) {
            throw new Error("operacao cancelada pelo usuario");
        }
    }
    for (const plan of plans)
        plan.apply();
    ensureDir(runDir);
    ensureDir(runDirFinal);
    ensureExpertReady(dataPathWsl, spec.expert, runner.metaeditorPath, runDirFinal);
    if (spec.oneShot) {
        createExpertTemplate({
            expert: expertId,
            outTpl: "tester.tpl",
            baseTpl: baseTplResolved,
            params: spec.params,
            dataPath: runner.dataPath ?? ""
        });
    }
    ensureDir(profilesTesterDir);
    writeSetFile(setFilePath, inputs);
    ensureDir(path.dirname(reportAbs));
    const range = truncateDateRange(tester.fromDate, tester.toDate, tester.maxTestDays);
    const effFromDate = range.fromDate;
    const effToDate = range.toDate;
    const iniEntries = {
        Expert: expertId,
        ExpertParameters: setFileName,
        Symbol: spec.symbol,
        Period: spec.tf,
        Login: tester.login,
        Password: tester.password,
        Server: tester.server,
        Model: tester.model,
        ExecutionMode: tester.executionMode,
        Optimization: tester.optimization,
        UseLocal: tester.useLocal,
        UseRemote: tester.useRemote,
        UseCloud: tester.useCloud,
        Visual: tester.visual,
        ReplaceReport: tester.replaceReport,
        ShutdownTerminal: tester.shutdownTerminal,
        Report: reportIni,
        Deposit: tester.deposit,
        Currency: tester.currency,
        Leverage: tester.leverage,
        FromDate: effFromDate,
        ToDate: effToDate,
        ForwardMode: tester.forwardMode,
        ForwardDate: tester.forwardDate
    };
    const expertsEntries = {
        AllowDllImport: tester.allowDllImport,
        AllowLiveTrading: tester.allowLiveTrading,
        Enabled: tester.expertsEnabled,
        Account: tester.expertsDisableOnAccountChange,
        Profile: tester.expertsDisableOnProfileChange
    };
    const iniContent = formatIniSection("Tester", iniEntries) + formatIniSection("Experts", expertsEntries);
    fs.writeFileSync(iniPath, iniContent, "utf8");
    const terminalExec = isWsl() && isWindowsPath(terminalPath) ? toWslPath(terminalPath) : terminalPath;
    const configArg = `/config:${toWindowsPath(iniPath)}`;
    const args = [configArg];
    if (runner.portable)
        args.unshift("/portable");
    let launchExec = terminalExec;
    let launchArgs = [...args];
    // Em Linux/container, execute .exe explicitamente via Wine para evitar handlers/binfmt inesperados.
    if (process.platform !== "win32" && /\.exe$/i.test(terminalExec)) {
        launchExec = "wine";
        launchArgs = [terminalExec, ...args];
    }
    const terminalLog = openTerminalLog(runDirFinal, launchExec, launchArgs);
    const startTime = Date.now();
    await new Promise((resolve, reject) => {
        const child = spawn(launchExec, launchArgs, { stdio: ["ignore", "pipe", "pipe"] });
        if (child.stdout) {
            child.stdout.on("data", (chunk) => {
                process.stdout.write(chunk);
                if (!terminalLog.stream.writableEnded)
                    terminalLog.stream.write(chunk);
            });
        }
        if (child.stderr) {
            child.stderr.on("data", (chunk) => {
                process.stderr.write(chunk);
                if (!terminalLog.stream.writableEnded)
                    terminalLog.stream.write(chunk);
            });
        }
        child.on("error", (err) => {
            terminalLog.stream.write(`[${new Date().toISOString()}] error: ${String(err)}\n`);
            terminalLog.stream.end();
            reject(err);
        });
        child.on("exit", (code) => {
            terminalLog.stream.write(`[${new Date().toISOString()}] exit: ${code ?? 0}\n`);
            if (code && code !== 0) {
                if (tester.allowOpen && code === 189) {
                    const msg = "terminal retornou 189; continuando por allowOpen=true";
                    process.stdout.write(`${msg}\n`);
                    terminalLog.stream.write(`[warn] ${msg}\n`);
                    terminalLog.stream.end();
                    resolve();
                    return;
                }
                const hint = collectTerminalErrorHint(dataPathWsl, startTime);
                terminalLog.stream.end();
                reject(new Error(`terminal retornou ${code} (log: ${terminalLog.path})${hint ? ` | detalhe: ${hint}` : ""}`));
                return;
            }
            terminalLog.stream.end();
            resolve();
        });
    });
    const copiedReport = copyIfExists(reportAbs, runDirFinal);
    const logDirs = [
        path.join(dataPathWsl, "Logs"),
        path.join(dataPathWsl, "Tester", "Logs"),
        path.join(dataPathWsl, "MQL5", "Logs"),
        path.join(dataPathWsl, "MQL5", "Tester", "Logs")
    ];
    const copiedLogs = [];
    for (const dir of logDirs) {
        const latest = pickLatestLog(dir, startTime);
        const copied = copyIfExists(latest, runDirFinal);
        if (copied)
            copiedLogs.push(copied);
    }
    return {
        runDir: runDirFinal,
        iniPath,
        setPath: setFilePath,
        reportPath: reportAbs,
        copiedReport: copiedReport ?? undefined,
        copiedLogs,
        terminalLogPath: terminalLog.path
    };
}
function runDockerComposeSync(dockerDir, args, input) {
    const res = spawnSync("docker", ["compose", ...args], {
        cwd: dockerDir,
        encoding: "utf8",
        input
    });
    const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
    return { ok: res.status === 0, out, status: res.status };
}
function shQuote(v) {
    return `'${v.replace(/'/g, `'"'"'`)}'`;
}
function resolveDockerServiceName(dockerDir, preferred) {
    const cfg = runDockerComposeSync(dockerDir, ["config", "--services"]);
    if (!cfg.ok)
        throw new Error(cfg.out || "docker compose config --services falhou");
    const services = cfg.out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !/^WARN/i.test(l));
    if (!services.length)
        throw new Error("nenhum servico encontrado no docker compose");
    if (preferred && services.includes(preferred))
        return preferred;
    return services[0];
}
function detectContainerMt5Root(dockerDir, serviceName) {
    const script = [
        "if [ -x '/config/.wine/drive_c/Program Files/MetaTrader 5/terminal64.exe' ]; then echo '/config/.wine/drive_c/Program Files/MetaTrader 5'; exit 0; fi",
        "p=$(find /config -type f -name terminal64.exe 2>/dev/null | head -n 1)",
        "if [ -z \"$p\" ]; then exit 1; fi",
        "dirname \"$p\""
    ].join("; ");
    const r = runDockerComposeSync(dockerDir, ["exec", "-T", serviceName, "sh", "-lc", script]);
    if (!r.ok) {
        throw new Error(r.out || "nao foi possivel descobrir raiz do MT5 no container");
    }
    const line = r.out
        .split(/\r?\n/)
        .map((v) => v.trim())
        .find((v) => v.startsWith("/"));
    if (!line)
        throw new Error("raiz MT5 no container nao encontrada");
    return line;
}
function detectContainerMt5DataRoot(dockerDir, serviceName) {
    const script = [
        "portable='/config/.wine/drive_c/Program Files/MetaTrader 5'",
        "if [ -d \"$portable/MQL5\" ]; then printf '%s\n' \"$portable\"; exit 0; fi",
        "base='/config/.wine/drive_c/users'",
        "p=$(find \"$base\" -type d -path '*/AppData/Roaming/MetaQuotes/Terminal/*' 2>/dev/null | grep -E '/Terminal/[0-9A-F]{32}$' | head -n1)",
        "if [ -z \"$p\" ]; then p=$(find \"$base\" -type d -path '*/AppData/Roaming/MetaQuotes/Terminal/*' 2>/dev/null | head -n1); fi",
        "if [ -z \"$p\" ]; then exit 1; fi",
        "printf '%s\n' \"$p\""
    ].join('; ');
    const r = runDockerComposeSync(dockerDir, ["exec", "-T", serviceName, "sh", "-lc", script]);
    if (!r.ok)
        throw new Error(r.out || "nao foi possivel descobrir data root do MT5 no container");
    const line = r.out
        .split(/\r?\n/)
        .map((v) => v.trim())
        .find((v) => v.startsWith("/"));
    if (!line)
        throw new Error("data root do MT5 no container nao encontrado");
    return line;
}
function detectContainerWineUser(dockerDir, serviceName) {
    const script = "u=$(stat -c '%U' /config/.wine 2>/dev/null || true); if [ -n \"$u\" ]; then echo $u; else id -un; fi";
    const r = runDockerComposeSync(dockerDir, ["exec", "-T", serviceName, "sh", "-lc", script]);
    if (!r.ok)
        return null;
    const user = r.out
        .split(/\r?\n/)
        .map((v) => v.trim())
        .find((v) => v.length > 0 && !/^WARN/i.test(v));
    return user || null;
}
function containerPathToWine(pathInContainer) {
    const needle = "/drive_c/";
    const idx = pathInContainer.indexOf(needle);
    if (idx < 0) {
        throw new Error(`caminho sem drive_c para wine: ${pathInContainer}`);
    }
    const tail = pathInContainer.slice(idx + needle.length).replace(/\//g, "\\");
    return `C:\\${tail}`;
}
function containerDriveCRoot(pathInContainer) {
    const needle = "/drive_c/";
    const idx = pathInContainer.indexOf(needle);
    if (idx < 0) {
        throw new Error(`caminho sem drive_c para wine: ${pathInContainer}`);
    }
    return pathInContainer.slice(0, idx + "/drive_c".length);
}
function mapContainerPathToHost(pathInContainer, dockerDir) {
    if (pathInContainer === "/config")
        return path.join(dockerDir, "config");
    const prefix = "/config/";
    if (!pathInContainer.startsWith(prefix))
        return null;
    return path.join(dockerDir, "config", pathInContainer.slice(prefix.length));
}
function mapHostPathToContainer(pathOnHost, dockerDir) {
    const hostConfig = path.resolve(path.join(dockerDir, "config"));
    const abs = path.resolve(pathOnHost);
    const rel = path.relative(hostConfig, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel))
        return null;
    if (!rel || rel === ".")
        return "/config";
    return "/config/" + rel.replace(/\\/g, "/");
}
function normalizeReportDir(reportDir) {
    if (!reportDir)
        return "reports";
    if (path.isAbsolute(reportDir) || isWindowsPath(reportDir))
        return "reports";
    return reportDir;
}
async function waitForTesterStartInContainer(dockerDir, serviceName, mt5InstallRootContainer, runId, timeoutSec, logsDirHost) {
    const logsDir = `${mt5InstallRootContainer}/logs`;
    const rid = runId.toLowerCase();
    const maxWaitMs = Math.max(5, Math.floor(timeoutSec || 0)) * 1000;
    const deadline = Date.now() + maxWaitMs;
    const checkHostLogs = () => {
        if (!logsDirHost || !fs.existsSync(logsDirHost))
            return { ok: false, detail: "host_logs_unavailable" };
        const files = fs
            .readdirSync(logsDirHost)
            .filter((f) => f.toLowerCase().endsWith('.log'))
            .map((f) => path.join(logsDirHost, f))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        for (const file of files) {
            let text = "";
            try {
                text = readTextWithEncoding(file).text.toLowerCase();
            }
            catch {
                continue;
            }
            const pos = text.indexOf(rid);
            if (pos < 0)
                continue;
            if (text.indexOf('automatical testing started', pos) >= 0) {
                return { ok: true, detail: `ok_host:${file}` };
            }
        }
        return { ok: false, detail: files.length ? files[0] : "host_no_log" };
    };
    while (Date.now() < deadline) {
        const hostCheck = checkHostLogs();
        if (hostCheck.ok)
            return hostCheck;
        const cmd = [
            `logs=${shQuote(logsDir)}`,
            `rid=${shQuote(rid)}`,
            'for f in "$logs"/*.log; do',
            '  [ -f "$f" ] || continue',
            '  ln=$(iconv -f UTF-16LE -t UTF-8 "$f" 2>/dev/null | tr "[:upper:]" "[:lower:]" | grep -n -m1 "$rid" | cut -d: -f1)',
            '  if [ -n "$ln" ] && iconv -f UTF-16LE -t UTF-8 "$f" 2>/dev/null | tr "[:upper:]" "[:lower:]" | tail -n +"$ln" | grep -q "automatical testing started"; then',
            '    echo "ok:$f"; exit 0',
            '  fi',
            'done',
            'latest=$(ls -1t "$logs"/*.log 2>/dev/null | head -n1)',
            'if [ -n "$latest" ]; then',
            '  echo "pending:$latest"',
            'else',
            '  echo "pending:no_log"',
            'fi',
            'exit 1'
        ].join('; ');
        const rs = dockerExecSh(dockerDir, serviceName, cmd);
        if (rs.ok) {
            return { ok: true, detail: rs.out || 'tester_started' };
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (logsDirHost && fs.existsSync(logsDirHost)) {
        const files = fs
            .readdirSync(logsDirHost)
            .filter((f) => f.toLowerCase().endsWith('.log'))
            .map((f) => path.join(logsDirHost, f))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        if (files.length) {
            try {
                const text = readTextWithEncoding(files[0]).text;
                return { ok: false, detail: `latest=${files[0]}\n${text.split(/\r?\n/).slice(-20).join('\n')}` };
            }
            catch {
                return { ok: false, detail: `latest=${files[0]}` };
            }
        }
    }
    const tailCmd = [
        `logs=${shQuote(logsDir)}`,
        'latest=$(ls -1t "$logs"/*.log 2>/dev/null | head -n1)',
        'if [ -z "$latest" ]; then echo "no_terminal_log"; exit 0; fi',
        'echo "latest=$latest"',
        'iconv -f UTF-16LE -t UTF-8 "$latest" 2>/dev/null | tail -n 20'
    ].join('; ');
    const tail = dockerExecSh(dockerDir, serviceName, tailCmd);
    const tailLower = (tail.out || '').toLowerCase();
    if (tailLower.includes('automatical testing started')) {
        return { ok: true, detail: tail.out || 'tester_started_by_tail' };
    }
    return { ok: false, detail: tail.out || 'timeout_waiting_tester_start' };
}
function dockerExecSh(dockerDir, serviceName, command, opts) {
    const args = ["exec", "-T"];
    if (opts?.user)
        args.push("-u", opts.user);
    args.push(serviceName, "sh", "-lc", command);
    return runDockerComposeSync(dockerDir, args, opts?.input);
}
function syncContainerFilesToTesterAgents(dockerDir, serviceName, mt5DataRootContainer) {
    const data = mt5DataRootContainer;
    const script = [
        `data=${shQuote(data)}`,
        // Alguns ambientes usam data root em AppData e outros em Program Files.
        // Sincronizamos ambos para evitar mismatch de fonte no tester.
        'for root in "$data" "/config/.wine/drive_c/Program Files/MetaTrader 5"; do',
        '  [ -d "$root/MQL5" ] || continue',
        '  src_files="$root/MQL5/Files/EmptyMod/EXP-EmptyMod"',
        '  src_experts="$root/MQL5/Experts/EXP-EmptyMod"',
        '  if [ ! -d "$src_files" ] && [ -d "$src_experts" ]; then',
        '    mkdir -p "$root/MQL5/Files/EmptyMod"',
        '    rm -rf "$src_files"',
        '    cp -a "$src_experts" "$src_files"',
        '  fi',
        '  if [ ! -d "$src_files" ]; then',
        '    continue',
        '  fi',
        '  mkdir -p "$root/MQL5/Experts"',
        '  rm -rf "$src_experts"',
        '  cp -a "$src_files" "$src_experts"',
        '  mkdir -p "$root/Tester/Agent-127.0.0.1-3002/MQL5/Files/EmptyMod"',
        '  for a in "$root"/Tester/Agent-*; do',
        '    [ -d "$a" ] || continue',
        '    mkdir -p "$a/MQL5/Files/EmptyMod"',
        '    rm -rf "$a/MQL5/Files/EmptyMod/EXP-EmptyMod"',
        '    cp -a "$src_files" "$a/MQL5/Files/EmptyMod/"',
        '  done',
        'done'
    ].join("; ");
    dockerExecSh(dockerDir, serviceName, script);
}
function writeContainerTextFile(dockerDir, serviceName, filePath, content, user) {
    const dir = path.posix.dirname(filePath);
    const cmd = `mkdir -p ${shQuote(dir)} && cat > ${shQuote(filePath)}`;
    const wr = dockerExecSh(dockerDir, serviceName, cmd, { user, input: content });
    if (wr.ok)
        return;
    // Fallback robusto: grava como root quando o owner atual nao permite escrita.
    const wrRoot = dockerExecSh(dockerDir, serviceName, cmd, { user: "root", input: content });
    if (!wrRoot.ok)
        throw new Error(wrRoot.out || wr.out || `falha ao gravar arquivo no container: ${filePath}`);
    if (user && user !== "root") {
        const fixCmd = `chown ${shQuote(user)}:${shQuote(user)} ${shQuote(filePath)} || true`;
        dockerExecSh(dockerDir, serviceName, fixCmd, { user: "root" });
    }
}
function resolveExpertIdInContainer(dockerDir, serviceName, mt5RootContainer, expert) {
    const expertUnix = normalizeExpertId(expert).replace(/\\/g, "/");
    const name = path.posix.basename(expertUnix);
    const base = `${mt5RootContainer}/MQL5/Experts`;
    const script = [
        `base=${shQuote(base)}`,
        `eid=${shQuote(expertUnix)}`,
        `name=${shQuote(name)}`,
        'if [ -f "$base/$eid.ex5" ]; then printf "%s\\n" "$eid"; exit 0; fi',
        'p=$(find "$base" -type f -iname "$name.ex5" 2>/dev/null | head -n1)',
        'if [ -z "$p" ]; then exit 1; fi',
        'rel=${p#"$base/"}',
        'rel=${rel%.ex5}',
        'printf "%s\\n" "$rel"'
    ].join('; ');
    const rs = dockerExecSh(dockerDir, serviceName, script);
    if (!rs.ok) {
        throw new Error(`expert nao encontrado no container: ${expert}`);
    }
    const line = rs.out
        .split(/\r?\n/)
        .map((v) => v.trim())
        .find((v) => v.length > 0 && !/^WARN/i.test(v));
    if (!line)
        throw new Error(`expert nao encontrado no container: ${expert}`);
    return line.replace(/\//g, "\\");
}
export async function runTesterInContainer(spec, tester, container) {
    const dockerDir = path.resolve(container.dockerDir);
    const up = runDockerComposeSync(dockerDir, ["up", "-d"]);
    if (!up.ok) {
        throw new Error(up.out || "docker compose up falhou");
    }
    const serviceName = resolveDockerServiceName(dockerDir, container.serviceName);
    const mt5InstallRootContainer = detectContainerMt5Root(dockerDir, serviceName);
    const mt5DataRootContainer = detectContainerMt5DataRoot(dockerDir, serviceName);
    const mt5DataRootHost = mapContainerPathToHost(mt5DataRootContainer, dockerDir);
    const hostMapped = Boolean(mt5DataRootHost && fs.existsSync(path.join(mt5DataRootHost, "MQL5")));
    if (hostMapped && mt5DataRootHost) {
        const commonPlan = planCommonIni(mt5DataRootHost, tester);
        if (commonPlan)
            commonPlan.apply();
    }
    const wineUser = container.wineUser || detectContainerWineUser(dockerDir, serviceName) || "";
    const expertId = hostMapped
        ? (() => {
            const resolved = resolveExpertFiles(mt5DataRootHost, spec.expert);
            if (!resolved.ex5Path)
                throw new Error(`expert .ex5 ausente no container: ${resolved.expertId}`);
            return resolved.expertId;
        })()
        : resolveExpertIdInContainer(dockerDir, serviceName, mt5DataRootContainer, spec.expert);
    if (spec.csv) {
        if (!hostMapped) {
            throw new Error("csv import requer volume /config mapeado no host (bind mount)");
        }
        if (!container.transport) {
            throw new Error("csv import requer transport (socket) configurado");
        }
        await performDataImport(spec.csv, { dataPath: mt5DataRootHost }, container.transport);
    }
    const inputs = parseParams(spec.params);
    const setContent = inputs.map((pair) => `${pair.key}=${pair.value}`).join("\n");
    const tempHash = stableHash(`${spec.expert}|${spec.symbol}|${spec.tf}|${spec.params ?? ""}`);
    const runId = `${Date.now()}-${tempHash}`;
    const baseName = safeFileBase(`${expertId}-${spec.symbol}-${spec.tf}`);
    const fileBaseRaw = baseName || "run";
    const fileBase = fileBaseRaw.length > 48 ? fileBaseRaw.slice(0, 48) : fileBaseRaw;
    const hash = stableHash(`${expertId}|${spec.symbol}|${spec.tf}|${spec.params ?? ""}`);
    const setFileName = `${fileBase}-${hash}.set`;
    const setPathContainer = `${mt5DataRootContainer}/MQL5/Profiles/Tester/${setFileName}`;
    const reportDir = normalizeReportDir(tester.reportDir);
    const reportFile = `${fileBase}-${hash}.html`;
    const reportIni = path.win32.join(reportDir, reportFile);
    const driveCRootContainer = containerDriveCRoot(mt5InstallRootContainer);
    const runDirContainer = `${driveCRootContainer}/cmdmt-artifacts/${runId}`;
    const iniPathContainer = `${runDirContainer}/${fileBase}-${hash}.ini`;
    writeContainerTextFile(dockerDir, serviceName, setPathContainer, setContent, wineUser || undefined);
    const range = truncateDateRange(tester.fromDate, tester.toDate, tester.maxTestDays);
    const effFromDate = range.fromDate;
    const effToDate = range.toDate;
    const iniEntries = {
        Expert: expertId,
        ExpertParameters: setFileName,
        Symbol: spec.symbol,
        Period: spec.tf,
        Login: tester.login,
        Password: tester.password,
        Server: tester.server,
        Model: tester.model,
        ExecutionMode: tester.executionMode,
        Optimization: tester.optimization,
        UseLocal: tester.useLocal,
        UseRemote: tester.useRemote,
        UseCloud: tester.useCloud,
        Visual: tester.visual,
        ReplaceReport: tester.replaceReport,
        ShutdownTerminal: tester.shutdownTerminal,
        Report: reportIni,
        Deposit: tester.deposit,
        Currency: tester.currency,
        Leverage: tester.leverage,
        FromDate: effFromDate,
        ToDate: effToDate,
        ForwardMode: tester.forwardMode,
        ForwardDate: tester.forwardDate
    };
    const expertsEntries = {
        AllowDllImport: tester.allowDllImport,
        AllowLiveTrading: tester.allowLiveTrading,
        Enabled: tester.expertsEnabled,
        Account: tester.expertsDisableOnAccountChange,
        Profile: tester.expertsDisableOnProfileChange
    };
    const iniContent = formatIniSection("Tester", iniEntries) + formatIniSection("Experts", expertsEntries);
    writeContainerTextFile(dockerDir, serviceName, iniPathContainer, iniContent, wineUser || undefined);
    // Garante arquivos de módulos em MQL5/Files dentro dos agents locais do tester.
    // Evita falhas de descoberta dinâmica quando o EA lê contratos via FileOpen/FileFind.
    syncContainerFilesToTesterAgents(dockerDir, serviceName, mt5DataRootContainer);
    const terminalContainer = `${mt5InstallRootContainer}/terminal64.exe`;
    const terminalWin = containerPathToWine(terminalContainer);
    const iniWin = containerPathToWine(iniPathContainer);
    const configArg = `/config:${iniWin}`;
    // Garante arranque limpo do tester: se o terminal normal estiver aberto,
    // o /config pode ser ignorado e o runId nunca aparece no log.
    dockerExecSh(dockerDir, serviceName, "wineserver -k >/dev/null 2>&1 || true; sleep 1", {
        user: wineUser || undefined
    });
    const runCmd = `wine ${shQuote(terminalWin)} /portable ${shQuote(configArg)}`;
    const launchCmd = runCmd + ` >/tmp/cmdmt-tester-${runId}.log 2>&1 & echo started`;
    const execArgs = ["exec", "-T"];
    if (wineUser)
        execArgs.push("-u", wineUser);
    execArgs.push(serviceName, "sh", "-lc", launchCmd);
    const run = runDockerComposeSync(dockerDir, execArgs);
    if (!run.ok) {
        const hint = hostMapped && mt5DataRootHost ? collectTerminalErrorHint(mt5DataRootHost, Date.now() - 120000) : null;
        throw new Error(`tester no container falhou (${run.status ?? "?"})${hint ? ` | detalhe: ${hint}` : ""} | ${run.out}`);
    }
    const confirmSec = Math.max(5, Number(tester.startConfirmSec ?? 45) || 45);
    const logsDirHost = mapContainerPathToHost(`${mt5InstallRootContainer}/logs`, dockerDir) || undefined;
    const started = await waitForTesterStartInContainer(dockerDir, serviceName, mt5InstallRootContainer, runId, confirmSec, logsDirHost);
    if (!started.ok) {
        throw new Error(`tester no container nao confirmou inicio em ${confirmSec}s (runId=${runId}) | ${started.detail}`);
    }
    const copiedLogs = [];
    if (hostMapped) {
        const runDirHost = mapContainerPathToHost(runDirContainer, dockerDir);
        const logBase = mt5DataRootHost || runDirHost || "";
        if (runDirHost && logBase) {
            ensureDir(runDirHost);
            const logDirs = [
                path.join(logBase, "Logs"),
                path.join(logBase, "logs"),
                path.join(logBase, "Tester", "Logs"),
                path.join(logBase, "Tester", "logs"),
                path.join(logBase, "MQL5", "Logs"),
                path.join(logBase, "MQL5", "logs"),
                path.join(logBase, "MQL5", "Tester", "Logs"),
                path.join(logBase, "MQL5", "Tester", "logs")
            ];
            for (const dir of logDirs) {
                const latest = pickLatestLog(dir, 0);
                const copied = copyIfExists(latest, runDirHost);
                if (copied)
                    copiedLogs.push(copied);
            }
        }
    }
    let meshLines = [];
    for (let i = 0; i < 5; i++) {
        meshLines = collectContainerRecentLogLines(dockerDir, serviceName, mt5DataRootContainer);
        if (meshLines.length)
            break;
        await new Promise((resolve) => setTimeout(resolve, 700));
    }
    const summary = summarizeTesterLines(meshLines);
    return {
        runDir: runDirContainer,
        iniPath: iniPathContainer,
        setPath: setPathContainer,
        reportPath: `${mt5DataRootContainer}/${reportDir}/${reportFile}`,
        copiedReport: undefined,
        copiedLogs,
        terminalLogPath: undefined,
        summary
    };
}
function buildDefaultSyncDirs(sourceMql5) {
    const out = new Set(["Profiles/Templates", "Profiles/Tester", "Presets"]);
    const filesRoot = path.join(sourceMql5, "Files");
    if (!fs.existsSync(filesRoot) || !fs.statSync(filesRoot).isDirectory()) {
        return Array.from(out);
    }
    const repos = fs.readdirSync(filesRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const repo of repos) {
        const repoPath = path.join(filesRoot, repo.name);
        const children = fs.readdirSync(repoPath, { withFileTypes: true }).filter((e) => e.isDirectory());
        for (const child of children) {
            const name = child.name;
            // Mantem pacote original em Files/<repo>/<module> para EAs que descobrem contratos via FileOpen.
            if ((name.startsWith("EXP-") || name.startsWith("IND-") || name.startsWith("SRV-"))
                && fs.existsSync(path.join(repoPath, name))
                && fs.statSync(path.join(repoPath, name)).isDirectory()) {
                out.add(`Files/${repo.name}/${name}`);
            }
            if (name.startsWith("EXP-") && fs.existsSync(path.join(sourceMql5, "Experts", name))) {
                out.add("Experts/" + name);
            }
            if (name.startsWith("IND-") && fs.existsSync(path.join(sourceMql5, "Indicators", name))) {
                out.add("Indicators/" + name);
            }
        }
    }
    // Tambem detecta modulos diretos em Experts/Indicators (sem depender de Files/*).
    const expertsRoot = path.join(sourceMql5, "Experts");
    if (fs.existsSync(expertsRoot) && fs.statSync(expertsRoot).isDirectory()) {
        for (const e of fs.readdirSync(expertsRoot, { withFileTypes: true })) {
            if (e.isDirectory() && e.name.startsWith("EXP-"))
                out.add("Experts/" + e.name);
        }
    }
    const indicatorsRoot = path.join(sourceMql5, "Indicators");
    if (fs.existsSync(indicatorsRoot) && fs.statSync(indicatorsRoot).isDirectory()) {
        for (const e of fs.readdirSync(indicatorsRoot, { withFileTypes: true })) {
            if (e.isDirectory() && e.name.startsWith("IND-"))
                out.add("Indicators/" + e.name);
        }
    }
    // fallback minimo para manter operacao quando nenhum modulo tipado for encontrado.
    if (!Array.from(out).some((d) => d.startsWith("Experts/") || d.startsWith("Indicators/"))) {
        if (fs.existsSync(path.join(sourceMql5, "Experts")))
            out.add("Experts");
        if (fs.existsSync(path.join(sourceMql5, "Indicators")))
            out.add("Indicators");
    }
    return Array.from(out);
}
export function syncWorkspaceMql5ToContainer(config) {
    const dockerDir = path.resolve(config.dockerDir);
    const up = runDockerComposeSync(dockerDir, ["up", "-d"]);
    if (!up.ok)
        throw new Error(up.out || "docker compose up falhou");
    const serviceName = resolveDockerServiceName(dockerDir, config.serviceName);
    const mt5RootContainer = detectContainerMt5DataRoot(dockerDir, serviceName);
    const mt5RootHost = mapContainerPathToHost(mt5RootContainer, dockerDir);
    const sourceData = resolveDataPathWsl(config.sourceDataPath);
    const sourceMql5 = path.join(sourceData, "MQL5");
    if (!fs.existsSync(sourceMql5)) {
        throw new Error(`MQL5 de origem ausente: ${sourceMql5}`);
    }
    const defaultDirs = buildDefaultSyncDirs(sourceMql5);
    const wanted = (config.dirs && config.dirs.length ? config.dirs : defaultDirs)
        .map((d) => d.trim())
        .filter(Boolean);
    const existing = wanted.filter((dir) => {
        const src = path.join(sourceMql5, dir);
        return fs.existsSync(src) && fs.statSync(src).isDirectory();
    });
    if (!existing.length)
        return { syncedDirs: [], mt5RootContainer };
    if (mt5RootHost) {
        try {
            const targetMql5 = path.join(mt5RootHost, "MQL5");
            ensureDir(targetMql5);
            for (const dir of existing) {
                const src = path.join(sourceMql5, dir);
                const dst = path.join(targetMql5, dir);
                ensureDir(path.dirname(dst));
                // Evita conflito arquivo<->diretorio em sincronizacoes repetidas.
                fs.rmSync(dst, { recursive: true, force: true });
                fs.cpSync(src, dst, { recursive: true, dereference: true, force: true });
            }
            return { syncedDirs: existing, mt5RootContainer };
        }
        catch {
            // Fallback below: copy via docker exec stream when host bind path is not writable.
        }
    }
    const sourceQuoted = shQuote(sourceMql5);
    const targetQuoted = shQuote(`${mt5RootContainer}/MQL5`);
    const dirsQuoted = existing.map((d) => shQuote(d)).join(" ");
    const rmQuoted = existing.map((d) => shQuote(`${mt5RootContainer}/MQL5/${d}`)).join(" ");
    const cmd = [
        "set -euo pipefail",
        `tar -C ${sourceQuoted} -chf - ${dirsQuoted} | docker compose exec -T -u root ${serviceName} sh -lc "mkdir -p ${targetQuoted}; rm -rf ${rmQuoted}; tar -C ${targetQuoted} -xf -"`
    ].join("; ");
    const rs = spawnSync("bash", ["-lc", cmd], { cwd: dockerDir, encoding: "utf8" });
    if (rs.status !== 0) {
        const out = `${rs.stdout || ""}${rs.stderr || ""}`.trim();
        throw new Error(out || "falha ao sincronizar MQL5 para container");
    }
    const syncUser = detectContainerWineUser(dockerDir, serviceName) || "abc";
    const chownCmd = `chown -R ${syncUser}:${syncUser} ${targetQuoted} || true`;
    runDockerComposeSync(dockerDir, ["exec", "-T", "-u", "root", serviceName, "sh", "-lc", chownCmd]);
    return { syncedDirs: existing, mt5RootContainer };
}
