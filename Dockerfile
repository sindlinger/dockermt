ARG BASE_IMAGE=sindlinger/dockermt:v3.0.0
FROM ${BASE_IMAGE}

ENV DOCKERMT_VERSION=v3.0.1

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

_usage() {
  cat <<'USAGE'
dockermt - utilitario interno do container

Uso:
  dockermt help
  dockermt version
  dockermt map
  dockermt send '1|PING'
  dockermt ping

Comandos:
  map      Mostra portas e caminhos importantes do container.
  send     Envia uma linha para o socket TelnetMT.
  ping     Atalho para: send '1|PING'
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
  *)
    echo "ERR: comando desconhecido: $CMD" >&2
    _usage >&2
    exit 1
    ;;
esac
EOF

RUN chmod +x /usr/local/bin/dockermt
