#!/bin/bash
# FrostByte Panel — one-command installer
#
# Usage:
#   bash <(curl -s https://raw.githubusercontent.com/ProXLegend-YT/FrostByte-Panel/main/install.sh)
#
# This script is designed to run non-interactively end-to-end when piped
# through `bash <(curl ...)`. It does not prompt for input during install —
# it generates a random JWT_SECRET automatically and creates the first admin
# account for you to log in and change afterward, printing the generated
# credentials at the end.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

REPO_URL="https://github.com/ProXLegend-YT/FrostByte-Panel.git"
DIR_NAME="FrostByte-Panel"

log()  { echo -e "${CYAN}[+] $1${NC}"; }
ok()   { echo -e "${GREEN}[✓] $1${NC}"; }
warn() { echo -e "${YELLOW}[!] $1${NC}"; }
fail() { echo -e "${RED}[✗] $1${NC}"; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

# --- Detect environment -----------------------------------------------------
# Some steps (system package install) need root/sudo on a normal Linux box,
# but not inside Termux (Android), which has its own package manager and no
# concept of sudo. Detect which situation we're in.
IS_TERMUX=false
if [[ -n "${TERMUX_VERSION:-}" ]] || [[ "$(uname -o 2>/dev/null || true)" == "Android" ]]; then
  IS_TERMUX=true
fi

SUDO=""
if ! $IS_TERMUX && [[ $EUID -ne 0 ]]; then
  if command_exists sudo; then
    SUDO="sudo"
  else
    fail "This script needs root privileges to install system packages. Install and re-run with a user that has sudo, or run as root."
  fi
fi

# --- Install system dependencies --------------------------------------------
log "Checking system dependencies..."

if $IS_TERMUX; then
  pkg update -y
  pkg install -y git nodejs curl
else
  $SUDO apt-get update -y
  $SUDO apt-get install -y curl git

  if ! command_exists node || [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]]; then
    log "Installing Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
  fi
fi

command_exists node || fail "Node.js installation failed."
command_exists npm  || fail "npm installation failed."

if ! command_exists pm2; then
  log "Installing PM2..."
  npm install -g pm2 || $SUDO npm install -g pm2
fi

ok "System dependencies ready ($(node -v))"

# --- Clone or update the repo ------------------------------------------------
if [[ -d "$DIR_NAME" ]]; then
  warn "'$DIR_NAME' already exists — updating instead of a fresh clone."
  cd "$DIR_NAME"
  git pull
else
  log "Cloning FrostByte Panel..."
  git clone "$REPO_URL" "$DIR_NAME"
  cd "$DIR_NAME"
fi

# --- Install packages ---------------------------------------------------------
log "Installing npm packages (this can take a few minutes)..."
npm install

# --- Environment setup --------------------------------------------------------
if [[ ! -f .env ]]; then
  log "Generating .env..."
  cp .env.example .env
  GENERATED_SECRET=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed -i.bak "s/^JWT_SECRET=.*/JWT_SECRET=${GENERATED_SECRET}/" .env && rm -f .env.bak
  ok "Generated a random JWT_SECRET in .env"
  warn "Edit .env to set ALLOWED_ORIGINS before exposing this panel publicly."
else
  ok ".env already exists, leaving it untouched."
fi

# --- Build ---------------------------------------------------------------------
log "Building the panel..."
npm run build

# --- First admin account (non-interactive) --------------------------------------
# createuser.ts is normally interactive (prompts for username/password), which
# doesn't work in a one-shot piped install. Generate random credentials
# instead and print them once at the end — the panel also supports open
# self-registration if ALLOW_REGISTRATION-style setup is preferred, but a
# ready-made admin account means there's always a guaranteed way in.
if [[ ! -s .data/users.json ]] || [[ "$(cat .data/users.json 2>/dev/null)" == "[]" ]]; then
  ADMIN_USER="admin"
  ADMIN_PASS=$(openssl rand -hex 8 2>/dev/null || node -e "console.log(require('crypto').randomBytes(8).toString('hex'))")
  log "Creating first admin account..."
  mkdir -p .data
  node -e "
    const bcrypt = require('bcryptjs');
    const fs = require('fs');
    const path = require('path');
    const { randomUUID } = require('crypto');
    const dataDir = path.join(process.cwd(), '.data');
    fs.mkdirSync(dataDir, { recursive: true });
    const usersFile = path.join(dataDir, 'users.json');
    const users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile, 'utf8')) : [];
    bcrypt.hash('$ADMIN_PASS', 10).then(hash => {
      users.push({
        id: randomUUID(),
        username: '$ADMIN_USER',
        password: hash,
        role: 'owner',
        passwordVersion: 0,
        createdAt: new Date().toISOString(),
      });
      fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
    });
  "
  ok "Admin account created."
else
  warn "Existing users found — skipping admin account creation."
fi

# --- Start with PM2 ------------------------------------------------------------
log "Starting FrostByte Panel with PM2..."
pm2 start ecosystem.config.cjs
pm2 save >/dev/null 2>&1 || true

PORT_VALUE=$(grep -E '^PORT=' .env | cut -d= -f2 || echo "3000")

echo
echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN} FrostByte Panel installed and running!${NC}"
echo -e "${GREEN}==========================================${NC}"
echo -e "  URL:      ${CYAN}http://localhost:${PORT_VALUE:-3000}${NC}"
if [[ -n "${ADMIN_USER:-}" ]]; then
  echo -e "  Username: ${CYAN}${ADMIN_USER}${NC}"
  echo -e "  Password: ${CYAN}${ADMIN_PASS}${NC}"
  echo -e "  ${YELLOW}Save this password now — it will not be shown again. Change it after logging in.${NC}"
fi
echo -e "${GREEN}==========================================${NC}"
