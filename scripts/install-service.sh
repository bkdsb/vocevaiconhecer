#!/usr/bin/env bash
# scripts/install-service.sh — Instala o worker VVC como serviço systemd do usuário ubuntu
# Executar no servidor: bash scripts/install-service.sh
set -euo pipefail

SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SERVICE_DIR}/vocevaiconhecer.service"
WORK_DIR="${1:-/home/ubuntu/vocevaiconhecer}"
NODE_BIN="$(command -v node)"

if [ ! -f "${WORK_DIR}/src/cli.js" ]; then
  echo "Erro: ${WORK_DIR}/src/cli.js não encontrado." >&2
  exit 1
fi

mkdir -p "${SERVICE_DIR}"

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=VVC Worker (Você Vai Conhecer)
After=openclaw-gateway.service
Wants=openclaw-gateway.service

[Service]
Type=simple
WorkingDirectory=${WORK_DIR}
ExecStart=${NODE_BIN} --env-file-if-exists=.env src/cli.js worker
Restart=on-failure
RestartSec=30
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

echo "Arquivo de serviço criado: ${SERVICE_FILE}"

systemctl --user daemon-reload
systemctl --user enable vocevaiconhecer
systemctl --user start vocevaiconhecer

echo ""
echo "Status do serviço:"
systemctl --user status vocevaiconhecer --no-pager || true
