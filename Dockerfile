ARG BASE_IMAGE=sindlinger/dockermt:v3.0.0
FROM ${BASE_IMAGE}

ENV DOCKERMT_VERSION=v3.0.3

# Remove old helper commands and install a single `dockermt` command.
RUN set -eux; \
    rm -f /usr/local/bin/cmdmtc \
          /usr/local/bin/cmdmt-map \
          /usr/local/bin/cmdmt-bootstrap \
          /Metatrader/cmdmtc.sh \
          /Metatrader/cmdmt-map.sh \
          /Metatrader/cmdmt-bootstrap.sh

RUN cat > /usr/local/bin/dockermt <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

HOST="${TELNETMT_HOST:-127.0.0.1}"
PORT="${TELNETMT_PORT:-1122}"
WEB_PORT="${MT5_WEB_PORT:-3000}"
PY_PORT="${MT5_PY_PORT:-8001}"
TIMEOUT_SEC="${DOCKERMT_TIMEOUT_SEC:-5}"
CMD="${1:-help}"
DEFAULT_CONTAINER="${DOCKERMT_CONTAINER_NAME:-dockermt}"

_usage() {
  cat <<'USAGE'
dockermt - utilitario interno do container

Uso:
  dockermt help
  dockermt version
  dockermt map
  dockermt send '1|PING'
  dockermt ping
  dockermt shim-print [bash|powershell|cmd] [container_name]
  dockermt install-shim <destino> [bash|powershell|cmd] [container_name]
  dockermt install-help

Comandos:
  map      Mostra portas e caminhos importantes do container.
  send     Envia uma linha para o socket TelnetMT.
  ping     Atalho para: send '1|PING'
  shim-print   Imprime shim host para evitar digitar 'docker exec ...'.
  install-shim Grava o shim em arquivo (destino pode ser diretorio ou arquivo).
  install-help Mostra passo a passo de instalacao do shim no host.
  version  Mostra versao do utilitario.
USAGE
}

_send_line() {
  local line="$1"
  python3 - "$HOST" "$PORT" "$line" "$TIMEOUT_SEC" <<'PY'
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
line = sys.argv[3]
timeout = float(sys.argv[4])

try:
    with socket.create_connection((host, port), timeout=timeout) as s:
        s.settimeout(timeout)
        s.sendall((line + "\n").encode("utf-8", errors="replace"))
        chunks = []
        while True:
            try:
                b = s.recv(65535)
            except socket.timeout:
                break
            if not b:
                break
            chunks.append(b)
            if b.endswith(b"\n"):
                break
    out = b"".join(chunks).decode("utf-8", errors="replace").strip()
    print(out)
except Exception as e:
    print(f"ERR dockermt send: {e}", file=sys.stderr)
    sys.exit(1)
PY
}

_shim_print_bash() {
  local cname="$1"
  cat <<EOF2
#!/usr/bin/env bash
set -euo pipefail
CONTAINER_NAME="\${DOCKERMT_CONTAINER_NAME:-$cname}"
exec docker exec -i "\${CONTAINER_NAME}" dockermt "\$@"
EOF2
}

_shim_print_powershell() {
  local cname="$1"
  cat <<EOF2
param(
  [Parameter(ValueFromRemainingArguments=\$true)]
  [string[]]\$Args
)
\$container = if (\$env:DOCKERMT_CONTAINER_NAME) { \$env:DOCKERMT_CONTAINER_NAME } else { "$cname" }
docker exec -i \$container dockermt @Args
exit \$LASTEXITCODE
EOF2
}

_shim_print_cmd() {
  local cname="$1"
  cat <<EOF2
@echo off
set CONTAINER=%DOCKERMT_CONTAINER_NAME%
if "%CONTAINER%"=="" set CONTAINER=$cname
docker exec -i %CONTAINER% dockermt %*
exit /b %ERRORLEVEL%
EOF2
}

_shim_print() {
  local shell_kind="${1:-bash}"
  local cname="${2:-$DEFAULT_CONTAINER}"
  case "$shell_kind" in
    bash) _shim_print_bash "$cname" ;;
    powershell|pwsh|ps1) _shim_print_powershell "$cname" ;;
    cmd|bat) _shim_print_cmd "$cname" ;;
    *)
      echo "ERR: shell invalido para shim: $shell_kind" >&2
      echo "Use: bash | powershell | cmd" >&2
      exit 1
      ;;
  esac
}

_install_shim() {
  local dest="${1:-}"
  local shell_kind="${2:-bash}"
  local cname="${3:-$DEFAULT_CONTAINER}"
  local target="$dest"

  if [ -z "$dest" ]; then
    echo "ERR: informe destino. Ex: dockermt install-shim /config/tools/dockermt bash" >&2
    exit 1
  fi

  if [ -d "$dest" ]; then
    case "$shell_kind" in
      bash) target="$dest/dockermt" ;;
      powershell|pwsh|ps1) target="$dest/dockermt.ps1" ;;
      cmd|bat) target="$dest/dockermt.cmd" ;;
      *) echo "ERR: shell invalido: $shell_kind" >&2; exit 1 ;;
    esac
  fi

  mkdir -p "$(dirname "$target")"
  _shim_print "$shell_kind" "$cname" > "$target"
  case "$shell_kind" in
    bash|cmd|bat) chmod +x "$target" ;;
  esac
  echo "OK shim instalado em: $target"
}

_install_help() {
  cat <<'EOF2'
Instalar shim no host (evita digitar docker exec):

1) Linux/macOS (bash):
   mkdir -p ~/.local/bin
   docker exec dockermt dockermt shim-print bash > ~/.local/bin/dockermt
   chmod +x ~/.local/bin/dockermt
   export PATH="$HOME/.local/bin:$PATH"

2) Windows PowerShell:
   New-Item -ItemType Directory -Force "$HOME\bin" | Out-Null
   docker exec dockermt dockermt shim-print powershell | Out-File -Encoding ascii "$HOME\bin\dockermt.ps1"
   # Opcional: incluir $HOME\bin no PATH e usar: dockermt.ps1 ping

3) Instalar em volume persistente do container:
   docker exec dockermt dockermt install-shim /config/tools/dockermt bash
EOF2
}

case "$CMD" in
  help|-h|--help)
    _usage
    ;;
  version)
    echo "${DOCKERMT_VERSION:-unknown}"
    ;;
  map)
    cat <<EOF2
DOCKERMT Container Map
======================
Container: ${HOSTNAME:-dockermt}

Ports
-----
- Web (KasmVNC): host ${WEB_PORT} -> container 3000
- Python bridge: host ${PY_PORT} -> container 8001
- TelnetMT socket: host ${PORT} -> container ${PORT}

Important paths
---------------
- /config
- /config/.wine/drive_c/Program Files/MetaTrader 5
- /config/.wine/drive_c/Program Files/MetaTrader 5/MQL5
- /config/.wine/drive_c/Program Files/MetaTrader 5/Config/services.ini
- /usr/local/bin/dockermt
- /usr/local/share/dockermt/INSTALL_SHIM.md
EOF2
    ;;
  send)
    shift || true
    if [ "$#" -eq 0 ]; then
      echo "ERR: informe a linha para enviar." >&2
      echo "Exemplo: dockermt send '1|PING'" >&2
      exit 1
    fi
    _send_line "$*"
    ;;
  ping)
    _send_line "1|PING"
    ;;
  shim-print)
    shift || true
    _shim_print "${1:-bash}" "${2:-$DEFAULT_CONTAINER}"
    ;;
  install-shim)
    shift || true
    _install_shim "${1:-}" "${2:-bash}" "${3:-$DEFAULT_CONTAINER}"
    ;;
  install-help)
    _install_help
    ;;
  *)
    echo "ERR: comando desconhecido: $CMD" >&2
    _usage >&2
    exit 1
    ;;
esac
EOF

RUN chmod +x /usr/local/bin/dockermt

RUN mkdir -p /usr/local/share/dockermt && cat > /usr/local/share/dockermt/INSTALL_SHIM.md <<'EOF'
dockermt - instalacao de shim no host
====================================

Linux/macOS:
  mkdir -p ~/.local/bin
  docker exec dockermt dockermt shim-print bash > ~/.local/bin/dockermt
  chmod +x ~/.local/bin/dockermt
  export PATH="$HOME/.local/bin:$PATH"

Windows PowerShell:
  New-Item -ItemType Directory -Force "$HOME\bin" | Out-Null
  docker exec dockermt dockermt shim-print powershell | Out-File -Encoding ascii "$HOME\bin\dockermt.ps1"

Ajuda dentro do container:
  dockermt install-help
EOF
