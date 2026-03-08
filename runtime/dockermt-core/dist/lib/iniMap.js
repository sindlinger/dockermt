function normalizeName(v) {
    return String(v || "").trim().toLowerCase();
}
function detectNewline(text) {
    return text.includes("\r\n") ? "\r\n" : "\n";
}
function splitLines(text) {
    return text ? text.split(/\r?\n/) : [];
}
function isSectionHeader(line) {
    return /^\s*\[.+\]\s*$/.test(line);
}
function sectionNameFromHeader(line) {
    const m = line.match(/^\s*\[(.+)\]\s*$/);
    return m ? m[1].trim() : "";
}
function sectionRanges(lines, sectionName) {
    const target = normalizeName(sectionName);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (!isSectionHeader(lines[i]))
            continue;
        if (normalizeName(sectionNameFromHeader(lines[i])) !== target)
            continue;
        let end = lines.length;
        for (let j = i + 1; j < lines.length; j++) {
            if (isSectionHeader(lines[j])) {
                end = j;
                break;
            }
        }
        out.push({ start: i, end });
    }
    return out;
}
function removeKeyFromRange(lines, range, key) {
    const targetKey = normalizeName(key);
    for (let i = range.end - 1; i > range.start; i--) {
        const line = lines[i];
        const eq = line.indexOf("=");
        if (eq < 0)
            continue;
        const k = normalizeName(line.slice(0, eq));
        if (k === targetKey)
            lines.splice(i, 1);
    }
}
function insertKeyInRange(lines, range, key, value) {
    lines.splice(range.end, 0, `${key}=${value}`);
}
export function readIniValue(text, section, key) {
    const lines = splitLines(text);
    const ranges = sectionRanges(lines, section);
    if (!ranges.length)
        return null;
    const targetKey = normalizeName(key);
    let found = null;
    for (const range of ranges) {
        for (let i = range.start + 1; i < range.end; i++) {
            const line = lines[i];
            const eq = line.indexOf("=");
            if (eq < 0)
                continue;
            const k = normalizeName(line.slice(0, eq));
            if (k !== targetKey)
                continue;
            found = line.slice(eq + 1).trim();
        }
    }
    return found;
}
export function applyIniPatch(text, patch) {
    const newline = detectNewline(text);
    const lines = splitLines(text);
    for (const [section, keyMap] of Object.entries(patch)) {
        for (const [key, raw] of Object.entries(keyMap)) {
            if (raw === undefined || raw === "")
                continue;
            if (raw === null) {
                const rangesToRemove = sectionRanges(lines, section);
                if (!rangesToRemove.length)
                    continue;
                for (let i = rangesToRemove.length - 1; i >= 0; i--) {
                    removeKeyFromRange(lines, rangesToRemove[i], key);
                }
                continue;
            }
            const value = String(raw);
            let ranges = sectionRanges(lines, section);
            if (!ranges.length) {
                if (lines.length && lines[lines.length - 1].trim() !== "")
                    lines.push("");
                lines.push(`[${section}]`);
                lines.push(`${key}=${value}`);
                continue;
            }
            for (let i = ranges.length - 1; i >= 0; i--) {
                removeKeyFromRange(lines, ranges[i], key);
            }
            ranges = sectionRanges(lines, section);
            insertKeyInRange(lines, ranges[0], key, value);
        }
    }
    const out = lines.join(newline);
    return out.endsWith(newline) ? out : out + newline;
}
