#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT_DIR, ".env");

function parseEnv(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function ensureEnvDefaults(filePath = ENV_FILE, defaults = REQUIRED_ENV_DEFAULTS) {
  let lines = [];
  if (fs.existsSync(filePath)) {
    lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  }

  const present = new Set();
  for (const ln of lines) {
    const t = ln.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx <= 0) continue;
    present.add(t.slice(0, idx).trim());
  }

  let changed = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (!present.has(k)) {
      lines.push(`${k}=${v}`);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, lines.join("\n").replace(/\n+$/g, "\n"), "utf8");
  }
  return changed;
}

const fileEnv = parseEnv(ENV_FILE);
const envGet = (k, d) => process.env[k] || fileEnv[k] || d;
const CONTAINER_NAME = envGet("DOCKERMT_CONTAINER_NAME", "dockermt");
const WEB_PORT = envGet("MT5_WEB_PORT", "43100");
const WEB_HOST = envGet("DOCKERMT_WEB_HOST", "127.0.0.1");
const QUIET = envGet("DOCKERMT_QUIET", "0") === "1";
const NAMESPACES = new Set(["container", "docker"]);
const REQUIRED_ENV_DEFAULTS = {
  MT5_ENABLE_PYTHON: "1",
  TELNETMT_ENABLE: "1",
  CMDMT_BOOTSTRAP_ENABLE: "1",
  CMDMT_SYNC_COMMON: "1"
};

function composeFile() {
  const yaml = path.join(ROOT_DIR, "docker-compose.yaml");
  const yml = path.join(ROOT_DIR, "docker-compose.yml");
  if (fs.existsSync(yaml)) return yaml;
  if (fs.existsSync(yml)) return yml;
  throw new Error("docker-compose.yaml/.yml não encontrado no repositório.");
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: process.env,
    ...opts
  });
  if (typeof r.status === "number") process.exit(r.status);
  process.exit(1);
}

function runNoExit(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: process.env,
    ...opts
  });
  if (typeof r.status !== "number") return 1;
  return r.status;
}

function isInsideContainer() {
  if (fs.existsSync("/.dockerenv")) return true;
  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    return /(docker|containerd|kubepods)/i.test(cgroup);
  } catch {
    return false;
  }
}

function dockerCompose(args) {
  run("docker", ["compose", "-f", composeFile(), ...args]);
}

function dockerComposeNoExit(args) {
  return runNoExit("docker", ["compose", "-f", composeFile(), ...args]);
}

function dockerExec(args) {
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  const execArgs = [
    "exec",
    ...(tty ? ["-it"] : ["-i"]),
    CONTAINER_NAME,
    "/usr/local/bin/dockermt",
    ...args
  ];
  run("docker", execArgs);
}

function containerRunning() {
  const r = spawnSync(
    "docker",
    ["ps", "--filter", `name=^/${CONTAINER_NAME}$`, "--format", "{{.Names}}"],
    { stdio: ["ignore", "pipe", "ignore"], env: process.env }
  );
  if (r.status !== 0) return false;
  const out = String(r.stdout || "").trim();
  return out === CONTAINER_NAME;
}

function composeUpDetached() {
  runNoExit("docker", ["compose", "-f", composeFile(), "up", "-d"]);
}

function log(msg) {
  if (QUIET) return;
  process.stderr.write(`[dockermt] ${msg}\n`);
}

function ensureContainerUpForExec() {
  ensureDocker();
  log(`checando Docker e container '${CONTAINER_NAME}'...`);
  if (containerRunning()) {
    log(`container '${CONTAINER_NAME}' ja esta ativo.`);
    return;
  }
  log(`container '${CONTAINER_NAME}' parado; subindo via docker compose...`);
  composeUpDetached();
}

function noVncUrl() {
  return `http://${WEB_HOST}:${WEB_PORT}/vnc/index.html?autoconnect=1&resize=remote&host=${WEB_HOST}&port=${WEB_PORT}&path=websockify&clipboard_up=true&clipboard_down=true&clipboard_seamless=true&show_control_bar=true`;
}

function tryOpenBrowser(url, appMode = false) {
  if (appMode) {
    const firefoxApp = spawnSync("firefox", ["--new-window", url], { stdio: "ignore", env: process.env });
    if (firefoxApp.status === 0) return true;

    const appAttempts = [
      [
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          [
            "$u='" + String(url).replace(/'/g, "''") + "';",
            "$c=@((Get-Command chrome.exe -ErrorAction SilentlyContinue).Source,",
            "'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',",
            "'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe') | ",
            "Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1;",
            "if($c){ Start-Process -FilePath $c -ArgumentList \"--app=$u\"; exit 0 }",
            "else{ exit 1 }"
          ].join(" ")
        ]
      ],
      ["google-chrome", [`--app=${url}`]],
      ["chromium", [`--app=${url}`]],
      ["chromium-browser", [`--app=${url}`]]
    ];
    for (const [cmd, args] of appAttempts) {
      const r = spawnSync(cmd, args, { stdio: "ignore", env: process.env });
      if (r.status === 0) return true;
    }
  }

  const attempts = [
    ["firefox", ["--new-window", url]],
    ["wslview", [url]],
    ["xdg-open", [url]],
    ["cmd.exe", ["/c", "start", "", url]],
    ["powershell.exe", ["-NoProfile", "-Command", `Start-Process '${url}'`]]
  ];
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { stdio: "ignore", env: process.env });
    if (r.status === 0) return true;
  }
  return false;
}

function cmdOpen(appMode = false) {
  ensureEnvDefaults();
  if (!isInsideContainer()) {
    ensureDocker();
    if (!containerRunning()) composeUpDetached();
  }
  const url = noVncUrl();
  const opened = tryOpenBrowser(url, appMode);
  process.stdout.write(url + "\n");
  if (!opened) {
    process.stderr.write(
      appMode
        ? "Aviso: não consegui abrir em modo app automaticamente.\n"
        : "Aviso: não consegui abrir o navegador automaticamente.\n"
    );
  }
  process.exit(0);
}

function help() {
  process.stdout.write(
    [
      "dockermt (shim JS host -> container)",
      "",
      "Uso:",
      "  dockermt install|up|start      # docker compose up -d",
      "  dockermt uninstall|down|stop   # docker compose down --remove-orphans",
      "  dockermt reinstall|repair      # down + up + doctor",
      "  dockermt doctor [--fix]        # verifica stack e runtime",
      "  dockermt status|ps             # docker compose ps",
      "  dockermt logs [args...]        # docker compose logs ...",
      "  dockermt open                  # sobe stack (se precisar) e abre noVNC",
      "  dockermt open --app            # abre noVNC em janela app (chrome/chromium)",
      "  dockermt monitor               # alias de 'open'",
      "  dockermt container open        # sobe stack + abre noVNC",
      "  dockermt container open --app  # idem em modo app",
      "  dockermt container monitor     # alias de 'container open'",
      "  dockermt map-host              # mostra mapa host",
      "  dockermt [comando_cli]         # proxy para /usr/local/bin/dockermt no container",
      "",
      `Container: ${CONTAINER_NAME}`,
      `Projeto:   ${ROOT_DIR}`,
      `noVNC:     ${noVncUrl()}`
    ].join("\n") + "\n"
  );
}

function mapHost() {
  process.stdout.write(
    [
      "DOCKERMT Host Map",
      "=================",
      `project_dir : ${ROOT_DIR}`,
      `env_file    : ${ENV_FILE}`,
      `container   : ${CONTAINER_NAME}`,
      `web_host    : ${WEB_HOST}`,
      `ports       : web=${WEB_PORT}, py=${envGet("MT5_PY_PORT", "48001")}, telnet=${envGet("TELNETMT_PORT", "41122")}`,
      `noVNC       : ${noVncUrl()}`
    ].join("\n") + "\n"
  );
}

function ensureDocker() {
  const probe = spawnSync("docker", ["version"], { stdio: "ignore" });
  if (probe.status !== 0) {
    process.stderr.write("Erro: docker indisponível no host.\n");
    process.exit(1);
  }
}

function runDoctor({ fix = false } = {}) {
  ensureDocker();
  let ok = true;

  if (!containerRunning()) {
    if (fix) {
      composeUpDetached();
    }
  }

  const running = containerRunning();
  if (!running) {
    process.stderr.write("ERRO: container 'dockermt' não está rodando.\n");
    return 1;
  }

  const checks = [
    {
      name: "node",
      args: ["exec", CONTAINER_NAME, "node", "-v"]
    },
    {
      name: "pulseaudio2",
      args: [
        "exec",
        CONTAINER_NAME,
        "bash",
        "-lc",
        "cd /kclient && node -e \"require('pulseaudio2'); process.stdout.write('ok')\""
      ]
    },
    {
      name: "dockermt-cli",
      args: ["exec", CONTAINER_NAME, "/usr/local/bin/dockermt", "--help"]
    }
  ];

  for (const check of checks) {
    const r = spawnSync("docker", check.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    const pass = r.status === 0;
    process.stdout.write(`${pass ? "OK" : "FAIL"} ${check.name}\n`);
    if (!pass) {
      ok = false;
      const err = String(r.stderr || "").trim();
      if (err) process.stderr.write(err + "\n");
    }
  }

  return ok ? 0 : 1;
}

try {
  const argv = process.argv.slice(2);
  let [cmd, ...rest] = argv;

  if (cmd === "--help" || cmd === "-h") {
    help();
    process.exit(0);
  }

  if (!cmd) {
    if (isInsideContainer()) run("/usr/local/bin/dockermt", [], { cwd: process.cwd() });
    ensureContainerUpForExec();
    log("entrando no CLI interno do container (modo interativo).");
    dockerExec([]);
  }

  if (cmd === "open" || cmd === "monitor") {
    cmdOpen(rest.includes("--app"));
  }

  if (cmd === "doctor") {
    const fix = rest.includes("--fix");
    process.exit(runDoctor({ fix }));
  }

  if (cmd === "reinstall" || cmd === "repair") {
    if (isInsideContainer()) {
      process.stderr.write(`Erro: '${cmd}' é comando de host (docker compose), não de dentro do container.\n`);
      process.exit(1);
    }
    ensureDocker();
    let st = dockerComposeNoExit(["down", "--remove-orphans"]);
    if (st !== 0) process.exit(st);
    st = dockerComposeNoExit(["up", "-d"]);
    if (st !== 0) process.exit(st);
    process.exit(runDoctor({ fix: false }));
  }

  if (cmd === "map-host") {
    mapHost();
    process.exit(0);
  }

  if (NAMESPACES.has(cmd)) {
    const nsCmd = (rest[0] || "").toLowerCase();
    const nsArgs = rest.slice(1);

    if (!nsCmd || nsCmd === "help" || nsCmd === "--help" || nsCmd === "-h") {
      help();
      process.exit(0);
    }

    if (nsCmd === "open" || nsCmd === "monitor") {
      ensureEnvDefaults();
      if (!isInsideContainer()) {
        ensureDocker();
        const st = runNoExit("docker", ["compose", "-f", composeFile(), "up", "-d"]);
        if (st !== 0) process.exit(st);
      }
      cmdOpen(nsArgs.includes("--app"));
    }

    if (["install", "up", "start", "uninstall", "down", "stop", "status", "ps", "logs", "doctor", "reinstall", "repair"].includes(nsCmd)) {
      if (isInsideContainer()) {
        process.stderr.write(`Erro: '${nsCmd}' é comando de host (docker compose), não de dentro do container.\n`);
        process.exit(1);
      }
      ensureDocker();
      if (nsCmd === "install" || nsCmd === "up" || nsCmd === "start") ensureEnvDefaults();
      if (nsCmd === "install" || nsCmd === "up" || nsCmd === "start") dockerCompose(["up", "-d"]);
      if (nsCmd === "uninstall" || nsCmd === "down" || nsCmd === "stop") dockerCompose(["down", "--remove-orphans"]);
      if (nsCmd === "reinstall" || nsCmd === "repair") {
        let st = dockerComposeNoExit(["down", "--remove-orphans"]);
        if (st !== 0) process.exit(st);
        st = dockerComposeNoExit(["up", "-d"]);
        if (st !== 0) process.exit(st);
        process.exit(runDoctor({ fix: false }));
      }
      if (nsCmd === "doctor") process.exit(runDoctor({ fix: nsArgs.includes("--fix") }));
      if (nsCmd === "status" || nsCmd === "ps") dockerCompose(["ps"]);
      if (nsCmd === "logs") dockerCompose(["logs", ...nsArgs]);
      process.exit(0);
    }

    // Namespace + other command => proxy to container CLI.
    if (isInsideContainer()) run("/usr/local/bin/dockermt", [nsCmd, ...nsArgs], { cwd: process.cwd() });
    ensureContainerUpForExec();
    log(`entrando no CLI interno do container com comando: ${[nsCmd, ...nsArgs].join(" ")}`);
    dockerExec([nsCmd, ...nsArgs]);
  }

  // Ações de stack (host only).
  if (["install", "up", "start", "uninstall", "down", "stop", "status", "ps", "logs"].includes(cmd)) {
    if (isInsideContainer()) {
      process.stderr.write(`Erro: '${cmd}' é comando de host (docker compose), não de dentro do container.\n`);
      process.exit(1);
    }
    ensureDocker();
    if (cmd === "install" || cmd === "up" || cmd === "start") ensureEnvDefaults();
    if (cmd === "install" || cmd === "up" || cmd === "start") dockerCompose(["up", "-d"]);
    if (cmd === "uninstall" || cmd === "down" || cmd === "stop") dockerCompose(["down", "--remove-orphans"]);
    if (cmd === "status" || cmd === "ps") dockerCompose(["ps"]);
    if (cmd === "logs") dockerCompose(["logs", ...rest]);
    process.exit(0);
  }

  // Dentro do container: chama direto o CLI local.
  if (isInsideContainer()) {
    run("/usr/local/bin/dockermt", [cmd, ...rest], { cwd: process.cwd() });
  }

  // Host -> proxy docker exec.
  ensureContainerUpForExec();
  log(`entrando no CLI interno do container com comando: ${[cmd, ...rest].join(" ")}`);
  dockerExec([cmd, ...rest]);
} catch (err) {
  process.stderr.write(String(err && err.message ? err.message : err) + "\n");
  process.exit(1);
}
