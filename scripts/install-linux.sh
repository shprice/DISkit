#!/usr/bin/env bash
# DISkit Linux Installer
# Installs binary to /usr/local/bin, assets to /opt/diskit, and creates a systemd service

set -e

INSTALL_DIR="${1:-${INSTALL_DIR:-/opt/diskit}}"
BIN_DEST="${2:-${BIN_DEST:-/usr/local/bin/diskit}}"
SERVICE_FILE="/etc/systemd/system/diskit.service"

echo "=== DISkit Linux Installer ==="

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root or using sudo: sudo bash scripts/install-linux.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SOURCE_DIR="$ROOT_DIR/dist/diskit-dist"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Error: Source distribution directory not found: $SOURCE_DIR"
  echo "Please run 'npm run build:sea' first."
  exit 1
fi

# 1. Create installation directory
echo "Creating $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

# 2. Copy application assets
echo "Copying files to $INSTALL_DIR..."
cp -r "$SOURCE_DIR"/* "$INSTALL_DIR/"
mkdir -p "$INSTALL_DIR/logs"
chmod +x "$INSTALL_DIR/diskit"

# 3. Create symlink in /usr/local/bin
echo "Creating symlink $BIN_DEST..."
ln -sf "$INSTALL_DIR/diskit" "$BIN_DEST"

# 4. Create systemd service
echo "Creating systemd service at $SERVICE_FILE..."
cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=DISkit Traffic Logger and Replay Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/diskit
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
echo "Systemd service created."

echo ""
echo "=== Installation Completed Successfully ==="
echo "Binary location : $BIN_DEST"
echo "Assets location : $INSTALL_DIR"
echo ""
echo "To start DISkit manually:"
echo "  diskit"
echo ""
echo "To start as a systemd service:"
echo "  sudo systemctl enable --now diskit"
echo "=========================================="
