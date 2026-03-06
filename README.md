# dockermt

Stack full oficial para rodar MT5 + TelnetMT.

`container-kit` foi removido. Este repositório mantém somente a versão full.

## Versão atual
- `DOCKERMT_VERSION=v3.0.2`
- Imagem: `sindlinger/dockermt:v3.0.2`
- Container padrão: `dockermt`

## Portas padrão (host)
- Web/KasmVNC: `43100` -> container `3000`
- Python bridge: `48001` -> container `8001`
- TelnetMT: `41122` -> container `41122`

## Instalação canônica (passo a passo)
1) Entrar na pasta:
```bash
cd /mnt/c/git/MT5Commander/dockermt
```

2) Configurar `.env` (mínimo):
- `DOCKERMT_VERSION=v3.0.2`
- `DOCKERMT_IMAGE=sindlinger/dockermt:v3.0.2`
- `MT5_WEB_PORT=43100`
- `MT5_PY_PORT=48001`
- `TELNETMT_PORT=41122`
- `DOCKERMT_CONFIG_VOLUME=dockermt_config`

3) Criar volume (uma vez):
```bash
docker volume create dockermt_config
```

4) Subir stack:
```bash
docker compose up -d
```

5) Validar:
```bash
docker ps --filter name=^dockermt$
docker exec dockermt dockermt version
docker exec dockermt dockermt ping
```

6) Abrir MT5 no navegador:
- `http://127.0.0.1:43100/vnc/index.html?autoconnect=1&resize=remote&host=127.0.0.1&port=43100&path=websockify&clipboard_up=true&clipboard_down=true&clipboard_seamless=true&show_control_bar=true`

## Instalar atalho local (shim) para evitar `docker exec`

### Linux/macOS (bash)
```bash
mkdir -p ~/.local/bin
docker exec dockermt dockermt shim-print bash > ~/.local/bin/dockermt
chmod +x ~/.local/bin/dockermt
export PATH="$HOME/.local/bin:$PATH"
```
Depois disso:
```bash
dockermt version
dockermt ping
dockermt map
```

### Windows PowerShell
```powershell
New-Item -ItemType Directory -Force "$HOME\bin" | Out-Null
docker exec dockermt dockermt shim-print powershell | Out-File -Encoding ascii "$HOME\bin\dockermt.ps1"
```
Depois:
```powershell
& "$HOME\bin\dockermt.ps1" version
& "$HOME\bin\dockermt.ps1" ping
```

## Instalação do shim a partir do container
Dentro do container, há instruções prontas:
```bash
docker exec dockermt dockermt install-help
```

Criar shim em caminho persistente do volume:
```bash
docker exec dockermt dockermt install-shim /config/tools/dockermt bash
```

## Comandos importantes
Sem shim:
```bash
docker exec dockermt dockermt version
docker exec dockermt dockermt map
docker exec dockermt dockermt ping
docker exec dockermt dockermt send '1|PING'
docker exec dockermt dockermt install-help
```

Com shim local:
```bash
dockermt version
dockermt map
dockermt ping
dockermt send '1|PING'
```

## Troubleshooting noVNC
- Sintoma: página abre, mas aparece `Falha ao conectar-se ao servidor`.
- Causa comum: path websocket errado/cached.
- Path correto: `websockify`.

Checklist:
1) Container de pé:
```bash
docker ps --filter name=^dockermt$
```
2) HTTP do painel:
```bash
curl -I "http://127.0.0.1:43100/vnc/index.html"
```
3) noVNC em `Settings > Advanced > WebSocket > Path` = `websockify`.
4) `Ctrl+F5`; se necessário, limpar dados do site `127.0.0.1:43100`.

## Parar/Reiniciar
```bash
docker compose down
docker compose up -d
docker restart dockermt
```
