export const AUTO_SECTIONS = [
    {
        prefix: "C",
        title: "Chart",
        items: [
            { hotkey: "Left Arrow", desc: "Scroll chart to the left." },
            { hotkey: "Right Arrow", desc: "Scroll chart to the right." },
            { hotkey: "Up Arrow", desc: "Fast scroll left; fixed scale: scroll up." },
            { hotkey: "Down Arrow", desc: "Fast scroll right; fixed scale: scroll down." },
            { hotkey: "NumPad 5", desc: "Restore automatic chart vertical scale." },
            { hotkey: "Page Up", desc: "Fast chart scroll to the left." },
            { hotkey: "Page Down", desc: "Fast chart scroll to the right." },
            { hotkey: "Home", desc: "Move chart to the start point." },
            { hotkey: "End", desc: "Move chart to the end point." },
            { hotkey: "-", desc: "Zoom out chart." },
            { hotkey: "+", desc: "Zoom in chart." },
            { hotkey: "Delete", desc: "Delete all selected graphical objects." },
            { hotkey: "Backspace", desc: "Delete the latest objects imposed to a chart." },
            { hotkey: "Enter", desc: "Open/close fast navigation bar." },
            { hotkey: "F2", desc: "Open the Task Manager." },
            { hotkey: "F7", desc: "EA properties for the attached chart." },
            { hotkey: "F8", desc: "Chart setup window." },
            { hotkey: "F12", desc: "Move chart by one bar to the left." },
            { hotkey: "Shift+F12", desc: "Move chart by one bar to the right." },
            { hotkey: "Shift+F5", desc: "Switch to the previous profile." },
            { hotkey: "Alt+1", desc: "Show chart as bars." },
            { hotkey: "Alt+2", desc: "Show chart as candlesticks." },
            { hotkey: "Alt+3", desc: "Show chart as broken line." },
            { hotkey: "Alt+W", desc: "Open chart managing window." },
            { hotkey: "Alt+Backspace or Ctrl+Z", desc: "Cancel object deletion." },
            { hotkey: "Ctrl+A", desc: "Reset height of all indicator windows." },
            { hotkey: "Ctrl+B", desc: "Open the Objects List window." },
            { hotkey: "Ctrl+F", desc: "Enable Crosshair." },
            { hotkey: "Ctrl+G", desc: "Show/hide grid." },
            { hotkey: "Ctrl+H", desc: "Show/hide OHLC line." },
            { hotkey: "Ctrl+I", desc: "Open the Indicators List window." },
            { hotkey: "Ctrl+K", desc: "Show/hide real volumes." },
            { hotkey: "Ctrl+L", desc: "Show/hide volumes." },
            { hotkey: "Ctrl+P", desc: "Print the chart." },
            { hotkey: "Ctrl+S", desc: "Save chart as CSV/PRN/HTM." },
            { hotkey: "Ctrl+W or Ctrl+F4", desc: "Close the current chart window." },
            { hotkey: "Ctrl+Y", desc: "Show/hide period separators." },
            { hotkey: "Ctrl+F5", desc: "Switch to the next profile." },
            { hotkey: "Ctrl+F6", desc: "Activate the previous chart window." },
            { hotkey: "Ctrl+Shift+F6", desc: "Activate the next chart window." }
        ]
    },
    {
        prefix: "M",
        title: "Market Watch",
        items: [
            { hotkey: "F9", desc: "Open the New Order window." },
            { hotkey: "Space/Tab", desc: "Switch between tabs (Symbols/Details/Trading/Ticks)." },
            { hotkey: "A", desc: "Auto arrange columns in the Symbols tab." },
            { hotkey: "G", desc: "Show/hide grid." }
        ]
    },
    {
        prefix: "N",
        title: "Navigator",
        items: [
            { hotkey: "Enter", desc: "Open selected item (account/EA/indicator/script)." },
            { hotkey: "Insert", desc: "Open new account (Accounts) or trade server." },
            { hotkey: "Delete", desc: "Delete selected account/EA/indicator/script." },
            { hotkey: "G", desc: "Show/hide grid in Favorites tab." }
        ]
    },
    {
        prefix: "D",
        title: "Data Window",
        items: [
            { hotkey: "Ctrl+C", desc: "Copy data to clipboard." },
            { hotkey: "A", desc: "Auto size columns." },
            { hotkey: "G", desc: "Show/hide grid." }
        ]
    },
    {
        prefix: "T",
        title: "Toolbox",
        items: [
            { hotkey: "F9", desc: "Open the New Order window." },
            { hotkey: "Enter", desc: "View selected item (news/email/alert)." },
            { hotkey: "Insert", desc: "Create new email or alert." },
            { hotkey: "Delete", desc: "Delete selected email or alert." },
            { hotkey: "Space", desc: "Unwrap branch or enable/disable alert." },
            { hotkey: "C", desc: "Copy selected journal line to clipboard." },
            { hotkey: "D", desc: "Download selected application (Code Base)." },
            { hotkey: "R", desc: "Show/hide news categories column." },
            { hotkey: "A", desc: "Auto size columns." },
            { hotkey: "G", desc: "Show/hide grid." }
        ]
    },
    {
        prefix: "A",
        title: "Common Actions",
        items: [
            { hotkey: "Esc", desc: "Close dialog windows." },
            { hotkey: "F1", desc: "Open the Userguide." },
            { hotkey: "F3", desc: "Open the Global Variables window." },
            { hotkey: "F4", desc: "Start MetaEditor." },
            { hotkey: "F6", desc: "Open the Tester window (attached EA)." },
            { hotkey: "F9", desc: "Open the New Order window." },
            { hotkey: "F10", desc: "Open the Quotes window." },
            { hotkey: "F11", desc: "Toggle fullscreen mode." },
            { hotkey: "Alt+F4", desc: "Close the platform." },
            { hotkey: "Ctrl+C or Ctrl+Insert", desc: "Copy to clipboard." },
            { hotkey: "Ctrl+D", desc: "Open/close the Data Window." },
            { hotkey: "Ctrl+E", desc: "Allow/prohibit Expert Advisors." },
            { hotkey: "Ctrl+M", desc: "Open/close the Market Watch window." },
            { hotkey: "Ctrl+N", desc: "Open/close the Navigator window." },
            { hotkey: "Ctrl+O", desc: "Open the Settings window." },
            { hotkey: "Ctrl+R", desc: "Open/close the Tester window." },
            { hotkey: "Ctrl+T", desc: "Open/close the Toolbox window." },
            { hotkey: "Ctrl+F9", desc: "Focus Trade tab in Toolbox." }
        ]
    }
];
export function normalizeAutoMacroName(name) {
    const trimmed = name.trim();
    if (!trimmed)
        return "";
    return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}
export function parseAutoCodes(raw) {
    if (!raw)
        return [];
    return raw
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
}
export function buildAutoEntries() {
    const entries = [];
    const index = new Map();
    for (const section of AUTO_SECTIONS) {
        section.items.forEach((item, idx) => {
            const code = `${section.prefix}${idx + 1}`;
            const entry = {
                section: section.prefix,
                sectionTitle: section.title,
                code,
                hotkey: item.hotkey,
                desc: item.desc
            };
            entries.push(entry);
            index.set(code, entry);
        });
    }
    return { entries, index };
}
export function codesToHotkeys(codes) {
    const { index } = buildAutoEntries();
    return codes.map((code) => index.get(code)?.hotkey).filter(Boolean);
}
export function resolveAutoCodes(rawCodes, macros) {
    const { entries, index } = buildAutoEntries();
    const bySection = new Map();
    for (const entry of entries) {
        const list = bySection.get(entry.section) ?? [];
        list.push(entry.code);
        bySection.set(entry.section, list);
    }
    const out = [];
    const unknown = [];
    const expand = (tokenRaw) => {
        const token = tokenRaw.trim();
        if (!token)
            return;
        if (token.startsWith("@") && macros?.[token]) {
            const macro = macros[token];
            if (Array.isArray(macro)) {
                macro.forEach((c) => expand(c));
            }
            else {
                unknown.push(token);
            }
            return;
        }
        const up = token.toUpperCase();
        if (up.length === 1 && bySection.has(up)) {
            out.push(...(bySection.get(up) ?? []));
            return;
        }
        if (up.length === 2 && up[1] === "*" && bySection.has(up[0])) {
            out.push(...(bySection.get(up[0]) ?? []));
            return;
        }
        if (index.has(up)) {
            out.push(up);
            return;
        }
        unknown.push(token);
    };
    rawCodes.forEach(expand);
    const unique = Array.from(new Set(out));
    return { codes: unique, unknown };
}
export function formatAutoList(rawCodes, macros) {
    const { entries } = buildAutoEntries();
    const { codes, unknown } = rawCodes && rawCodes.length
        ? resolveAutoCodes(rawCodes, macros)
        : { codes: entries.map((e) => e.code), unknown: [] };
    const selected = entries.filter((e) => codes.includes(e.code));
    if (!selected.length) {
        const warn = unknown.length ? `unknown codes: ${unknown.join(", ")}` : "no codes selected";
        return warn;
    }
    const maxHotkey = Math.max(...selected.map((e) => e.hotkey.length), 8);
    const lines = [];
    for (const section of AUTO_SECTIONS) {
        const sectionEntries = selected.filter((e) => e.section === section.prefix);
        if (!sectionEntries.length)
            continue;
        lines.push(`${section.prefix} - ${section.title}`);
        for (const entry of sectionEntries) {
            const padded = entry.hotkey.padEnd(maxHotkey, " ");
            lines.push(`${entry.code} - ${padded} ${entry.desc}`);
        }
        lines.push("");
    }
    if (lines[lines.length - 1] === "")
        lines.pop();
    if (unknown.length) {
        lines.push("");
        lines.push(`unknown codes: ${unknown.join(", ")}`);
    }
    if (macros && Object.keys(macros).length) {
        lines.push("");
        lines.push("macros:");
        for (const name of Object.keys(macros).sort()) {
            const macro = macros[name];
            if (Array.isArray(macro)) {
                lines.push(`${name} = ${macro.join(",")}`);
            }
            else {
                lines.push(`${name} = cmd: ${macro.cmd}`);
            }
        }
    }
    return lines.join("\n");
}
