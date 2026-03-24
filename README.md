# dockermt

`dockermt` aqui roda como container Docker com MT5 + noVNC + CLI interna.

O modelo atual ficou assim:
- a imagem padrão é `dockermt:3.1.1`
- o compose fica neste diretório em [docker-compose.yaml](./docker-compose.yaml)
- no host não há launcher dedicado do projeto em uso
- no host existe só uma função mínima `dockermt` no `~/.bashrc`
- essa função usa `docker compose` para subir/derrubar a stack e faz proxy para `/usr/local/bin/dockermt` dentro do container quando necessário

## Pré-requisitos

- Docker Desktop ativo
- WSL com acesso a `docker`
- `curl`
- opcional: `powershell.exe`, `msedge.exe` ou `chrome.exe` para `dockermt container open`

## Compose

Subir:

```bash
cd /mnt/c/git/dockermt
docker compose -f docker-compose.yaml up -d
```

Derrubar:

```bash
cd /mnt/c/git/dockermt
docker compose -f docker-compose.yaml down --remove-orphans
```

O compose atual usa:
- imagem: `dockermt:3.1.1`
- volume: `dockermt_config`
- restart: `unless-stopped`
- portas:
  - `43100 -> 3000` noVNC
  - `48001 -> 8001` bridge Python
  - `41122 -> 41122` TelnetMT

## URL da UI

O `container open` usa esta URL:

```text
http://127.0.0.1:43100/vnc/index.html?autoconnect=1&resize=remote&host=127.0.0.1&port=43100&path=websockify&clipboard_up=true&clipboard_down=true&clipboard_seamless=true&show_control_bar=true
```

Credenciais padrão:
- usuário: `mt5`
- senha: `mt5`

## Função do host

No host, o comando `dockermt` é uma função mínima no `~/.bashrc`.

Depois de alterar o `~/.bashrc`, recarregue:

```bash
source ~/.bashrc
```

## Comandos principais

Subir / remover / status:

```bash
dockermt install
dockermt uninstall
dockermt reinstall
dockermt doctor
dockermt status
dockermt logs -f
```

Semântica atual:
- `dockermt install` pede confirmação e executa o equivalente a `docker compose up -d`
- `dockermt install` também garante o bridge `mt5linux`, reinicia o bridge se necessário e abre a UI
- `dockermt uninstall` pede confirmação e executa o equivalente a `docker compose down --remove-orphans`
- `dockermt reinstall` pede confirmação, recria a stack e reroda as verificações

Abrir a UI:

```bash
dockermt open
dockermt container open
```

`dockermt container open` abre somente em modo aplicativo (`--app`) no host. Se não encontrar Edge/Chrome/Chromium, falha.

Depois de `dockermt install`, a UI já é aberta automaticamente quando estiver pronta.

## Namespace `container`

Ajuda:

```bash
dockermt container help
```

Comandos suportados:

```bash
dockermt container open
dockermt container close

dockermt container set default image dockermt:3.1.1
dockermt container set default vol dockermt_config
dockermt container set default restart unless-stopped

dockermt container set restart always

dockermt container list image
dockermt container list vol

dockermt container commit
dockermt container commit dockermt:minha-snapshot

dockermt container save image dockermt-3.1.1.tar
dockermt container save vol dockermt-config.tar
dockermt container save container dockermt-container.tar

dockermt container tag dockermt:3.1.1 meu-registro/dockermt:3.1.1
dockermt container pull minha-imagem:tag
dockermt container push

dockermt container snapshots
dockermt container select dockermt dockermt:3.1.1 43100 48001 41122
```

Notas:
- `commit` cria snapshot da imagem a partir do container atual
- `save image` usa `docker save`
- `save vol` empacota o volume com `tar`
- `save container` usa `docker export`
- `set default ...` persiste os defaults no `~/.bashrc`
- `set restart ...` altera a política de restart do container atual

## Namespace `bridge`

Ajuda:

```bash
dockermt bridge help
```

Comandos suportados:

```bash
dockermt bridge status
dockermt bridge install
dockermt bridge uninstall
dockermt bridge restart
dockermt bridge logs
```

O bridge atual é o `mt5linux`.

`install`:
- instala/atualiza `mt5linux` no Python Linux do container
- instala/atualiza `mt5linux`, `MetaTrader5` e dependências no Python do Wine

`uninstall`:
- para o processo `mt5linux`
- remove `mt5linux` do Python Linux
- remove `mt5linux` do Python do Wine

`status` mostra:
- caminho do módulo `mt5linux`
- processo ativo
- portas relevantes
- tail do log do bridge

Observação:
- o fluxo de login/criação de conta MetaTrader/MetaQuotes ainda é concluído pela UI do terminal
- o `install` já deixa stack, VNC e bridge prontos para esse passo

## Proxy para a CLI interna

Qualquer comando fora dos namespaces tratados pela função do host cai para o CLI interno do container:

```bash
dockermt ping
dockermt help
dockermt compile
dockermt expert
dockermt tester
dockermt script
```

## Troubleshooting

Se a UI não abrir:

```bash
dockermt status
dockermt logs -n 200
curl -I "http://127.0.0.1:43100/vnc/index.html"
```

Se o bridge Python não responder:

```bash
dockermt bridge status
dockermt bridge restart
dockermt bridge logs
```

Se quiser trocar persistência e defaults:

```bash
dockermt container set default image dockermt:3.1.1
dockermt container set default vol dockermt_config
dockermt container set default restart unless-stopped
```
