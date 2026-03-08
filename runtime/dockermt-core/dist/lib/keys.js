const MOD_MAP = {
    ALT: "%",
    CTRL: "^",
    CONTROL: "^",
    SHIFT: "+",
    WIN: "#",
    WINDOWS: "#",
    META: "#"
};
const KEY_MAP = {
    ENTER: "{ENTER}",
    RETURN: "{ENTER}",
    ESC: "{ESC}",
    ESCAPE: "{ESC}",
    TAB: "{TAB}",
    SPACE: "{SPACE}",
    SPACEBAR: "{SPACE}",
    BACKSPACE: "{BACKSPACE}",
    BS: "{BACKSPACE}",
    DELETE: "{DELETE}",
    DEL: "{DELETE}",
    INSERT: "{INSERT}",
    INS: "{INSERT}",
    HOME: "{HOME}",
    END: "{END}",
    LEFT: "{LEFT}",
    RIGHT: "{RIGHT}",
    UP: "{UP}",
    DOWN: "{DOWN}",
    "LEFT ARROW": "{LEFT}",
    "RIGHT ARROW": "{RIGHT}",
    "UP ARROW": "{UP}",
    "DOWN ARROW": "{DOWN}",
    PGUP: "{PGUP}",
    "PAGE UP": "{PGUP}",
    PAGEUP: "{PGUP}",
    PGDN: "{PGDN}",
    "PAGE DOWN": "{PGDN}",
    PAGEDOWN: "{PGDN}",
    "+": "{+}",
    "-": "{-}"
};
function normalizeKeyLabel(input) {
    let key = input.trim();
    if (!key)
        return "";
    const lower = key.toLowerCase();
    const orIdx = lower.indexOf(" or ");
    if (orIdx >= 0)
        key = key.slice(0, orIdx);
    if (key.includes("/"))
        key = key.split("/")[0] ?? key;
    return key.trim();
}
function normalizeSpaces(input) {
    return input.replace(/\s+/g, " ").trim();
}
function encodeBaseKey(raw) {
    const cleaned = normalizeSpaces(normalizeKeyLabel(raw));
    if (!cleaned)
        return "";
    const up = cleaned.toUpperCase();
    if (up.startsWith("NUMPAD")) {
        const num = up.replace(/[^0-9]/g, "");
        if (num)
            return `{NUMPAD${num}}`;
    }
    if (KEY_MAP[up])
        return KEY_MAP[up];
    if (/^F\d{1,2}$/.test(up))
        return `{${up}}`;
    if (up.length === 1)
        return up;
    return `{${up}}`;
}
function encodeCombo(combo) {
    const cleaned = normalizeSpaces(normalizeKeyLabel(combo));
    if (!cleaned)
        return "";
    if (cleaned.startsWith("{") && cleaned.endsWith("}"))
        return cleaned;
    const parts = cleaned.split("+").map((p) => normalizeSpaces(p)).filter(Boolean);
    let mods = "";
    const keys = [];
    for (const part of parts) {
        const up = part.toUpperCase();
        if (MOD_MAP[up]) {
            mods += MOD_MAP[up];
        }
        else {
            keys.push(part);
        }
    }
    if (!keys.length)
        return "";
    if (keys.length === 1)
        return mods + encodeBaseKey(keys[0]);
    return keys.map((k) => mods + encodeBaseKey(k)).join("");
}
export function toSendKeysTokens(keys) {
    const out = [];
    for (const key of keys) {
        const token = encodeCombo(key);
        if (token)
            out.push(token);
    }
    return out;
}
