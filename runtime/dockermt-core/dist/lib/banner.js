import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const RESET = "\x1b[0m";
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const PALETTE = {
    default: {
        bg: "\x1b[46m",
        fg: "\x1b[97m"
    },
    container: {
        bg: "\x1b[43m",
        fg: "\x1b[30m"
    }
};
function visibleLen(s) {
    return s.replace(ANSI_RE, "").length;
}
function pad(s, width) {
    const len = visibleLen(s);
    if (len >= width)
        return s;
    return s + " ".repeat(width - len);
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
export function renderBanner(opts) {
    const version = resolveVersion();
    const title = "CommandMetaTrader";
    const variant = opts.variant ?? "default";
    const colors = PALETTE[variant] ?? PALETTE.default;
    const lines = [
        `${title} • ${opts.label} v${version}`,
        `Socket: ${opts.socket}`
    ];
    const maxLine = Math.max(...lines.map((l) => l.length)) + 2;
    const termWidth = Number.isFinite(process.stdout.columns) ? process.stdout.columns : 0;
    const width = Math.max(maxLine, termWidth);
    const out = [];
    for (const line of lines) {
        out.push(`${colors.bg}${colors.fg}${pad(" " + line + " ", width)}${RESET}`);
    }
    return out.join("\n") + "\n";
}
