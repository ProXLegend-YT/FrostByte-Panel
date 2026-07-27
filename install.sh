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

# --- Step: set up a Cloudflare Tunnel ---------------------------------------
# Cloudflare Tunnel runs a small daemon (cloudflared) that opens an outbound
# connection to Cloudflare's network — no public IP, no port forwarding, no
# inbound firewall rules needed at all. This is the right fit for a server
# behind CGNAT, a home router, or (as far as it can go) Termux on a phone.
install_cloudflared() {
  if command_exists cloudflared; then return 0; fi

  log "Installing cloudflared..."
  if $IS_TERMUX; then
    pkg install -y cloudflared 2>/dev/null && return 0
    fail "cloudflared isn't available via pkg on this Termux setup. Install it manually: https://github.com/cloudflare/cloudflared"
    return 1
  fi

  local arch
  arch=$(uname -m)
  local cf_arch="amd64"
  [[ "$arch" == "aarch64" || "$arch" == "arm64" ]] && cf_arch="arm64"

  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cf_arch}" -o /tmp/cloudflared \
    && chmod +x /tmp/cloudflared \
    && $SUDO mv /tmp/cloudflared /usr/local/bin/cloudflared
  command_exists cloudflared
}

setup_cloudflare_tunnel() {
  local domain="$1"
  local backend_port="$2"

  install_cloudflared || { warn "Skipping tunnel setup — cloudflared installation failed."; return; }

  echo
  echo -e "${G}Cloudflare Tunnel needs a one-time login to your Cloudflare account to create a named, persistent tunnel for ${domain}.${NC}"
  read -r -p "$(echo -e "${G}Set up a persistent named tunnel now? [y/N] (choosing No starts a temporary quick tunnel instead, no login needed): ${NC}")" do_named

  if [[ "$do_named" =~ ^[Yy]$ ]]; then
    log "Opening Cloudflare login (a browser link will be printed — open it and authorize)..."
    cloudflared tunnel login
    local tunnel_name="frostbyte-panel"
    cloudflared tunnel create "$tunnel_name" 2>/dev/null
    cloudflared tunnel route dns "$tunnel_name" "$domain" 2>/dev/null

    mkdir -p "$HOME/.cloudflared"
    local tunnel_id
    tunnel_id=$(cloudflared tunnel list 2>/dev/null | awk -v n="$tunnel_name" '$2==n {print $1}')
    cat > "$HOME/.cloudflared/config.yml" << EOF
tunnel: ${tunnel_id}
credentials-file: ${HOME}/.cloudflared/${tunnel_id}.json
ingress:
  - hostname: ${domain}
    service: http://localhost:${backend_port}
  - service: http_status:404
EOF

    if command_exists pm2; then
      pm2 start cloudflared --name frostbyte-tunnel -- tunnel run "$tunnel_name" > /dev/null 2>&1
      pm2 save > /dev/null 2>&1 || true
      ok "Named tunnel running under PM2 as 'frostbyte-tunnel'. Panel should be reachable at https://${domain} shortly."
    else
      warn "PM2 not available to keep the tunnel running persistently. Start it manually with: cloudflared tunnel run ${tunnel_name}"
    fi
  else
    log "Starting a temporary quick tunnel (URL changes each time this runs, no login needed)..."
    warn "Quick tunnel URLs are random *.trycloudflare.com addresses, not your domain — fine for a quick demo, not for permanent use."
    nohup cloudflared tunnel --url "http://localhost:${backend_port}" > "$HOME/.cloudflared-quick.log" 2>&1 &
    sleep 5
    local quick_url
    quick_url=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$HOME/.cloudflared-quick.log" | head -1)
    if [[ -n "$quick_url" ]]; then
      ok "Quick tunnel live at: ${quick_url}"
      warn "Update ALLOWED_ORIGINS in .env to this URL (then restart) if the panel rejects requests from it."
    else
      warn "Couldn't detect the quick tunnel URL automatically — check $HOME/.cloudflared-quick.log for it."
    fi
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
  echo -e "${BLUE}── Access ──────────────────────────────────────────────────${NC}"
  echo -e "${G}Should other people be able to create their own accounts on this panel?${NC}"
  echo -e " ${W}[1]${NC} Yes — allow public self-registration (new accounts are regular users, no admin access)"
  echo -e " ${W}[2]${NC} No — only the admin account you're creating now can log in"
  read -r -p "$(echo -e "${W}Choose an option [1-2]: ${NC}")" REG_CHOICE
  if [[ "$REG_CHOICE" == "1" ]]; then
    ALLOW_REGISTRATION="true"
  else
    ALLOW_REGISTRATION="false"
  fi

  echo
  echo -e "${BLUE}── Domain & SSL ────────────────────────────────────────────${NC}"
  echo -e "${G}How will people reach this panel?${NC}"
  echo -e " ${W}[1]${NC} I have a domain pointed at this server — set up HTTPS automatically (nginx + Let's Encrypt)"
  echo -e " ${W}[2]${NC} Cloudflare (standard proxy, DNS points at this server's IP)"
  echo -e " ${W}[3]${NC} Cloudflare Tunnel (no public IP or open ports needed — good for home networks/phones)"
  echo -e " ${W}[4]${NC} Just use this server's IP address for now (plain HTTP, no domain)"
  read -r -p "$(echo -e "${W}Choose an option [1-4]: ${NC}")" DOMAIN_CHOICE

  USE_REVERSE_PROXY=false
  USE_CF_TUNNEL=false
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
      warn "Point an A record at this server's IP, then either put nginx in front yourself or use option 3 (Cloudflare Tunnel) instead."
      ;;
    3)
      read -r -p "$(echo -e "${W}Domain to use for the tunnel (e.g. panel.example.com): ${NC}")" PANEL_DOMAIN
      if [[ -n "$PANEL_DOMAIN" ]]; then
        ORIGIN="https://${PANEL_DOMAIN}"
        USE_CF_TUNNEL=true
      fi
      ;;
    *)
      PANEL_DOMAIN=""
      # Detect this server's actual reachable address so ALLOWED_ORIGINS can
      # be set correctly automatically — leaving it blank in production
      # means the panel rejects every browser request with a CORS error,
      # which is exactly the trap this branch used to fall into.
      if $IS_TERMUX; then
        DETECTED_HOST="localhost"
      else
        DETECTED_HOST=$(curl -4 -s --max-time 5 ifconfig.me || hostname -I 2>/dev/null | awk '{print $1}')
      fi
      DETECTED_HOST="${DETECTED_HOST:-localhost}"
      ORIGIN="http://${DETECTED_HOST}:3000"
      ;;
  esac

  log "Generating .env..."
  cp .env.example .env
  GENERATED_SECRET=$(random_hex 32)
  sed -i.bak "s/^JWT_SECRET=.*/JWT_SECRET=${GENERATED_SECRET}/" .env && rm -f .env.bak
  # NODE_ENV is intentionally NOT set here — Vite's build step refuses to
  # fully honor NODE_ENV=production from a .env file and warns about it,
  # and it's redundant anyway: ecosystem.config.cjs already sets it
  # correctly at runtime for PM2, independent of this file.

  sed -i.bak "s#^ALLOWED_ORIGINS=.*#ALLOWED_ORIGINS=${ORIGIN}#" .env && rm -f .env.bak
  ok "ALLOWED_ORIGINS set to ${ORIGIN}"
  if [[ -z "${PANEL_DOMAIN:-}" ]]; then
    warn "No domain set — if you access the panel from a different address than ${ORIGIN} (e.g. a different IP, or 'localhost' vs your LAN IP), update ALLOWED_ORIGINS in .env to match exactly, then 'pm2 restart frostbyte-panel'."
  fi

  log "Building the panel..."
  npm run build || { fail "Build failed."; pause; return; }

  log "Creating your admin account..."
  mkdir -p .data
  FB_ADMIN_USER="$ADMIN_USER" FB_ADMIN_PASS="$ADMIN_PASS" FB_ALLOW_REG="$ALLOW_REGISTRATION" node -e "
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

      // Whether public self-registration stays on is the operator's choice
      // from the prompt above — new accounts created that way are always
      // regular 'user' role, never admin, regardless of this setting.
      const settingsFile = path.join(dataDir, 'settings.json');
      const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
      settings.allowRegistration = process.env.FB_ALLOW_REG === 'true';
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

  if [[ "$USE_CF_TUNNEL" == "true" ]] && [[ -n "${PANEL_DOMAIN:-}" ]]; then
    setup_cloudflare_tunnel "$PANEL_DOMAIN" "$PORT_VALUE"
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

# --- Step: restart the panel --------------------------------------------------
do_restart() {
  banner
  echo -e "${W} Restart FrostByte Panel${NC}\n"

  if [[ ! -d "$DIR_NAME" ]]; then
    fail "'$DIR_NAME' not found here. Run Install first."
    pause
    return
  fi

  if ! command_exists pm2; then
    fail "PM2 isn't installed — nothing to restart."
    pause
    return
  fi

  log "Restarting FrostByte Panel..."
  pm2 restart frostbyte-panel 2>/dev/null
  if [[ $? -eq 0 ]]; then
    ok "Panel restarted."
  else
    warn "Couldn't restart 'frostbyte-panel' — it may not currently be running. Checking PM2 status..."
  fi
  pm2 status
  pause
}

# --- Step: show system info -----------------------------------------------------
do_system_info() {
  banner
  echo -e "${W} System Info${NC}\n"

  echo -e "${G}Host:${NC}         $(hostname 2>/dev/null || echo unknown)"
  echo -e "${G}OS:${NC}           $(uname -srm 2>/dev/null)"
  if $IS_TERMUX; then
    echo -e "${G}Environment:${NC}  Termux (Android)"
  else
    echo -e "${G}Environment:${NC}  Linux VPS"
  fi
  command_exists node && echo -e "${G}Node.js:${NC}      $(node -v)"
  command_exists npm  && echo -e "${G}npm:${NC}          $(npm -v)"
  command_exists docker && echo -e "${G}Docker:${NC}       $(docker -v 2>/dev/null | cut -d, -f1)"
  command_exists pm2 && echo -e "${G}PM2:${NC}          $(pm2 -v 2>/dev/null)"
  command_exists cloudflared && echo -e "${G}cloudflared:${NC} $(cloudflared -v 2>/dev/null | head -1)"

  echo
  if command_exists free; then
    echo -e "${G}Memory:${NC}"
    free -h 2>/dev/null | head -2
  fi
  echo
  echo -e "${G}Disk usage (this directory):${NC}"
  df -h . 2>/dev/null | tail -1

  if [[ -d "$DIR_NAME" ]]; then
    echo
    echo -e "${G}FrostByte Panel:${NC}"
    if command_exists pm2; then
      pm2 status 2>/dev/null | grep -E "frostbyte|App name" || echo "  Not currently running under PM2."
    fi
    if [[ -f "$DIR_NAME/.env" ]]; then
      local origin
      origin=$(grep -E '^ALLOWED_ORIGINS=' "$DIR_NAME/.env" | cut -d= -f2)
      echo -e "  ALLOWED_ORIGINS: ${origin:-<not set>}"
    fi
  fi

  pause
}

# --- Main menu -----------------------------------------------------------------
while true; do
  banner
  echo -e " ${W}[1]${NC} Install FrostByte Panel"
  echo -e " ${W}[2]${NC} Update FrostByte Panel"
  echo -e " ${W}[3]${NC} Restart FrostByte Panel"
  echo -e " ${W}[4]${NC} System Info"
  echo -e " ${RED}[0]${NC} Exit"
  echo -e " ${G}────────────────────────────────────────────────────────────────────────${NC}"
  echo -ne " ${CYAN}➜${NC} ${W}Choose an option:${NC} "
  read -r choice

  case "$choice" in
    1) do_install ;;
    2) do_update ;;
    3) do_restart ;;
    4) do_system_info ;;
    0) echo -e "\n${G}Goodbye.${NC}"; exit 0 ;;
    *) fail "Invalid option."; sleep 1 ;;
  esac
done
