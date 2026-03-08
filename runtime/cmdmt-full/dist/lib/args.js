export function isTf(s) {
    if (!s)
        return false;
    const u = s.toUpperCase();
    return [
        "M1",
        "M2",
        "M3",
        "M4",
        "M5",
        "M6",
        "M10",
        "M12",
        "M15",
        "M20",
        "M30",
        "H1",
        "H2",
        "H3",
        "H4",
        "H6",
        "H8",
        "H12",
        "D1",
        "W1",
        "MN1"
    ].includes(u);
}
export function splitArgs(line) {
    const out = [];
    let cur = "";
    let quote = null;
    let esc = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (esc) {
            cur += ch;
            esc = false;
            continue;
        }
        if (ch === "\\") {
            esc = true;
            continue;
        }
        if (quote) {
            if (ch === quote) {
                quote = null;
            }
            else {
                cur += ch;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === " " || ch === "\t") {
            if (cur) {
                out.push(cur);
                cur = "";
            }
            continue;
        }
        cur += ch;
    }
    if (cur)
        out.push(cur);
    return out;
}
export function resolveSymTf(args, ctx, require = true) {
    const a = [...args];
    let sym;
    let tf;
    if (a.length >= 2 && isTf(a[1])) {
        sym = a[0];
        tf = a[1];
        a.splice(0, 2);
    }
    else if (a.length >= 1 && isTf(a[0]) && ctx.symbol) {
        sym = ctx.symbol;
        tf = a[0];
        a.splice(0, 1);
    }
    else if (ctx.symbol && ctx.tf) {
        sym = ctx.symbol;
        tf = ctx.tf;
    }
    if (!sym || !tf) {
        if (require)
            return null;
        return { sym: sym ?? "", tf: tf ?? "", rest: a };
    }
    return { sym, tf, rest: a };
}
export function parseSub(argList, ctx) {
    let sub = String(ctx.sub ?? 1);
    const a = [...argList];
    for (let i = 0; i < a.length; i++) {
        const tok = a[i];
        const low = tok.toLowerCase();
        if (low.startsWith("sub=")) {
            sub = tok.split("=", 2)[1] ?? sub;
            a.splice(i, 1);
            return { sub, rest: a };
        }
        if ((tok.startsWith("#") || tok.startsWith("@")) && /^\d+$/.test(tok.slice(1))) {
            sub = tok.slice(1);
            a.splice(i, 1);
            return { sub, rest: a };
        }
    }
    if (a.length >= 1 && /^\d+$/.test(a[a.length - 1])) {
        sub = a[a.length - 1];
        a.splice(a.length - 1, 1);
    }
    return { sub, rest: a };
}
