import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const PANEL_BG = "\x1b[46m";
const WHITE = "\x1b[97m";
const RESET = "\x1b[0m";
// CMDMT_CMD_COLOR presets (use in env): gray90, gray80, gray70, gray60, gray50,
// gray40, gray30, gray20, gray10, white, black, yellow, cyan, green, magenta, red.
const COLOR_PRESETS = {
    gray90: "e5e5e5",
    gray80: "cccccc",
    gray70: "b3b3b3",
    gray60: "999999",
    gray50: "808080",
    gray40: "666666",
    gray30: "4d4d4d",
    gray20: "333333",
    gray10: "1a1a1a",
    white: "ffffff",
    black: "000000",
    yellow: "ffd54f",
    cyan: "4dd0e1",
    green: "81c784",
    magenta: "ce93d8",
    red: "ef9a9a"
};
function resolveCmdColor() {
    const env = process.env.CMDMT_CMD_COLOR?.trim();
    if (env) {
        const key = env.toLowerCase();
        const preset = COLOR_PRESETS[key] || COLOR_PRESETS[key.replace("grey", "gray")];
        if (preset) {
            const r = parseInt(preset.slice(0, 2), 16);
            const g = parseInt(preset.slice(2, 4), 16);
            const b = parseInt(preset.slice(4, 6), 16);
            return `\x1b[38;2;${r};${g};${b}m`;
        }
        // Accept "#RRGGBB" or "R,G,B"
        const hex = env.replace(/^#/, "");
        if (/^[0-9a-fA-F]{6}$/.test(hex)) {
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            return `\x1b[38;2;${r};${g};${b}m`;
        }
        const rgb = env.split(",").map((v) => Number(v.trim()));
        if (rgb.length === 3 && rgb.every((n) => Number.isFinite(n))) {
            const [r, g, b] = rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))));
            return `\x1b[38;2;${r};${g};${b}m`;
        }
    }
    const colorterm = (process.env.COLORTERM || "").toLowerCase();
    if (colorterm.includes("truecolor") || colorterm.includes("24bit")) {
        // Darker gray for truecolor terminals
        return "\x1b[38;2;105;105;105m";
    }
    // Fallback: normal white (slightly dimmer than bright white on 16-color)
    return "\x1b[37m";
}
function resolveVersion() {
    const env = process.env.npm_package_version?.trim();
    if (env)
        return env;
    try {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const pkgPath = path.resolve(here, "../../package.json");
        const raw = fs.readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(raw);
        if (pkg.version)
            return String(pkg.version);
    }
    catch {
        // ignore
    }
    return "dev";
}
const CMD = resolveCmdColor();
const VERSION = resolveVersion();
function resolveCliName() {
    const brandRaw = (process.env.CMDMT_BRAND || "").trim().toLowerCase();
    return brandRaw === "dockermt" ? "dockermt" : "cmdmt";
}
const SECTIONS = [
    { title: "destaque", items: ["compile", "add", "rm", "run", "watch", "auto", "inspect", "debug", "log"] },
    {
        title: "basic",
        items: ["ping", "add", "rm", "watch", "auto", "inspect", "debug", "log", "compile", "addons", "use", "ctx", "help"]
    },
    { title: "chart", items: ["open", "close", "list", "closeall", "redraw", "detachall", "find"] },
    { title: "template", items: ["apply", "save", "saveea", "savechart"] },
    { title: "inspect", items: ["total", "name", "handle", "get", "release", "find"] },
    { title: "expert", items: ["find", "run", "test", "oneshot"] },
    { title: "tester", items: ["run", "test", "oneshot"] },
    { title: "hotkey", items: ["list", "set", "del", "clear"] },
    { title: "auto", items: ["ls", "add", "rm", "show", "run"] },
    { title: "script", items: ["run"] },
    { title: "data", items: ["import"] },
    { title: "trade", items: ["buy", "sell", "list", "closeall"] },
    { title: "global", items: ["set", "get", "del", "delprefix", "list"] },
    { title: "input", items: ["list", "set"] },
    { title: "snapshot", items: ["save", "apply", "list"] },
    { title: "object", items: ["list", "delete", "delprefix", "move", "create"] },
    { title: "screen", items: ["shot", "sweep", "drop"] },
    { title: "addons", items: ["init", "add", "expert", "indicator", "library"] },
    { title: "other", items: ["cmd", "raw", "json", "quit"] }
];
function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLen(s) {
    return s.replace(ANSI_RE, "").length;
}
function pad(s, width) {
    const len = visibleLen(s);
    if (len >= width)
        return s;
    return s + " ".repeat(width - len);
}
function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size)
        out.push(items.slice(i, i + size));
    return out;
}
function renderGroupBlock(group, nameWidth, subCols, subWidth, nameGap, subGap, colWidth) {
    const rows = chunk(group.items, subCols);
    const lines = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const name = i === 0 ? pad(group.title, nameWidth) : " ".repeat(nameWidth);
        let line = name + " ".repeat(nameGap);
        for (let c = 0; c < subCols; c++) {
            const raw = row[c] ?? "";
            const item = raw ? `${CMD}${raw}${WHITE}` : "";
            line += pad(item, subWidth);
            if (c < subCols - 1)
                line += " ".repeat(subGap);
        }
        lines.push(pad(line, colWidth));
    }
    return lines;
}
export function renderHelp() {
    const cliName = resolveCliName();
    const width = Math.max(process.stdout.columns ?? 120, 80);
    const divider = " │ ";
    const cols = 2;
    const colWidth = Math.floor((width - divider.length * (cols - 1)) / cols);
    const nameWidth = Math.max(...SECTIONS.map((s) => s.title.length));
    const subWidth = Math.max(...SECTIONS.flatMap((s) => s.items.map((i) => i.length)));
    const nameGap = 2;
    const subGap = 2;
    const available = colWidth - nameWidth - nameGap;
    const subCols = clamp(Math.floor((available + subGap) / (subWidth + subGap)), 1, 5);
    const mid = Math.ceil(SECTIONS.length / cols);
    const leftGroups = SECTIONS.slice(0, mid);
    const rightGroups = SECTIONS.slice(mid);
    const buildColumn = (groups) => {
        const out = [];
        for (let i = 0; i < groups.length; i++) {
            out.push(...renderGroupBlock(groups[i], nameWidth, subCols, subWidth, nameGap, subGap, colWidth));
            if (i < groups.length - 1)
                out.push(" ".repeat(colWidth));
        }
        return out;
    };
    const leftLines = buildColumn(leftGroups);
    const rightLines = buildColumn(rightGroups);
    const maxLines = Math.max(leftLines.length, rightLines.length);
    const lines = [];
    const title = `${cliName} v${VERSION} - comandos principais (socket)`;
    lines.push(`${PANEL_BG}${WHITE}${pad(" " + title + " ", width)}${RESET}`);
    for (let i = 0; i < maxLines; i++) {
        const left = leftLines[i] ?? " ".repeat(colWidth);
        const right = rightLines[i] ?? " ".repeat(colWidth);
        const line = left + divider + right;
        lines.push(`${PANEL_BG}${WHITE}${pad(line, width)}${RESET}`);
    }
    lines.push(`${PANEL_BG}${" ".repeat(width)}${RESET}`);
    return lines;
}
const EXAMPLES = {
    ping: [{ title: "ping", lines: ["ping"] }],
    debug: [{ title: "debug", lines: ["debug hello world", "debug -i ZigZag", "debug -e MyEA"] }],
    compile: [{ title: "compile", lines: ["compile", "compile C:\\\\caminho\\\\arquivo.mq5"] }],
    use: [{ title: "use", lines: ["use EURUSD M5", "use GBPUSD H1"] }],
    ctx: [{ title: "ctx", lines: ["ctx"] }],
    help: [{ title: "help", lines: ["help", "examples", "examples chart"] }],
    watch: [
        { title: "watch", lines: ["watch -i ZigZag", "watch -e MyEA", "watch clear", "watch"] }
    ],
    add: [
        {
            title: "add",
            lines: [
                "add -i ZigZag sub=1 --params depth=12 deviation=5 backstep=3",
                "add -i EURUSD H1 \"Bulls Power\"",
                "add -e MyEA base.tpl --params lots=0.1",
                "watch -i ZigZag",
                "add sub=1 --params depth=12 deviation=5 backstep=3"
            ]
        }
    ],
    rm: [
        {
            title: "rm",
            lines: [
                "rm -i ZigZag sub=1",
                "rm -i EURUSD H1 0",
                "rm -e EURUSD H1",
                "watch -i ZigZag",
                "rm sub=1"
            ]
        }
    ],
    inspect: [
        {
            title: "indicator",
            lines: [
                "inspect -i total",
                "inspect -i name 0",
                "inspect -i handle ZigZag sub=1",
                "inspect -i get ZigZag sub=1",
                "inspect -i release 123456",
                "watch -i ZigZag",
                "inspect get"
            ]
        },
        {
            title: "expert",
            lines: ["inspect -e find MyEA", "inspect -e MyEA"]
        }
    ],
    addons: [
        {
            title: "addons",
            lines: [
                "addons init",
                "addons add \"/mnt/c/caminho/Files/Ex-Empty\"",
                "addons add --mode sync \"/mnt/c/caminho/Files/Ex-Empty\"",
                "addons expert \"C:\\caminho\\MeuEA\"",
                "addons expert --mode sync \"C:\\caminho\\MeuEA\"",
                "addons indicator \"/mnt/c/caminho/MeuIndicador\"",
                "addons indicator --mode sync \"/mnt/c/caminho/MeuIndicador\"",
                "addons library \"/mnt/c/caminho/MinhaLib\""
            ]
        }
    ],
    log: [
        { title: "log", lines: ["log", "log 300", "log --tail 1000"] }
    ],
    hotkey: [
        { title: "list", lines: ["hotkey list"] },
        { title: "set", lines: ["hotkey set ALT+1=INDICATOR", "hotkey set ALT+2 command"] },
        { title: "del", lines: ["hotkey del ALT+1"] },
        { title: "clear", lines: ["hotkey clear"] }
    ],
    auto: [
        { title: "ls", lines: ["auto ls", "auto --code M1,M2", "auto M1 M2"] },
        { title: "add", lines: ["auto add --code M1,M2 --name @new_order", "auto add --cmd \"screen shot EURUSD M5\" --name @screenshot"] },
        { title: "rm", lines: ["auto rm --name @new_order"] },
        { title: "show", lines: ["auto show @new_order", "auto @new_order"] },
        { title: "run", lines: ["auto run --keys \"ALT+6,ENTER\"", "auto run @new_order", `${resolveCliName()} @new_order`] }
    ],
    chart: [
        { title: "open", lines: ["chart open", "chart open EURUSD H1"] },
        { title: "close", lines: ["chart close", "chart close EURUSD H1"] },
        { title: "list", lines: ["chart list"] },
        { title: "closeall", lines: ["chart closeall"] },
        { title: "redraw", lines: ["chart redraw", "chart redraw EURUSD H1"] },
        { title: "detachall", lines: ["chart detachall", "chart detachall EURUSD H1"] },
        { title: "find", lines: ["chart find PRICE", "chart find EURUSD H1 PRICE"] }
    ],
    template: [
        { title: "apply", lines: ["template apply meu.tpl", "template apply EURUSD H1 meu.tpl"] },
        { title: "save", lines: ["template save snap.tpl", "template save EURUSD H1 snap.tpl"] },
        { title: "saveea", lines: ["template saveea MyEA out.tpl base.tpl lots=0.1"] },
        { title: "savechart", lines: ["template savechart 123456 snap.tpl"] }
    ],
    expert: [
        { title: "find", lines: ["expert find MyEA"] },
        { title: "run", lines: ["expert run MyEA --params lots=0.1", "expert run M5 MyEA base.tpl --params lots=0.1"] },
        { title: "test", lines: ["expert test MyEA --params lots=0.1", "expert test M5 MyEA --params lots=0.1"] },
        { title: "oneshot", lines: ["expert oneshot M5 MyEA base.tpl --params lots=0.1"] }
    ],
    script: [{ title: "run", lines: ["script run MeuScript.tpl", "script run EURUSD H1 MeuScript.tpl"] }],
    data: [
        {
            title: "import",
            lines: [
                "data import rates C:\\\\Users\\\\pichau\\\\Documents\\\\EURUSD_H1_200809101700_202510212200.csv EURUSD_H1_CSV H1",
                "data import ticks C:\\\\Users\\\\pichau\\\\Documents\\\\BTCUSD_Ticks_2024.01.01_2024.12.31.csv BTCUSD_TICKS_2024 --digits 1"
            ]
        }
    ],
    trade: [
        { title: "buy", lines: ["trade buy 0.1", "trade buy EURUSD 0.1"] },
        { title: "sell", lines: ["trade sell 0.1", "trade sell EURUSD 0.1"] },
        { title: "list", lines: ["trade list"] },
        { title: "closeall", lines: ["trade closeall"] }
    ],
    global: [
        { title: "set", lines: ["global set key value"] },
        { title: "get", lines: ["global get key"] },
        { title: "del", lines: ["global del key"] },
        { title: "delprefix", lines: ["global delprefix pref_"] },
        { title: "list", lines: ["global list"] }
    ],
    input: [
        { title: "list", lines: ["input list"] },
        { title: "set", lines: ["input set name value"] }
    ],
    snapshot: [
        { title: "save", lines: ["snapshot save snap1"] },
        { title: "apply", lines: ["snapshot apply snap1"] },
        { title: "list", lines: ["snapshot list"] }
    ],
    object: [
        { title: "list", lines: ["object list"] },
        { title: "delete", lines: ["object delete OBJ_NAME"] },
        { title: "delprefix", lines: ["object delprefix OBJ_"] },
        { title: "move", lines: ["object move OBJ_NAME 100 200"] },
        { title: "create", lines: ["object create OBJ_NAME RECT 100 100 200 200"] }
    ],
    screen: [
        { title: "shot", lines: ["screen shot", "screen shot EURUSD H1"] },
        { title: "sweep", lines: ["screen sweep", "screen sweep 5"] },
        { title: "drop", lines: ["screen drop"] }
    ],
    cmd: [
        { title: "cmd", lines: ["cmd PING", "cmd ATTACH_IND_FULL EURUSD H1 ZigZag 1 depth=12"] }
    ],
    raw: [{ title: "raw", lines: ["raw PING|", "raw ATTACH_IND_FULL|EURUSD|H1|ZigZag|1|"] }],
    json: [{ title: "json", lines: ["json {\"type\":\"PING\"}", "json {\"type\":\"CMD\",\"params\":[\"PING\"]}"] }],
    quit: [{ title: "quit", lines: ["quit", "exit"] }]
};
function renderIndex() {
    const items = [
        "examples ping",
        "examples debug",
        "examples watch",
        "examples add",
        "examples rm",
        "examples inspect",
        "examples log",
        "examples hotkey",
        "examples auto",
        "examples compile",
        "examples use",
        "examples ctx",
        "examples help",
        "examples chart",
        "examples template",
        "examples expert",
        "examples script",
        "examples trade",
        "examples global",
        "examples input",
        "examples snapshot",
        "examples object",
        "examples screen",
        "examples cmd",
        "examples raw",
        "examples json",
        "examples quit"
    ];
    return items.join("\n");
}
function formatGroups(groups, only) {
    const lines = [];
    for (const group of groups) {
        if (only && group.title !== only)
            continue;
        lines.push(`${group.title}:`);
        for (const line of group.lines)
            lines.push(`  ${line}`);
        lines.push("");
    }
    if (!lines.length)
        return "";
    if (lines[lines.length - 1] === "")
        lines.pop();
    return lines.join("\n");
}
export function renderExamples(cmd) {
    const input = (cmd ?? "").trim();
    if (!input)
        return renderIndex();
    const lower = input.toLowerCase();
    const parts = lower.split(/\s+/).filter(Boolean);
    let command = parts[0] ?? "";
    let sub = parts.slice(1).join(" ");
    if (command.includes(":") && !sub) {
        const [c, s] = command.split(":", 2);
        command = c;
        sub = s ?? "";
    }
    const groups = EXAMPLES[command];
    if (!groups)
        return renderIndex();
    const output = formatGroups(groups, sub || undefined);
    return output || renderIndex();
}
