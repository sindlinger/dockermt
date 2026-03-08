import crypto from "node:crypto";
export function stableHash(input, length = 8) {
    return crypto.createHash("sha1").update(input).digest("hex").slice(0, length);
}
export function safeFileBase(input) {
    const cleaned = input
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+/, "")
        .replace(/_+$/, "");
    return cleaned || "item";
}
