#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

CONTAINER_NAME="${DOCKERMT_CONTAINER_NAME:-dockermt}"
INITIAL_SLEEP="${DOCKERMT_INITIAL_SLEEP:-10}"
TIMEOUT_SEC="${DOCKERMT_WAIT_TIMEOUT:-180}"
OPEN_BROWSER=0

usage() {
  cat <<'USAGE'
Uso:
  ./bin/up-dockermt.sh [--open] [--sleep SEGUNDOS] [--timeout SEGUNDOS] [--container NOME]

O que faz:
  1) Verifica se o Docker está ativo.
  2) Verifica se o container já está rodando.
  3) Se não estiver, sobe com docker compose up -d.
  4) Espera o tempo inicial e faz polling até ficar pronto.
  5) Mostra a URL noVNC (e pode abrir navegador com --open).
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --open)
      OPEN_BROWSER=1
      shift
      ;;
    --sleep)
      INITIAL_SLEEP="${2:-}"
      shift 2
      ;;
    --timeout)
      TIMEOUT_SEC="${2:-}"
      shift 2
      ;;
    --container)
      CONTAINER_NAME="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Parametro invalido: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Erro: docker nao encontrado no PATH." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Erro: Docker daemon nao esta disponivel." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Erro: docker compose indisponivel." >&2
  exit 1
fi

WEB_PORT="43100"
CONFIG_VOLUME="dockermt_config"
if [ -f "$ENV_FILE" ]; then
  env_port="$(awk -F= '/^MT5_WEB_PORT=/{print $2}' "$ENV_FILE" | tail -n 1 | tr -d '\r')"
  env_vol="$(awk -F= '/^DOCKERMT_CONFIG_VOLUME=/{print $2}' "$ENV_FILE" | tail -n 1 | tr -d '\r')"
  if [ -n "${env_port}" ]; then
    WEB_PORT="${env_port}"
  fi
  if [ -n "${env_vol}" ]; then
    CONFIG_VOLUME="${env_vol}"
  fi
fi

NOVNC_URL="http://127.0.0.1:${WEB_PORT}/vnc/index.html?autoconnect=1&resize=remote&host=127.0.0.1&port=${WEB_PORT}&path=websockify&clipboard_up=true&clipboard_down=true&clipboard_seamless=true&show_control_bar=true"
NOVNC_HEALTH_URL="http://127.0.0.1:${WEB_PORT}/vnc/index.html"

is_running() {
  local running
  running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  [ "$running" = "true" ]
}

echo "[dockermt] Container: ${CONTAINER_NAME}"
if ! docker volume inspect "$CONFIG_VOLUME" >/dev/null 2>&1; then
  echo "[dockermt] Volume '${CONFIG_VOLUME}' nao existe. Criando..."
  docker volume create "$CONFIG_VOLUME" >/dev/null
fi

if is_running; then
  echo "[dockermt] Ja estava rodando."
else
  echo "[dockermt] Subindo stack com docker compose..."
  (cd "$ROOT_DIR" && docker compose up -d)
fi

echo "[dockermt] Espera inicial: ${INITIAL_SLEEP}s"
sleep "$INITIAL_SLEEP"

echo "[dockermt] Aguardando disponibilidade (timeout ${TIMEOUT_SEC}s)..."
start_ts="$(date +%s)"
while true; do
  if is_running; then
    if command -v curl >/dev/null 2>&1; then
      http_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$NOVNC_HEALTH_URL" || true)"
      if [ "$http_code" = "200" ] || [ "$http_code" = "401" ] || [ "$http_code" = "403" ] || [[ "$http_code" == 3* ]]; then
        break
      fi
    else
      break
    fi
  fi

  now_ts="$(date +%s)"
  elapsed="$((now_ts - start_ts))"
  if [ "$elapsed" -ge "$TIMEOUT_SEC" ]; then
    echo "[dockermt] Timeout aguardando container pronto." >&2
    docker ps --filter "name=^${CONTAINER_NAME}$"
    exit 1
  fi
  sleep 2
done

echo "[dockermt] Pronto."
echo "[dockermt] noVNC: ${NOVNC_URL}"

if [ "$OPEN_BROWSER" -eq 1 ]; then
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$NOVNC_URL" >/dev/null 2>&1 || true
  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Start-Process '$NOVNC_URL'" >/dev/null 2>&1 || true
  fi
fi
