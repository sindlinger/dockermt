#!/usr/bin/env bash
set -euo pipefail

CENTRAL_CONTAINER="${DOCKERMT_CENTRAL_CONTAINER:-dockermt-paradigm-v4}"
INSTANCES=()
if [ "$#" -gt 0 ]; then
  INSTANCES=("$@")
else
  INSTANCES=(models harm strictseed)
fi

if ! docker inspect "$CENTRAL_CONTAINER" >/dev/null 2>&1; then
  echo "ERR: central nao encontrado: $CENTRAL_CONTAINER" >&2
  exit 1
fi

source <(docker exec "$CENTRAL_CONTAINER" sh -lc '/config/dockermt/install-host.sh')

fails=0

for inst in "${INSTANCES[@]}"; do
  echo "===== $inst ====="

  shell_out="$(mktemp)"
  set +e
  timeout 8 bash -lc "source <(docker exec '$CENTRAL_CONTAINER' sh -lc '/config/dockermt/install-host.sh'); dockermt @$inst shell" >"$shell_out" 2>&1
  rc_shell=$?
  set -e
  if [ "$rc_shell" -ne 0 ] || ! rg -q "DockerMT \[$inst\] • Codex shell" "$shell_out"; then
    echo "FAIL host shell @$inst (rc=$rc_shell)"
    sed -n '1,12p' "$shell_out"
    fails=$((fails + 1))
  else
    echo "OK host shell @$inst"
  fi

  open_out="$(mktemp)"
  set +e
  bash -lc "source <(docker exec '$CENTRAL_CONTAINER' sh -lc '/config/dockermt/install-host.sh'); dockermt @$inst container open" >"$open_out" 2>&1
  rc_open=$?
  set -e
  if [ "$rc_open" -ne 0 ] || ! rg -q "mt5: aberto no display externo\." "$open_out"; then
    echo "FAIL host open @$inst (rc=$rc_open)"
    sed -n '1,14p' "$open_out"
    fails=$((fails + 1))
  else
    echo "OK host open @$inst"
  fi

  display="$(sed -n 's/^mt5-display: //p' "$open_out" | head -n1)"
  if [ -z "$display" ]; then
    display="192.168.64.1:0"
  fi

  in_out="$(mktemp)"
  set +e
  docker exec -u abc -e DOCKERMT_APP_DISPLAY="$display" "dockermt-$inst" /usr/local/bin/dockermt "@$inst" container open >"$in_out" 2>&1
  rc_inside=$?
  set -e
  if [ "$rc_inside" -ne 0 ] || ! rg -q "mt5: aberto no display externo\." "$in_out"; then
    echo "FAIL inside open @$inst (rc=$rc_inside)"
    sed -n '1,14p' "$in_out"
    fails=$((fails + 1))
  else
    echo "OK inside open @$inst"
  fi

  plain_out="$(mktemp)"
  set +e
  docker exec -u abc -e "DOCKERMT_CONTAINER_NAME=dockermt-$inst" "dockermt-$inst" /usr/local/bin/dockermt container open >"$plain_out" 2>&1
  rc_plain=$?
  set -e
  if [ "$rc_plain" -eq 0 ] || ! rg -q "exige alvo explicito com @" "$plain_out"; then
    echo "FAIL plain open guardrail $inst (rc=$rc_plain)"
    sed -n '1,10p' "$plain_out"
    fails=$((fails + 1))
  else
    echo "OK plain open guardrail $inst"
  fi

  cfg_common="/config/.wine/drive_c/Program Files/MetaTrader 5/Config/common.ini"
  cfg_terminal="/config/.wine/drive_c/Program Files/MetaTrader 5/Config/terminal.ini"
  if ! docker exec "dockermt-$inst" sh -lc "[ -f \"$cfg_common\" ] && [ -f \"$cfg_terminal\" ]" >/dev/null 2>&1; then
    echo "FAIL config ini seed $inst"
    docker exec "dockermt-$inst" sh -lc "ls -la '/config/.wine/drive_c/Program Files/MetaTrader 5/Config' | sed -n '1,40p'" || true
    fails=$((fails + 1))
  else
    echo "OK config ini seed $inst"
  fi

  if docker exec "$CENTRAL_CONTAINER" sh -lc "[ -f '/config/.wine/drive_c/Program Files/MetaTrader 5/Config/accounts.dat' ]" >/dev/null 2>&1; then
    if ! docker exec "dockermt-$inst" sh -lc "[ -f '/config/.wine/drive_c/Program Files/MetaTrader 5/Config/accounts.dat' ]" >/dev/null 2>&1; then
      echo "FAIL accounts.dat seed $inst"
      fails=$((fails + 1))
    else
      echo "OK accounts.dat seed $inst"
    fi
  fi

  rm -f "$shell_out" "$open_out" "$in_out" "$plain_out"
  echo

done

if [ "$fails" -ne 0 ]; then
  echo "RESULT: FAIL ($fails)" >&2
  exit 1
fi

echo "RESULT: OK"
