import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const UTILITY_IMAGE = (process.env.CMDMT_STATE_UTILITY_IMAGE || "busybox:1.36").trim() || "busybox:1.36";
function run(cmd, args, cwd) {
    const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
    return { ok: res.status === 0, out, code: res.status ?? -1 };
}
function runDocker(args, cwd) {
    return run("docker", args, cwd);
}
function runCompose(dockerDir, args) {
    return runDocker(["compose", ...args], dockerDir);
}
function parseLines(out) {
    return out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !/^WARN/i.test(l));
}
function mustOk(result, context) {
    if (!result.ok) {
        throw new Error(result.out || context);
    }
}
function resolveServiceName(dockerDir) {
    const r = runCompose(dockerDir, ["config", "--services"]);
    mustOk(r, "docker compose config --services falhou");
    const first = parseLines(r.out)[0];
    if (!first)
        throw new Error("nenhum servico encontrado no compose");
    return first;
}
function resolveComposeImageName(dockerDir) {
    const r = runCompose(dockerDir, ["config", "--images"]);
    mustOk(r, "docker compose config --images falhou");
    const first = parseLines(r.out)[0];
    if (!first)
        throw new Error("imagem do compose nao encontrada");
    return first;
}
function ensureServiceContainer(dockerDir, serviceName) {
    const up = runCompose(dockerDir, ["up", "-d"]);
    mustOk(up, "docker compose up -d falhou");
    const ps = runCompose(dockerDir, ["ps", "-q", serviceName]);
    mustOk(ps, "docker compose ps -q falhou");
    const cid = parseLines(ps.out)[0] || "";
    if (!cid)
        throw new Error("container do servico nao encontrado");
    return cid;
}
function inspectContainerName(containerId) {
    const r = runDocker(["inspect", containerId, "--format", "{{.Name}}"]);
    mustOk(r, "docker inspect (name) falhou");
    return (parseLines(r.out)[0] || "").replace(/^\//, "");
}
function inspectConfigVolumeName(containerId) {
    const fmt = "{{range .Mounts}}{{if eq .Destination \"/config\"}}{{.Name}}{{end}}{{end}}";
    const r = runDocker(["inspect", containerId, "--format", fmt]);
    mustOk(r, "docker inspect (volume) falhou");
    const vol = parseLines(r.out)[0] || "";
    if (!vol)
        throw new Error("volume /config nao encontrado no container");
    return vol;
}
function safeStateName(name) {
    const trimmed = name.trim();
    if (!trimmed)
        throw new Error("nome do estado vazio");
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
        throw new Error("nome invalido: use apenas letras, numeros, '.', '_' e '-'");
    }
    return trimmed;
}
function makeStateImageTag(name) {
    return `mt5commander/state:${name.toLowerCase()}`;
}
function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function removeIfExists(dirPath) {
    if (fs.existsSync(dirPath))
        fs.rmSync(dirPath, { recursive: true, force: true });
}
function statesRoot(dockerDir) {
    return path.join(dockerDir, ".cmdmt", "container-states");
}
function stateDirPath(dockerDir, stateName) {
    return path.join(statesRoot(dockerDir), stateName);
}
function tempId(prefix) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
function exportVolumeArchive(sourceVolume, outArchivePath) {
    const tmpVolume = tempId("cmdmt_state_tmpvol");
    const tmpContainer = tempId("cmdmt_state_tmpctr");
    try {
        mustOk(runDocker(["volume", "create", tmpVolume]), "falha ao criar volume temporario");
        const packCmd = "set -e; cd /from; tar -czf /to/volume.tgz .";
        mustOk(runDocker(["run", "--rm", "-v", `${sourceVolume}:/from`, "-v", `${tmpVolume}:/to`, UTILITY_IMAGE, "sh", "-lc", packCmd]), "falha ao gerar arquivo do volume");
        mustOk(runDocker(["create", "--name", tmpContainer, "-v", `${tmpVolume}:/to`, UTILITY_IMAGE, "sh", "-lc", "sleep 5"]), "falha ao criar container temporario");
        mustOk(runDocker(["cp", `${tmpContainer}:/to/volume.tgz`, outArchivePath]), "falha ao copiar arquivo do volume para host");
    }
    finally {
        runDocker(["rm", "-f", tmpContainer]);
        runDocker(["volume", "rm", "-f", tmpVolume]);
    }
}
function restoreVolumeArchive(targetVolume, archivePath) {
    const tmpVolume = tempId("cmdmt_state_invol");
    const tmpContainer = tempId("cmdmt_state_inctr");
    try {
        mustOk(runDocker(["volume", "create", tmpVolume]), "falha ao criar volume temporario de restore");
        mustOk(runDocker(["create", "--name", tmpContainer, "-v", `${tmpVolume}:/to`, UTILITY_IMAGE, "sh", "-lc", "sleep 5"]), "falha ao criar container temporario de restore");
        mustOk(runDocker(["cp", archivePath, `${tmpContainer}:/to/volume.tgz`]), "falha ao enviar archive para restore");
        const restoreCmd = "set -e; find /dest -mindepth 1 -maxdepth 1 -exec rm -rf {} +; tar -xzf /src/volume.tgz -C /dest";
        mustOk(runDocker(["run", "--rm", "-v", `${targetVolume}:/dest`, "-v", `${tmpVolume}:/src`, UTILITY_IMAGE, "sh", "-lc", restoreCmd]), "falha ao restaurar dados do volume");
    }
    finally {
        runDocker(["rm", "-f", tmpContainer]);
        runDocker(["volume", "rm", "-f", tmpVolume]);
    }
}
export function listContainerStates(dockerDir) {
    const root = statesRoot(dockerDir);
    if (!fs.existsSync(root))
        return [];
    const out = [];
    for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name);
        if (!fs.statSync(dir).isDirectory())
            continue;
        const metaPath = path.join(dir, "meta.json");
        if (!fs.existsSync(metaPath))
            continue;
        try {
            const meta = readJson(metaPath);
            const archivePath = path.join(dir, meta.volumeArchive || "volume.tgz");
            const archiveSizeBytes = fs.existsSync(archivePath) ? fs.statSync(archivePath).size : 0;
            out.push({ meta, stateDir: dir, archivePath, archiveSizeBytes });
        }
        catch {
            // Ignora estados corrompidos na listagem
        }
    }
    out.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
    return out;
}
export function saveContainerState(dockerDir, requestedName) {
    const name = safeStateName(requestedName);
    const serviceName = resolveServiceName(dockerDir);
    const containerId = ensureServiceContainer(dockerDir, serviceName);
    const containerName = inspectContainerName(containerId);
    const volumeName = inspectConfigVolumeName(containerId);
    const composeImage = resolveComposeImageName(dockerDir);
    const stateImage = makeStateImageTag(name);
    const dir = stateDirPath(dockerDir, name);
    removeIfExists(dir);
    ensureDir(dir);
    const archiveName = "volume.tgz";
    const archivePath = path.join(dir, archiveName);
    exportVolumeArchive(volumeName, archivePath);
    const commit = runDocker(["commit", containerId, stateImage]);
    mustOk(commit, "falha ao criar snapshot da imagem (docker commit)");
    const meta = {
        version: 1,
        name,
        createdAt: new Date().toISOString(),
        dockerDir,
        serviceName,
        containerId,
        containerName,
        volumeName,
        composeImage,
        stateImage,
        volumeArchive: archiveName
    };
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    const archiveSizeBytes = fs.existsSync(archivePath) ? fs.statSync(archivePath).size : 0;
    return { meta, stateDir: dir, archivePath, archiveSizeBytes };
}
export function restoreContainerState(dockerDir, requestedName) {
    const name = safeStateName(requestedName);
    const dir = stateDirPath(dockerDir, name);
    const metaPath = path.join(dir, "meta.json");
    if (!fs.existsSync(metaPath))
        throw new Error(`estado nao encontrado: ${name}`);
    const meta = readJson(metaPath);
    const archivePath = path.join(dir, meta.volumeArchive || "volume.tgz");
    if (!fs.existsSync(archivePath))
        throw new Error(`arquivo de volume nao encontrado: ${archivePath}`);
    const down = runCompose(dockerDir, ["down"]);
    mustOk(down, "docker compose down falhou");
    // Garante que o volume alvo existe
    const inspectVol = runDocker(["volume", "inspect", meta.volumeName]);
    if (!inspectVol.ok) {
        const created = runDocker(["volume", "create", meta.volumeName]);
        mustOk(created, "falha ao recriar volume alvo");
    }
    const imgCheck = runDocker(["image", "inspect", meta.stateImage]);
    mustOk(imgCheck, `imagem do estado nao encontrada: ${meta.stateImage}`);
    const composeImage = resolveComposeImageName(dockerDir) || meta.composeImage;
    mustOk(runDocker(["tag", meta.stateImage, composeImage]), "falha ao retagar imagem restaurada");
    restoreVolumeArchive(meta.volumeName, archivePath);
    const up = runCompose(dockerDir, ["up", "-d"]);
    mustOk(up, "docker compose up -d falhou apos restore");
    const archiveSizeBytes = fs.statSync(archivePath).size;
    return { meta, stateDir: dir, archivePath, archiveSizeBytes };
}
export function containerStatesStorePath(dockerDir) {
    ensureDir(statesRoot(dockerDir));
    return statesRoot(dockerDir);
}
