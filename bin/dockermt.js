#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

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
const WEB_USER = envGet("DOCKERMT_WEB_USER", envGet("CUSTOM_USER", ""));
const WEB_PASS = envGet("DOCKERMT_WEB_PASS", envGet("PASSWORD", ""));
const QUIET = envGet("DOCKERMT_QUIET", "0") === "1";
const OPEN_BROWSER_DEFAULT = String(envGet("DOCKERMT_OPEN_BROWSER", "")).trim().toLowerCase();
const OPEN_WINDOW_DEFAULT = String(envGet("DOCKERMT_OPEN_WINDOW", "2200x1400")).trim();
const OPEN_MAXIMIZED_DEFAULT = String(envGet("DOCKERMT_OPEN_MAXIMIZED", "1")).trim() === "1";
const OPEN_COOLDOWN_MS = Number.parseInt(envGet("DOCKERMT_OPEN_COOLDOWN_MS", "0"), 10);
const NAMESPACES = new Set(["container", "docker"]);
const REQUIRED_ENV_DEFAULTS = {
  MT5_ENABLE_PYTHON: "1",
  TELNETMT_ENABLE: "1",
  CMDMT_BOOTSTRAP_ENABLE: "0",
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

function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    ...opts
  });
  return {
    status: typeof r.status === "number" ? r.status : 1,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || "")
  };
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

function isWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
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
  const qs = new URLSearchParams({
    autoconnect: "1",
    resize: "remote",
    host: WEB_HOST,
    port: WEB_PORT,
    path: "websockify",
    clipboard_up: "true",
    clipboard_down: "true",
    clipboard_seamless: "true",
    show_control_bar: "true"
  });
  if (WEB_USER) qs.set("username", WEB_USER);
  if (WEB_PASS) qs.set("password", WEB_PASS);
  const authPrefix = WEB_USER
    ? `${encodeURIComponent(WEB_USER)}:${encodeURIComponent(WEB_PASS || "")}@`
    : "";
  return `http://${authPrefix}${WEB_HOST}:${WEB_PORT}/vnc/index.html?${qs.toString()}`;
}

function redactSecrets(url) {
  return String(url || "")
    .replace(/\/\/([^:@\/?#]+):([^@\/?#]*)@/g, "//$1:***@")
    .replace(/([?&]password=)[^&]*/gi, "$1***");
}

function runLaunch(cmd, args) {
  const r = spawnSync(cmd, args, {
    stdio: "ignore",
    env: process.env,
    timeout: 8000,
    windowsHide: true
  });
  return r && r.status === 0;
}

function runDetachedLaunch(cmd, args) {
  try {
    const p = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
      windowsHide: true
    });
    p.unref();
    return true;
  } catch {
    return false;
  }
}

function runPowerShellInline(script) {
  return runLaunch("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ]);
}

function commandExists(cmd) {
  const probe = spawnSync("bash", ["-lc", `command -v ${cmd}`], {
    stdio: "ignore",
    env: process.env
  });
  return probe.status === 0;
}

function parseOpenArgs(args) {
  let appMode = false;
  let browser = "";
  let forceOpen = false;
  let windowSpecRaw = "";
  let maximized = OPEN_MAXIMIZED_DEFAULT;
  for (let i = 0; i < args.length; i++) {
    const tok = String(args[i] || "").trim();
    if (!tok) continue;
    if (tok === "--app") {
      appMode = true;
      const next = String(args[i + 1] || "").trim();
      if (next && !next.startsWith("--")) {
        browser = next.toLowerCase();
        i++;
      }
      continue;
    }
    if (tok.startsWith("--app=")) {
      appMode = true;
      browser = tok.slice("--app=".length).trim().toLowerCase();
      continue;
    }
    if (tok === "--browser") {
      const next = String(args[i + 1] || "").trim();
      if (next) {
        browser = next.toLowerCase();
        i++;
      }
      continue;
    }
    if (tok.startsWith("--browser=")) {
      browser = tok.slice("--browser=".length).trim().toLowerCase();
      continue;
    }
    if (tok === "--electron") {
      appMode = true;
      browser = "electron";
      continue;
    }
    if (tok === "--force-open" || tok === "--force") {
      forceOpen = true;
      continue;
    }
    if (tok === "--window" || tok === "--size") {
      const next = String(args[i + 1] || "").trim();
      if (next && !next.startsWith("--")) {
        windowSpecRaw = next;
        i++;
      }
      continue;
    }
    if (tok.startsWith("--window=")) {
      windowSpecRaw = tok.slice("--window=".length).trim();
      continue;
    }
    if (tok.startsWith("--size=")) {
      windowSpecRaw = tok.slice("--size=".length).trim();
      continue;
    }
    if (tok === "--max" || tok === "--maximize" || tok === "--maximized") {
      maximized = true;
      continue;
    }
    if (tok === "--no-max" || tok === "--no-maximize" || tok === "--no-maximized") {
      maximized = false;
      continue;
    }
  }
  if (!browser && OPEN_BROWSER_DEFAULT) {
    appMode = true;
    browser = OPEN_BROWSER_DEFAULT;
  }
  if (browser && !appMode) appMode = true;
  const parsed = parseWindowSpec(windowSpecRaw || OPEN_WINDOW_DEFAULT) || { width: 1900, height: 1200 };
  return {
    appMode,
    browser,
    forceOpen,
    windowWidth: parsed.width,
    windowHeight: parsed.height,
    maximized
  };
}

function parseWindowSpec(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d{3,5})x(\d{3,5})$/);
  if (!m) return null;
  const width = Number.parseInt(m[1], 10);
  const height = Number.parseInt(m[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 640 || height < 480) return null;
  return { width, height };
}

function openStateFilePath() {
  return path.join(os.homedir(), ".cache", "dockermt", "open-state.json");
}

function shouldSkipOpenLaunch(url, opts = {}) {
  if (opts.forceOpen) return false;
  if (!Number.isFinite(OPEN_COOLDOWN_MS) || OPEN_COOLDOWN_MS <= 0) return false;
  const f = openStateFilePath();
  if (!fs.existsSync(f)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    const age = Date.now() - Number(raw.ts || 0);
    if (!Number.isFinite(age) || age < 0) return false;
    return age <= OPEN_COOLDOWN_MS && raw.url === url;
  } catch {
    return false;
  }
}

function markOpenLaunch(url, opts = {}) {
  const f = openStateFilePath();
  const dir = path.dirname(f);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    ts: Date.now(),
    url,
    appMode: !!opts.appMode,
    browser: String(opts.browser || "").toLowerCase()
  };
  fs.writeFileSync(f, JSON.stringify(payload), "utf8");
}

function writeElectronLauncherScript(opts = {}) {
  const width = Number.isFinite(Number(opts.windowWidth)) ? Number(opts.windowWidth) : 1900;
  const height = Number.isFinite(Number(opts.windowHeight)) ? Number(opts.windowHeight) : 1200;
  const maximized = !!opts.maximized;
  const outDir = path.join(ROOT_DIR, ".tmp");
  fs.mkdirSync(outDir, { recursive: true });
  const scriptPath = path.join(outDir, "dockermt-novnc-electron.js");
  const code = `
const { app, BrowserWindow } = require("electron");
const target = process.argv[2];
if (!target) process.exit(2);
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: ${Math.trunc(width)},
    height: ${Math.trunc(height)},
    autoHideMenuBar: true,
    backgroundColor: "#111111",
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  });
  if (${maximized ? "true" : "false"}) win.maximize();
  win.loadURL(target);
});
app.on("window-all-closed", () => app.quit());
`.trimStart();
  fs.writeFileSync(scriptPath, code, "utf8");
  return scriptPath;
}

function toWindowsPath(posixPath) {
  const p = String(posixPath || "").trim();
  if (!p) return "";
  const r = spawnSync("wslpath", ["-w", p], { stdio: ["ignore", "pipe", "ignore"], env: process.env });
  if (r.status === 0) {
    const out = String(r.stdout || "").trim();
    if (out) return out;
  }
  return p;
}

function resolveWindowsElectronBinary() {
  const ps = [
    "$e1=Join-Path $env:APPDATA 'npm\\node_modules\\electron\\dist\\electron.exe';",
    "$e2=Join-Path $env:LOCALAPPDATA 'Programs\\electron\\electron.exe';",
    "$e3=Join-Path $env:APPDATA 'npm\\electron.cmd';",
    "if(Test-Path $e1){ Write-Output $e1; exit 0 }",
    "if(Test-Path $e2){ Write-Output $e2; exit 0 }",
    "if(Test-Path $e3){ Write-Output $e3; exit 0 }",
    "exit 1"
  ].join(" ");
  const r = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    ps
  ], { stdio: ["ignore", "pipe", "ignore"], env: process.env });
  if (r.status !== 0) return "";
  return String(r.stdout || "").trim();
}

function electronAppLaunch(url, opts = {}) {
  const launcherPosix = writeElectronLauncherScript(opts);
  const launcherWin = toWindowsPath(launcherPosix);
  const electronWin = resolveWindowsElectronBinary();
  if (!launcherWin || !electronWin) return false;

  const psCode = [
    `$u='${String(url).replace(/'/g, "''")}';`,
    `$js='${String(launcherWin).replace(/'/g, "''")}';`,
    `$electron='${String(electronWin).replace(/'/g, "''")}';`,
    "if(-not (Test-Path $electron)){ exit 1 }",
    "if($electron.ToLower().EndsWith('.cmd')){ Start-Process -WindowStyle Hidden -FilePath $electron -ArgumentList @($js,$u) | Out-Null; exit 0 }",
    "Start-Process -FilePath $electron -ArgumentList @($js,$u) | Out-Null; exit 0"
  ].join(" ");
  const psOk = runPowerShellInline(psCode);
  if (psOk) return true;
  // Em WSL, não usar fallback Linux com `electron` do host (gera path inválido C:\mnt\...).
  if (isWsl()) return false;
  // Fallback: Linux electron nativo (quando existir).
  return runDetachedLaunch("electron", [launcherPosix, url]);
}

function powerShellAppLaunch(url, browserHint = "") {
  const b = String(browserHint || "").toLowerCase();
  const candidates = b === "edge" || b === "msedge"
    ? [
        "msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
      ]
    : [
        "chrome.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
      ];
  const ps = [
    "$u='" + String(url).replace(/'/g, "''") + "';",
    "$raw=@(" + candidates.map((c) => `'${c.replace(/'/g, "''")}'`).join(",") + ");",
    "$resolved=$null;",
    "foreach($item in $raw){",
    "  $cmd = Get-Command $item -ErrorAction SilentlyContinue;",
    "  if($cmd){ $cand = $cmd.Source } else { $cand = $item }",
    "  if($cand -and (Test-Path $cand)){ $resolved = $cand; break }",
    "}",
    "if($resolved){ Start-Process -FilePath $resolved -ArgumentList @(\"--app=$u\"); exit 0 }",
    "else{ exit 1 }"
  ].join(" ");
  return runPowerShellInline(ps);
}

function tryOpenBrowser(url, opts = {}) {
  const appMode = !!opts.appMode;
  const browserHint = String(opts.browser || "").toLowerCase();
  if (appMode) {
    // Regra anti-ruido: cada chamada abre no maximo UMA janela.
    const browser = browserHint || OPEN_BROWSER_DEFAULT || "electron";
    if (browser === "electron") return electronAppLaunch(url, opts);
    if (browser === "chrome") {
      if (powerShellAppLaunch(url, "chrome")) return true;
      if (commandExists("google-chrome")) return runLaunch("google-chrome", [`--app=${url}`]);
      if (commandExists("chromium")) return runLaunch("chromium", [`--app=${url}`]);
      if (commandExists("chromium-browser")) return runLaunch("chromium-browser", [`--app=${url}`]);
      return false;
    }
    if (browser === "chromium") {
      if (commandExists("chromium")) return runLaunch("chromium", [`--app=${url}`]);
      if (commandExists("chromium-browser")) return runLaunch("chromium-browser", [`--app=${url}`]);
      if (powerShellAppLaunch(url, "chrome")) return true;
      if (commandExists("google-chrome")) return runLaunch("google-chrome", [`--app=${url}`]);
      return false;
    }
    if (browser === "edge" || browser === "msedge") return powerShellAppLaunch(url, "edge");
    if (browser === "firefox") return runLaunch("firefox", ["--new-window", url]);
    return false;
  }

  const attempts = [
    ["firefox", ["--new-window", url]],
    ["wslview", [url]],
    ["xdg-open", [url]],
    ["cmd.exe", ["/c", "start", "", url]],
    ["powershell.exe", ["-NoProfile", "-Command", `Start-Process '${url}'`]]
  ];
  for (const [cmd, args] of attempts) {
    if (runLaunch(cmd, args)) return true;
  }
  return false;
}

function cmdOpen(opts = {}) {
  const appMode = !!opts.appMode;
  const browser = String(opts.browser || "").toLowerCase();
  ensureEnvDefaults();
  if (!isInsideContainer()) {
    ensureDocker();
    if (!containerRunning()) composeUpDetached();
  }
  const url = noVncUrl();
  if (shouldSkipOpenLaunch(url, opts)) {
    process.stdout.write(redactSecrets(url) + "\n");
    process.stderr.write("Aviso: open suprimido para evitar duplicacao de janelas (use --force-open para forcar).\n");
    process.exit(0);
  }
  if (appMode && browser) {
    log(`abrindo noVNC em modo app com navegador='${browser}'`);
  } else if (appMode) {
    log("abrindo noVNC em modo app (auto)");
  }
  const opened = tryOpenBrowser(url, opts);
  if (opened) markOpenLaunch(url, opts);
  process.stdout.write(redactSecrets(url) + "\n");
  if (!opened) {
    process.stderr.write(
      appMode
        ? `Aviso: não consegui abrir em modo app${browser ? ` (browser=${browser})` : ""} automaticamente.\n`
        : "Aviso: não consegui abrir o navegador automaticamente.\n"
    );
  }
  process.exit(0);
}

function closeDockermtElectron() {
  const ps = [
    "$targets = Get-CimInstance Win32_Process -Filter \"name='electron.exe'\" | ",
    "Where-Object { $_.CommandLine -like '*dockermt-novnc-electron.js*' };",
    "$count = 0;",
    "foreach($p in $targets){",
    "  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $count++ } catch {}",
    "}",
    "Write-Output (\"closed=\" + $count);",
    "exit 0"
  ].join(" ");
  const r = runCapture("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    ps
  ]);
  if (r.status !== 0) {
    process.stderr.write("Erro: falha ao fechar janela do dockermt.\n");
    if (r.stderr.trim()) process.stderr.write(r.stderr.trim() + "\n");
    process.exit(r.status);
  }
  const out = r.stdout.trim() || "closed=0";
  process.stdout.write(out + "\n");
  process.exit(0);
}

function help() {
  process.stdout.write(
    [
      "dockermt (host launcher -> container)",
      "",
      "Uso:",
      "  dockermt install|up|start      # docker compose up -d",
      "  dockermt uninstall|down|stop   # docker compose down --remove-orphans",
      "  dockermt reinstall|repair      # down + up + doctor",
      "  dockermt doctor [--fix]        # verifica stack e runtime",
      "  dockermt status|ps             # docker compose ps",
      "  dockermt logs [args...]        # docker compose logs ...",
      "  dockermt open                  # sobe stack (se precisar) e abre noVNC",
      "  dockermt open --app [browser]  # app mode (electron|chrome|chromium|edge|firefox)",
      "  dockermt open --electron       # abre em janela Electron",
      "  dockermt close                 # fecha somente janela Electron do dockermt",
      "  dockermt open --window WxH     # tamanho da janela app (ex: 2200x1400)",
      "  dockermt open --maximized      # abre janela maximizada",
      "  dockermt open --browser chrome # equivalente ao app mode",
      "  dockermt monitor               # alias de 'open'",
      "  dockermt container open        # sobe stack + abre noVNC",
      "  dockermt container close       # fecha somente janela Electron do dockermt",
      "  dockermt container open --app [browser]",
      "  dockermt container monitor     # alias de 'container open'",
      "  dockermt map-host              # mostra mapa host",
      "  dockermt [comando_cli]         # proxy para /usr/local/bin/dockermt no container",
      "",
      `Container: ${CONTAINER_NAME}`,
      `Projeto:   ${ROOT_DIR}`,
      `noVNC:     ${redactSecrets(noVncUrl())}`
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
      `noVNC       : ${redactSecrets(noVncUrl())}`
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
    log("executando CLI do container (modo interativo).");
    dockerExec([]);
  }

  if (cmd === "close") {
    closeDockermtElectron();
  }

  if (cmd === "open" || cmd === "monitor") {
    cmdOpen(parseOpenArgs(rest));
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
      cmdOpen(parseOpenArgs(nsArgs));
    }

    if (nsCmd === "close") {
      closeDockermtElectron();
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
    log(`executando CLI do container: ${[nsCmd, ...nsArgs].join(" ")}`);
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
  log(`executando CLI do container: ${[cmd, ...rest].join(" ")}`);
  dockerExec([cmd, ...rest]);
} catch (err) {
  process.stderr.write(String(err && err.message ? err.message : err) + "\n");
  process.exit(1);
}
