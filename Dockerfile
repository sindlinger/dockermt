ARG BASE_IMAGE=sindlinger/dockermt:v3.0.0
FROM ${BASE_IMAGE}

ARG NODE_VERSION=22.14.0
ENV DOCKERMT_VERSION=v3.0.6

# Remove comandos legados e instala o runtime unico do dockermt.
RUN set -eux; \
    rm -f /usr/local/bin/cmdmtc \
          /usr/local/bin/cmdmt-map \
          /usr/local/bin/cmdmt-bootstrap \
          /usr/local/bin/cmdmt \
          /usr/local/bin/mt \
          /usr/local/bin/tmt \
          /Metatrader/cmdmtc.sh \
          /Metatrader/cmdmt-map.sh \
          /Metatrader/cmdmt-bootstrap.sh

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) node_arch="x64" ;; \
      arm64) node_arch="arm64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.gz" -o /tmp/node.tar.gz; \
    tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f /tmp/node.tar.gz; \
    node -v; \
    npm -v

RUN set -eux; \
    WINEHQ_SRC="/etc/apt/sources.list.d/winehq-bookworm.sources"; \
    if [ -f "${WINEHQ_SRC}" ]; then mv "${WINEHQ_SRC}" "${WINEHQ_SRC}.disabled"; fi; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      pkg-config \
      libpulse-dev \
      build-essential \
      python3; \
    if [ -f "${WINEHQ_SRC}.disabled" ]; then mv "${WINEHQ_SRC}.disabled" "${WINEHQ_SRC}"; fi; \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/dockermt /opt/dockermt-full /usr/local/share/dockermt

COPY runtime/INSTALL_SHIM.md /usr/local/share/dockermt/INSTALL_SHIM.md
COPY runtime/dockermt /opt/dockermt/dockermt
COPY runtime/cmdmt-full/package.json /opt/dockermt-full/package.json
COPY runtime/cmdmt-full/package-lock.json /opt/dockermt-full/package-lock.json

RUN set -eux; \
    cd /opt/dockermt-full; \
    npm ci --omit=dev --ignore-scripts

# Recompila módulo nativo do kclient para a versão atual do Node da imagem.
RUN set -eux; \
    cd /kclient; \
    npm rebuild pulseaudio2 --build-from-source

# Falha cedo no build se o binário nativo ainda estiver incompatível com a ABI do Node.
RUN set -eux; \
    cd /kclient; \
    node -e "require('pulseaudio2'); console.log('pulseaudio2 ABI OK')"

COPY runtime/cmdmt-full/dist /opt/dockermt-full/dist

RUN chmod +x /opt/dockermt/dockermt \
    && ln -sf /opt/dockermt/dockermt /usr/local/bin/dockermt

# Garante permissões de runtime para sessão gráfica/wine no volume /config.
RUN set -eux; \
    mkdir -p /etc/cont-init.d; \
    cat > /etc/cont-init.d/00-fix-config-perms <<'EOF'
#!/usr/bin/with-contenv bash
set -e
for d in /config /config/.cache /config/.config /config/.local /config/.XDG /config/.wine /config/dockermt; do
  [ -e "$d" ] || continue
  chown -R abc:abc "$d" 2>/dev/null || true
done
EOF
RUN chmod +x /etc/cont-init.d/00-fix-config-perms

# Evita falha de conexão no noVNC em alguns navegadores:
# mantém auth na página, mas libera auth no websocket /websockify.
# Observação: o init-nginx recria /etc/nginx/sites-available/default a partir de /defaults/default.conf.
RUN set -eux; \
    perl -0777 -i -pe "s/(location SUBFOLDERwebsockify \\{\\n)/\\1    auth_basic off;\\n/g" /defaults/default.conf

# Provisioning padrão: manter serviço TelnetMT + bootstrap habilitados.
RUN set -eux; \
    sed -i 's/TELNETMT_ENABLE="${TELNETMT_ENABLE:-0}"/TELNETMT_ENABLE="${TELNETMT_ENABLE:-1}"/' /Metatrader/start.sh; \
    sed -i 's/CMDMT_BOOTSTRAP_ENABLE="${CMDMT_BOOTSTRAP_ENABLE:-0}"/CMDMT_BOOTSTRAP_ENABLE="${CMDMT_BOOTSTRAP_ENABLE:-1}"/' /Metatrader/start.sh

# Remove credenciais hardcoded de common.ini no workspace interno da imagem (se existir).
RUN set -eux; \
    node -e "const fs=require('fs'); const p='/opt/dockermt-full/workspaces/default/.cmdmt/terminal/config/common.ini'; if(fs.existsSync(p)){ let t=fs.readFileSync(p,'utf16le'); t=t.replace(/^\\uFEFF/,'').replace(/^\\s*Login=.*\\r?\\n/gim,'').replace(/^\\s*Password=.*\\r?\\n/gim,'').replace(/^\\s*Server=.*\\r?\\n/gim,''); fs.writeFileSync(p,'\\uFEFF'+t,'utf16le'); }"

# Compatibilidade de caminho legado (sem quebrar wrappers antigos).
RUN mkdir -p /opt/cmdmt/dist /Metatrader \
    && ln -sf /opt/dockermt-full/dist/index.js /opt/cmdmt/dist/index.js \
    && ln -sf /opt/dockermt-full/dist/dockermt.js /opt/cmdmt/dist/dockermt.js \
    && printf '#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/local/bin/dockermt "$@"\n' > /Metatrader/dockermt.sh \
    && chmod +x /Metatrader/dockermt.sh
