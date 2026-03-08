import fs from "node:fs";
import path from "node:path";
import { isWindowsPath, toWslPath } from "./config.js";
function normalizeExpertRelName(relPath) {
    let rel = relPath.replace(/\\/g, "/");
    rel = rel.replace(/\.(mq5|ex5)$/i, "");
    return rel.replace(/\//g, "\\");
}
function findFileRecursive(root, fileName, maxDepth = 6) {
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
        const { dir, depth } = queue.shift();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            let isFile = entry.isFile();
            let isDir = entry.isDirectory();
            if (entry.isSymbolicLink()) {
                try {
                    const stat = fs.statSync(full);
                    if (stat.isFile())
                        isFile = true;
                    if (stat.isDirectory())
                        isDir = true;
                }
                catch {
                    // ignore broken symlink
                }
            }
            if (isFile && entry.name.toLowerCase() === fileName.toLowerCase()) {
                return full;
            }
            if (isDir && depth < maxDepth) {
                queue.push({ dir: full, depth: depth + 1 });
            }
        }
    }
    return null;
}
export function resolveExpertFromRunner(input, dataPath) {
    if (!dataPath || !input)
        return null;
    const base = path.join(toWslPath(dataPath), "MQL5", "Experts");
    const hasExt = /\.(mq5|ex5)$/i.test(input);
    const hasSeparators = input.includes("/") || input.includes("\\");
    const candidates = hasExt ? [input] : [`${input}.ex5`, `${input}.mq5`];
    if (hasSeparators) {
        const localRaw = isWindowsPath(input) ? toWslPath(input) : input;
        if (fs.existsSync(localRaw)) {
            if (localRaw.startsWith(base)) {
                const rel = path.relative(base, localRaw);
                const name = normalizeExpertRelName(rel);
                const mq5 = localRaw.toLowerCase().endsWith(".mq5") ? localRaw : undefined;
                const ex5 = localRaw.toLowerCase().endsWith(".ex5") ? localRaw : undefined;
                return { name, mq5, ex5 };
            }
            const name = normalizeExpertRelName(path.basename(localRaw));
            const mq5 = localRaw.toLowerCase().endsWith(".mq5") ? localRaw : undefined;
            const ex5 = localRaw.toLowerCase().endsWith(".ex5") ? localRaw : undefined;
            return { name, mq5, ex5 };
        }
        let relInput = input.replace(/^[/\\]+/, "");
        relInput = relInput.replace(/^mql5[\\/]/i, "");
        relInput = relInput.replace(/^experts[\\/]/i, "");
        const relCandidates = hasExt ? [relInput] : [`${relInput}.ex5`, `${relInput}.mq5`];
        for (const candidate of relCandidates) {
            // Normaliza separadores para funcionar no host Linux/WSL.
            const candidateNorm = candidate.replace(/\\/g, "/");
            const full = path.join(base, candidateNorm);
            if (fs.existsSync(full)) {
                const name = normalizeExpertRelName(candidateNorm);
                const mq5 = full.toLowerCase().endsWith(".mq5") ? full : undefined;
                const ex5 = full.toLowerCase().endsWith(".ex5") ? full : undefined;
                return { name, mq5, ex5 };
            }
        }
        return null;
    }
    for (const candidate of candidates) {
        const found = findFileRecursive(base, candidate);
        if (found) {
            const rel = path.relative(base, found);
            const name = normalizeExpertRelName(rel);
            const mq5 = found.toLowerCase().endsWith(".mq5") ? found : undefined;
            const ex5 = found.toLowerCase().endsWith(".ex5") ? found : undefined;
            return { name, mq5, ex5 };
        }
    }
    return null;
}
