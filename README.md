# dockermt

Stack full oficial para rodar MT5 + TelnetMT.

`container-kit` foi removido. Este repositório mantém somente a versão full.

## Versão e imagem
- Nome do container: `dockermt`
- Variável de imagem: `DOCKERMT_IMAGE`
- Imagem padrão estável: `sindlinger/dockermt:v3.0.1`
- Versão da stack local: `DOCKERMT_VERSION=v3.0.1`
- Arquivo de versão local: `VERSION`

## Portas padrão (host)
- Web/KasmVNC: `43100` -> container `3000`
- Python bridge: `48001` -> container `8001`
- TelnetMT: `41122` -> container `41122`

## Passo a passo
1) Entre na pasta:
```bash
cd /mnt/c/git/MT5Commander/dockermt
```
2) Confira `.env`:
- `DOCKERMT_VERSION=v3.0.1`
- `DOCKERMT_IMAGE=sindlinger/dockermt:v3.0.1`
- `MT5_WEB_PORT=43100`
- `MT5_PY_PORT=48001`
- `TELNETMT_PORT=41122`
- `DOCKERMT_CONFIG_VOLUME=dockermt_config`
3) Crie o volume nomeado (uma vez):
```bash
docker volume create dockermt_config
```
4) Suba o container:
```bash
docker compose up -d
```
5) Verifique status e portas:
```bash
docker ps --filter name=^dockermt$
```
6) Abra o painel:
- `http://127.0.0.1:43100/vnc/index.html?autoconnect=1&resize=remote&host=127.0.0.1&port=43100&path=websockify&clipboard_up=true&clipboard_down=true&clipboard_seamless=true&show_control_bar=true`

## Comandos úteis
```bash
docker exec dockermt dockermt version
docker exec dockermt dockermt map
docker exec dockermt dockermt ping
docker logs -f dockermt
```

## Troubleshooting (Falha ao conectar no noVNC)
- Sintoma: a página abre, mas aparece `Falha ao conectar-se ao servidor`.
- Causa comum: path websocket errado/cached no browser (`vnc/websockify`).
- Path correto: `websockify`.

Checklist:
1) Verifique status do container:
```bash
docker ps --filter name=^dockermt$
```
2) Verifique HTTP do painel:
```bash
curl -I "http://127.0.0.1:43100/vnc/index.html"
```
3) No noVNC: `Settings > Advanced > WebSocket > Path` = `websockify`.
4) Faça `Ctrl+F5`; se necessário, limpe dados do site `127.0.0.1:43100`.

## Parar/Reiniciar
```bash
docker compose down
docker compose up -d
docker restart dockermt
```
