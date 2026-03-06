# dockermt

Stack full oficial para rodar MT5 + TelnetMT.

`container-kit` foi removido. Este repositório mantém somente a versão full.

## Visão geral
- Versão da stack: `v3.0.3`
- Imagem: `sindlinger/dockermt:v3.0.3`
- Container padrão: `dockermt`
- Caminho do projeto: `/mnt/c/git/MT5Commander/dockermt`

## Portas padrão
- Web/KasmVNC: host `43100` -> container `3000`
- Python bridge: host `48001` -> container `8001`
- TelnetMT: host `41122` -> container `41122`

## Pré-requisitos
- Docker Desktop instalado e em execução.
- `docker compose` disponível.
- Porta `43100`, `48001` e `41122` livres no host.

## Passo a passo canônico (do zero)
1. Entrar no diretório do projeto.
```bash
cd /mnt/c/git/MT5Commander/dockermt
```

2. Conferir variáveis no `.env`.
```env
DOCKERMT_VERSION=v3.0.3
DOCKERMT_IMAGE=sindlinger/dockermt:v3.0.3
MT5_WEB_PORT=43100
MT5_PY_PORT=48001
TELNETMT_PORT=41122
DOCKERMT_CONFIG_VOLUME=dockermt_config
```

3. Criar o volume persistente (uma vez).
```bash
docker volume create dockermt_config
```

4. Subir o container.
```bash
docker compose up -d
```

5. Validar que está pronto.
```bash
docker ps --filter name=^dockermt$
docker exec dockermt dockermt version
docker exec dockermt dockermt ping
docker exec dockermt dockermt map
```

6. Abrir o MT5 no navegador.
```text
http://127.0.0.1:43100/vnc/index.html?autoconnect=1&resize=remote&host=127.0.0.1&port=43100&path=websockify&clipboard_up=true&clipboard_down=true&clipboard_seamless=true&show_control_bar=true
```

## Instalar atalho local (shim) para não usar `docker exec`

### Linux/macOS (bash)
```bash
mkdir -p ~/.local/bin
docker exec dockermt dockermt shim-print bash > ~/.local/bin/dockermt
chmod +x ~/.local/bin/dockermt
export PATH="$HOME/.local/bin:$PATH"
```

Teste:
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

Teste:
```powershell
& "$HOME\bin\dockermt.ps1" version
& "$HOME\bin\dockermt.ps1" ping
& "$HOME\bin\dockermt.ps1" map
```

### Ajuda pronta dentro do container
```bash
docker exec dockermt dockermt install-help
```

## Uso diário

### Subir
```bash
docker compose up -d
```

### Parar
```bash
docker compose down
```

### Reiniciar
```bash
docker restart dockermt
```

### Logs
```bash
docker logs -f dockermt
```

## Comandos principais

### Sem shim
```bash
docker exec dockermt dockermt version
docker exec dockermt dockermt ping
docker exec dockermt dockermt send '1|PING'
docker exec dockermt dockermt map
docker exec dockermt dockermt install-help
```

### Com shim
```bash
dockermt version
dockermt ping
dockermt send '1|PING'
dockermt map
```

## Atualizar para versão nova
1. Ajustar `.env` com nova tag em `DOCKERMT_IMAGE`.
2. Baixar imagem.
3. Recriar stack.
```bash
docker pull sindlinger/dockermt:v3.0.3
docker compose down
docker compose up -d
docker exec dockermt dockermt version
```

## Artefato local da imagem (para backup/offline)
Gerar `.tar` da imagem dentro do diretório do projeto:
```bash
cd /mnt/c/git/MT5Commander/dockermt
./bin/export-image.sh sindlinger/dockermt:v3.0.3 artifacts
```

Arquivos gerados:
- `artifacts/sindlinger_dockermt_v3.0.3.tar`
- `artifacts/sindlinger_dockermt_v3.0.3.tar.sha256`
- `artifacts/sindlinger_dockermt_v3.0.3.meta.txt`

Restaurar a imagem a partir do tar:
```bash
docker load -i artifacts/sindlinger_dockermt_v3.0.3.tar
```

Verificar checksum:
```bash
sha256sum -c artifacts/sindlinger_dockermt_v3.0.3.tar.sha256
```

Se for versionar o `.tar` no Git, prefira Git LFS (arquivo grande).

## Troubleshooting

### noVNC abre, mas mostra "Falha ao conectar-se ao servidor"
1. Verificar container.
```bash
docker ps --filter name=^dockermt$
```

2. Verificar HTTP.
```bash
curl -I "http://127.0.0.1:43100/vnc/index.html"
```

3. Verificar noVNC em `Settings > Advanced > WebSocket > Path`: usar `websockify`.
4. Fazer `Ctrl+F5` e limpar cache do `127.0.0.1:43100`.

### Porta ocupada
```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```
Trocar porta no `.env` e subir novamente:
```bash
docker compose down
docker compose up -d
```

### `dockermt ping` falha
1. Confirmar container ativo.
2. Verificar logs.
```bash
docker logs --tail 200 dockermt
```
3. Confirmar porta TelnetMT no `.env` e em `services.ini` no MT5.
