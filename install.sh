#!/bin/bash
# ===========================================================
# FrostByte Panel — Installer & Manager
#
# Usage:
#   bash <(curl -s https://raw.githubusercontent.com/ProXLegend-YT/FrostByte-Panel/main/install.sh)
# ===========================================================
set -uo pipefail

CYAN='\033[1;38;5;51m'
BLUE='\033[1;38;5;33m'
GREEN='\033[1;38;5;82m'
YELLOW='\033[1;38;5;220m'
RED='\033[1;38;5;196m'
W='\033[1;38;5;255m'
G='\033[0;38;5;244m'
NC='\033[0m'

REPO_URL="https://github.com/ProXLegend-YT/FrostByte-Panel.git"
DIR_NAME="FrostByte-Panel"

log()  { echo -e "${CYAN}[+]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
fail() { echo -e "${RED}[✗]${NC} $1"; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

banner() {
  clear
  echo -e "${CYAN}"
  echo "  ███████╗██████╗  ██████╗ ███████╗████████╗██████╗ ██╗   ██╗████████╗███████╗"
  echo "  ██╔════╝██╔══██╗██╔═══██╗██╔════╝╚══██╔══╝██╔══██╗╚██╗ ██╔╝╚══██╔══╝██╔════╝"
  echo "  █████╗  ██████╔╝██║   ██║███████╗   ██║   ██████╔╝ ╚████╔╝    ██║   █████╗  "
  echo "  ██╔══╝  ██╔══██╗██║   ██║╚════██║   ██║   ██╔══██╗  ╚██╔╝     ██║   ██╔══╝  "
  echo "  ██║     ██║  ██║╚██████╔╝███████║   ██║   ██████╔╝   ██║      ██║   ███████╗"
  echo "  ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝   ╚═╝   ╚═════╝    ╚═╝      ╚═╝   ╚══════╝"
  echo -e "${NC}                        ${G}Self-hosted game server management${NC}"
  echo -e " ${G}────────────────────────────────────────────────────────────────────────${NC}"
}

pause() { echo; read -r -p "$(echo -e "${G}Press Enter to return to the menu...${NC}")"; }

# --- Environment detection --------------------------------------------------
IS_TERMUX=false
if [[ -n "${TERMUX_VERSION:-}" ]] || [[ "$(uname -o 2>/dev/null || true)" == "Android" ]]; then
  IS_TERMUX=true
fi

SUDO=""
if ! $IS_TERMUX && [[ $EUID -ne 0 ]]; then
  if command_exists sudo; then
    SUDO="sudo"
  fi
fi

random_hex() {
  local bytes="$1"
  openssl rand -hex "$bytes" 2>/dev/null || node -e "console.log(require('crypto').randomBytes($bytes).toString('hex'))"
}

# --- Step: install system dependencies --------------------------------------
install_dependencies() {
  log "Checking system dependencies..."

  if $IS_TERMUX; then
    pkg update -y
    pkg install -y git nodejs curl python clang make openssl-tool
  else
    if [[ -n "$SUDO" ]] || [[ $EUID -eq 0 ]]; then
      $SUDO apt-get update -y
      $SUDO apt-get install -y curl git ca-certificates
      if ! command_exists node || [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]]; then
        log "Installing Node.js 20.x..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
        $SUDO apt-get install -y nodejs
      fi
      if ! command_exists docker; then
        log "Installing Docker..."
        curl -fsSL https://get.docker.com | $SUDO sh
      fi
    else
      fail "Need root or sudo to install system packages. Re-run as root or with a sudo-capable user."
      return 1
    fi
  fi

  command_exists node || { fail "Node.js installation failed."; return 1; }
  command_exists npm  || { fail "npm installation failed."; return 1; }

  if ! command_exists pm2; then
    log "Installing PM2..."
    npm install -g pm2 || $SUDO npm install -g pm2
  fi

  ok "System dependencies ready ($(node -v))"
  return 0
}

# --- Step: prompt for admin credentials -------------------------------------
# Unlike a normal signup form, this always runs on the machine the operator
# controls (their VPS terminal), not over the network — so the panel's very
# first admin account is created out-of-band from the public web UI. Public
# self-registration is then switched off by default, so nobody can ever
# create an additional admin/owner account through the login page alone.
prompt_admin_credentials() {
  echo
  echo -e "${BLUE}── Create your admin account ──────────────────────────────${NC}"
  echo -e "${G}This account will own the panel. You'll sign in with it after install.${NC}"
  echo

  while true; do
    read -r -p "$(echo -e "${W}Admin username:${NC} ")" ADMIN_USER
    if [[ "$ADMIN_USER" =~ ^[a-zA-Z0-9_.-]{3,32}$ ]]; then
      break
    fi
    fail "Username must be 3-32 characters (letters, numbers, _ . -)"
  done

  while true; do
    read -r -s -p "$(echo -e "${W}Admin password (min 8 chars):${NC} ")" ADMIN_PASS
    echo
    if [[ ${#ADMIN_PASS} -lt 8 ]]; then
      fail "Password must be at least 8 characters."
      continue
    fi
    read -r -s -p "$(echo -e "${W}Confirm password:${NC} ")" ADMIN_PASS_CONFIRM
    echo
    if [[ "$ADMIN_PASS" != "$ADMIN_PASS_CONFIRM" ]]; then
      fail "Passwords did not match. Try again."
      continue
    fi
    break
  done
}

# --- Step: set up nginx reverse proxy + Let's Encrypt SSL ------------------
setup_reverse_proxy() {
  local domain="$1"
  local backend_port="$2"

  if $IS_TERMUX; then
    warn "Automatic nginx/SSL setup isn't available on Termux/Android. Set up a reverse proxy on a real Linux host to use HTTPS with a domain."
    return
  fi

  log "Setting up nginx reverse proxy for ${domain}..."
  $SUDO apt-get install -y nginx > /dev/null 2>&1

  local site_conf="/etc/nginx/sites-available/frostbyte-panel"
  $SUDO tee "$site_conf" > /dev/null << EOF
server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${backend_port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

  $SUDO ln -sf "$site_conf" /etc/nginx/sites-enabled/frostbyte-panel 2>/dev/null
  $SUDO nginx -t > /dev/null 2>&1 && $SUDO systemctl reload nginx
  ok "nginx reverse proxy configured for ${domain} → localhost:${backend_port}"

  read -r -p "$(echo -e "${G}Set up free HTTPS now via Let's Encrypt? This requires ${domain} to already point at this server's IP. [y/N]: ${NC}")" do_ssl
  if [[ "$do_ssl" =~ ^[Yy]$ ]]; then
    log "Installing Certbot and requesting a certificate..."
    $SUDO apt-get install -y certbot python3-certbot-nginx > /dev/null 2>&1
    if $SUDO certbot --nginx -d "$domain" --non-interactive --agree-tos -m "admin@${domain}" --redirect; then
      ok "HTTPS is live at https://${domain}"
    else
      warn "Certbot failed — this usually means ${domain} isn't pointed at this server's IP yet, or port 80 isn't reachable from the internet. You can re-run 'sudo certbot --nginx -d ${domain}' later once DNS is set up."
    fi
  else
    warn "Skipped SSL setup. The panel is reachable over plain HTTP at http://${domain} until you set up HTTPS."
  fi
}

# --- Step: install the panel -------------------------------------------------
do_install() {
  banner
  echo -e "${W} Install FrostByte Panel${NC}\n"

  if [[ -d "$DIR_NAME" ]]; then
    warn "'$DIR_NAME' already exists here."
    read -r -p "$(echo -e "${G}Remove it and reinstall fresh? [y/N]: ${NC}")" confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
      rm -rf "$DIR_NAME"
    else
      warn "Aborting install. Use 'Update FrostByte Panel' from the menu instead if you meant to update."
      pause
      return
    fi
  fi

  install_dependencies || { pause; return; }

  log "Cloning FrostByte Panel..."
  git clone "$REPO_URL" "$DIR_NAME" || { fail "Clone failed."; pause; return; }
  cd "$DIR_NAME" || return

  log "Installing npm packages (this can take a few minutes)..."
  npm install || { fail "npm install failed."; pause; return; }

  prompt_admin_credentials

  echo
  echo -e "${BLUE}── Domain & SSL ────────────────────────────────────────────${NC}"
  echo -e "${G}How will people reach this panel?${NC}"
  echo -e " ${W}[1]${NC} I have a domain pointed at this server — set up HTTPS automatically (nginx + Let's Encrypt)"
  echo -e " ${W}[2]${NC} I'm using Cloudflare in front of this server"
  echo -e " ${W}[3]${NC} Just use this server's IP address for now (plain HTTP, no domain)"
  read -r -p "$(echo -e "${W}Choose an option [1-3]: ${NC}")" DOMAIN_CHOICE

  USE_REVERSE_PROXY=false
  case "$DOMAIN_CHOICE" in
    1)
      read -r -p "$(echo -e "${W}Domain (e.g. panel.example.com): ${NC}")" PANEL_DOMAIN
      if [[ -n "$PANEL_DOMAIN" ]]; then
        ORIGIN="https://${PANEL_DOMAIN}"
        USE_REVERSE_PROXY=true
      fi
      ;;
    2)
      read -r -p "$(echo -e "${W}Domain behind Cloudflare (e.g. panel.example.com): ${NC}")" PANEL_DOMAIN
      if [[ -n "$PANEL_DOMAIN" ]]; then
        ORIGIN="https://${PANEL_DOMAIN}"
      fi
      warn "Set Cloudflare's SSL/TLS mode to 'Full' or 'Full (strict)' — 'Flexible' will break login sessions."
      warn "Point an A record at this server's IP, then either put nginx in front yourself or use a Cloudflare Tunnel."
      ;;
    *)
      PANEL_DOMAIN=""
      ;;
  esac

  log "Generating .env..."
  cp .env.example .env
  GENERATED_SECRET=$(random_hex 32)
  sed -i.bak "s/^JWT_SECRET=.*/JWT_SECRET=${GENERATED_SECRET}/" .env && rm -f .env.bak
  sed -i.bak "s/^NODE_ENV=.*/NODE_ENV=production/" .env && rm -f .env.bak

  if [[ -n "${PANEL_DOMAIN:-}" ]]; then
    sed -i.bak "s#^ALLOWED_ORIGINS=.*#ALLOWED_ORIGINS=${ORIGIN}#" .env && rm -f .env.bak
    ok "ALLOWED_ORIGINS set to ${ORIGIN}"
  else
    warn "No domain set. ALLOWED_ORIGINS left blank — set it in .env before exposing this panel publicly."
  fi

  log "Building the panel..."
  npm run build || { fail "Build failed."; pause; return; }

  log "Creating your admin account..."
  mkdir -p .data
  FB_ADMIN_USER="$ADMIN_USER" FB_ADMIN_PASS="$ADMIN_PASS" node -e "
    const bcrypt = require('bcryptjs');
    const fs = require('fs');
    const path = require('path');
    const { randomUUID } = require('crypto');
    const dataDir = path.join(process.cwd(), '.data');
    fs.mkdirSync(dataDir, { recursive: true });

    const username = process.env.FB_ADMIN_USER;
    const password = process.env.FB_ADMIN_PASS;
    if (!username || !password) {
      console.error('Admin username/password were not passed to the account-creation step.');
      process.exit(1);
    }

    const usersFile = path.join(dataDir, 'users.json');
    const users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile, 'utf8')) : [];
    bcrypt.hash(password, 10).then(hash => {
      users.push({
        id: randomUUID(),
        username: username,
        password: hash,
        role: 'owner',
        passwordVersion: 0,
        createdAt: new Date().toISOString(),
      });
      fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));

      // Public self-registration is switched off by default once an admin
      // account exists from the installer — the panel's admin can turn it
      // back on later from Settings if they want open signups.
      const settingsFile = path.join(dataDir, 'settings.json');
      const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
      settings.allowRegistration = false;
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    }).catch(err => {
      console.error('Failed to hash password:', err.message);
      process.exit(1);
    });
  " || { fail "Failed to create admin account."; pause; return; }
  unset ADMIN_PASS ADMIN_PASS_CONFIRM

  log "Starting FrostByte Panel with PM2..."
  pm2 start ecosystem.config.cjs
  pm2 save >/dev/null 2>&1 || true

  PORT_VALUE=$(grep -E '^PORT=' .env | cut -d= -f2)
  PORT_VALUE="${PORT_VALUE:-3000}"

  if [[ "$USE_REVERSE_PROXY" == "true" ]] && [[ -n "${PANEL_DOMAIN:-}" ]]; then
    setup_reverse_proxy "$PANEL_DOMAIN" "$PORT_VALUE"
  fi

  echo
  echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN} FrostByte Panel is installed and running!${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
  if [[ -n "$PANEL_DOMAIN" ]]; then
    echo -e "  URL:      ${CYAN}${ORIGIN}${NC}"
  else
    echo -e "  URL:      ${CYAN}http://<your-server-ip>:${PORT_VALUE}${NC}"
  fi
  echo -e "  Username: ${CYAN}${ADMIN_USER}${NC}"
  echo -e "  ${G}(password is what you just entered — it is not stored anywhere by this script)${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
  cd ..
  pause
}

# --- Step: update the panel ---------------------------------------------------
do_update() {
  banner
  echo -e "${W} Update FrostByte Panel${NC}\n"

  if [[ ! -d "$DIR_NAME" ]]; then
    fail "'$DIR_NAME' not found here. Run Install first."
    pause
    return
  fi

  cd "$DIR_NAME" || return
  log "Pulling latest changes..."
  git stash
  git pull || { fail "git pull failed."; cd ..; pause; return; }

  log "Installing dependencies..."
  npm install || { fail "npm install failed."; cd ..; pause; return; }

  log "Rebuilding..."
  npm run build || { fail "Build failed."; cd ..; pause; return; }

  log "Restarting..."
  pm2 restart all 2>/dev/null || pm2 start ecosystem.config.cjs
  pm2 save >/dev/null 2>&1 || true

  ok "FrostByte Panel updated and restarted."
  cd ..
  pause
}

# --- Main menu -----------------------------------------------------------------
while true; do
  banner
  echo -e " ${W}[1]${NC} Install FrostByte Panel"
  echo -e " ${W}[2]${NC} Update FrostByte Panel"
  echo -e " ${RED}[0]${NC} Exit"
  echo -e " ${G}────────────────────────────────────────────────────────────────────────${NC}"
  echo -ne " ${CYAN}➜${NC} ${W}Choose an option:${NC} "
  read -r choice

  case "$choice" in
    1) do_install ;;
    2) do_update ;;
    0) echo -e "\n${G}Goodbye.${NC}"; exit 0 ;;
    *) fail "Invalid option."; sleep 1 ;;
  esac
done
