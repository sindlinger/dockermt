import fs from "node:fs";
import path from "node:path";
import { isWindowsPath, toWslPath } from "./config.js";
import { resolveExpertFromRunner } from "./expert_resolve.js";
function resolveDataPathWsl(dataPath) {
    if (!dataPath)
        return null;
    if (isWindowsPath(dataPath))
        return toWslPath(dataPath);
    return dataPath;
}
function joinExpertPath(base, expertId, ext) {
    const parts = expertId.split("\\").filter(Boolean);
    return path.join(base, ...parts) + ext;
}
function copyIfNewer(src, dest) {
    if (!fs.existsSync(src))
        return false;
    const srcStat = fs.statSync(src);
    const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null;
    if (destStat && destStat.mtimeMs >= srcStat.mtimeMs)
        return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
}
export function ensureExpertInRunner(expert, source, target) {
    const details = [];
    const targetData = resolveDataPathWsl(target.dataPath);
    if (!targetData) {
        throw new Error("runner de teste sem dataPath para sync de expert");
    }
    if (source?.dataPath && source.dataPath === target.dataPath) {
        return { copied: false, details };
    }
    const already = resolveExpertFromRunner(expert, target.dataPath);
    if (already)
        return { copied: false, details };
    if (!source?.dataPath) {
        throw new Error("runner de origem ausente para copiar expert ao sandbox");
    }
    const srcResolved = resolveExpertFromRunner(expert, source.dataPath);
    if (!srcResolved) {
        throw new Error(`expert nao encontrado no runner de origem: ${expert}`);
    }
    const targetBase = path.join(targetData, "MQL5", "Experts");
    const destMq5 = joinExpertPath(targetBase, srcResolved.name, ".mq5");
    const destEx5 = joinExpertPath(targetBase, srcResolved.name, ".ex5");
    const srcMq5 = srcResolved.mq5 ??
        (source.dataPath ? joinExpertPath(path.join(resolveDataPathWsl(source.dataPath), "MQL5", "Experts"), srcResolved.name, ".mq5") : "");
    const srcEx5 = srcResolved.ex5 ??
        (source.dataPath ? joinExpertPath(path.join(resolveDataPathWsl(source.dataPath), "MQL5", "Experts"), srcResolved.name, ".ex5") : "");
    let copied = false;
    if (srcMq5 && fs.existsSync(srcMq5)) {
        if (copyIfNewer(srcMq5, destMq5)) {
            copied = true;
            details.push(`mq5 -> ${destMq5}`);
        }
    }
    if (srcEx5 && fs.existsSync(srcEx5)) {
        if (copyIfNewer(srcEx5, destEx5)) {
            copied = true;
            details.push(`ex5 -> ${destEx5}`);
        }
    }
    if (!copied && !fs.existsSync(destMq5) && !fs.existsSync(destEx5)) {
        throw new Error(`falha ao copiar expert para sandbox: ${srcResolved.name}`);
    }
    return { copied, details };
}
