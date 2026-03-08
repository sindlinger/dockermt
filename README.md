# dockermt

`dockermt` é o stack Docker para MT5 + VNC + CLI.

## Modelo adotado

1. O comando real é `/usr/local/bin/dockermt` **dentro do container**.
2. No host, existe um launcher JS no repositório: [`bin/dockermt.js`](./bin/dockermt.js).
3. O launcher [`bin/dockermt`](./bin/dockermt) só chama esse entrypoint JS.
4. O fluxo oficial é somente `dockermt`.

## Pré-requisitos

- Docker Desktop ativo
- `docker compose`

## Subir/derrubar (simples)

Direto com compose:

```bash
cd /mnt/c/git/MT5Commander/dockermt
docker compose -f docker-compose.yaml up -d
docker compose -f docker-compose.yaml down --remove-orphans
```

Via launcher:

```bash
dockermt install     # docker compose up -d
dockermt uninstall   # docker compose down --remove-orphans
dockermt status      # docker compose ps
dockermt doctor      # valida runtime (node + pulseaudio2 + cli)
dockermt repair      # down + up + doctor
```

## Acesso no navegador (noVNC)

```text
http://127.0.0.1:43100/vnc/index.html?autoconnect=1&resize=remote&host=127.0.0.1&port=43100&path=websockify&clipboard_up=true&clipboard_down=true&clipboard_seamless=true&show_control_bar=true
```

Credenciais (padrão no `.env`):

- usuário: `mt5`
- senha: `mt5`

Provisionamento recomendado no `.env`:

- `MT5_ENABLE_PYTHON=1`
- `TELNETMT_ENABLE=1`
- `CMDMT_BOOTSTRAP_ENABLE=1`
- `CMDMT_SYNC_COMMON=1` (força sync de login/senha/servidor no `common.ini`)

Observação de segurança/configuração:

- O projeto não deve manter `Login/Password/Server` hardcoded em `common.ini` base.
- Esses campos só devem ser escritos via `auth set` + sync.
- Fonte interna de auth para `common.ini`: `/config/.cmdmt/.env` (volume interno do container).

## Comandos do launcher JS (host)

```bash
dockermt --help
dockermt map-host
dockermt open
dockermt open --electron
dockermt monitor
dockermt container open
dockermt logs -f
```

Qualquer outro comando é proxy para o CLI interno do container:

```bash
dockermt help
dockermt version
dockermt ping
dockermt chart list
```

## Uso dentro do container

Se já estiver dentro do container, use diretamente:

```bash
/usr/local/bin/dockermt
```

## Variáveis de ambiente

Lidas do `.env` do repositório (ou do ambiente):

- `DOCKERMT_CONTAINER_NAME` (default: `dockermt`)
- `DOCKERMT_WEB_HOST` (default: `127.0.0.1`)
- `MT5_WEB_PORT` (default: `43100`)
- `MT5_PY_PORT` (default: `48001`)
- `TELNETMT_PORT` (default: `41122`)

Para abrir via WSL2/Gateway, configure por exemplo:

```bash
DOCKERMT_WEB_HOST=192.168.64.1
```

## Troubleshooting rápido

1. Container não existe:

```bash
dockermt install
```

2. VNC não abre:

```bash
dockermt status
dockermt logs -n 200
curl -I "http://127.0.0.1:43100/vnc/index.html"
```

3. Runtime quebrado (módulo nativo):

```bash
dockermt repair
```

3. Sessão shell usando alias antigo:

```bash
unalias dockermt 2>/dev/null
unset -f dockermt 2>/dev/null
hash -r
```
