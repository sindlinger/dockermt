import fs from "node:fs";
import path from "node:path";
import { isWindowsPath, toWslPath } from "./config.js";
import { sendLine } from "./transport.js";
function isErrorResponse(resp) {
    const up = resp.trim().toUpperCase();
    return up.startsWith("ERR") || up.includes(" ERR ") || up.includes("CODE=");
}
export async function performDataImport(spec, runner, transport) {
    if (!runner.dataPath) {
        throw new Error("runner sem dataPath para importar CSV");
    }
    const dataPathWsl = isWindowsPath(runner.dataPath) ? toWslPath(runner.dataPath) : runner.dataPath;
    const filesRoot = path.join(dataPathWsl, "MQL5", "Files");
    const importDir = path.join(filesRoot, "cmdmt-import");
    fs.mkdirSync(importDir, { recursive: true });
    const csvSrc = isWindowsPath(spec.csv) ? toWslPath(spec.csv) : path.resolve(spec.csv);
    if (!fs.existsSync(csvSrc)) {
        throw new Error(`CSV nao encontrado: ${csvSrc}`);
    }
    const baseName = path.basename(csvSrc);
    const csvDst = path.join(importDir, baseName);
    if (path.resolve(csvSrc) !== path.resolve(csvDst)) {
        fs.copyFileSync(csvSrc, csvDst);
    }
    const csvRel = path.relative(filesRoot, csvDst).replace(/\\/g, "/");
    const params = [];
    params.push(spec.mode === "rates" ? "IMPORT_RATES" : "IMPORT_TICKS");
    params.push(`symbol=${spec.symbol}`);
    params.push(`csv=${csvRel}`);
    if (spec.tf)
        params.push(`tf=${spec.tf}`);
    if (spec.base)
        params.push(`base=${spec.base}`);
    if (spec.digits !== undefined)
        params.push(`digits=${spec.digits}`);
    if (spec.spread !== undefined)
        params.push(`spread=${spec.spread}`);
    if (spec.tz !== undefined)
        params.push(`tz=${spec.tz}`);
    if (spec.sep)
        params.push(`sep=${spec.sep}`);
    if (spec.recreate)
        params.push("recreate=1");
    if (spec.common)
        params.push("common=1");
    const line = ["RUN_SCRIPT", ...params].join("|");
    const resp = await sendLine(line, transport);
    if (isErrorResponse(resp)) {
        throw new Error(resp.trim());
    }
}
