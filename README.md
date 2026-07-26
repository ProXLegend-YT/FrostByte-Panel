# FrostByte Panel

A self-hostable, futuristic game server management panel with a Docker-backed
file manager, live console, real SFTP access (port 6868), plugin/mod
installers, backups, and sub-user permissions.

## Requirements

- Node.js 20+
- Docker (for managing game server containers)

## Quick Install (one command)

```bash
bash <(curl -s https://raw.githubusercontent.com/ProXLegend-YT/FrostByte-Panel/main/install.sh)
```

Works on any standard Linux VPS (Ubuntu/Debian — Hetzner, DigitalOcean, Contabo, Vultr, etc.) as root or a sudo-capable user. It also runs on Termux (Android), though real Docker-based game servers require a proper Linux host — Termux is fine for development/testing the panel itself, not for actually hosting containers.

This opens an interactive menu — choose **Install** to set up FrostByte Panel
from scratch, or **Update** to pull and rebuild an existing install.

During install you'll be asked to install Docker/Node.js/PM2 (if missing),
then to **choose your own admin username and password** right there in the
terminal, and how the panel should be reached:

- **A domain you own** — the installer sets up nginx as a reverse proxy and
  can request a free Let's Encrypt SSL certificate automatically (as long as
  the domain's DNS already points at this server).
- **Cloudflare in front of the server** — the installer sets `ALLOWED_ORIGINS`
  correctly and reminds you to use Cloudflare's "Full" or "Full (strict)"
  SSL mode.
- **Just the server's IP** — plain HTTP, configure a domain later.

That admin account becomes the panel's owner. Public self-registration is
switched off automatically once it's created — nobody can create an
additional admin account through the web login page.

Re-running the installer and choosing Update will `git pull`, reinstall
dependencies, rebuild, and restart the panel in place.

## Manual Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/ProXLegend-YT/FrostByte-Panel.git
   cd FrostByte-Panel
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` and set at minimum:
   - `JWT_SECRET` — a long random secret (e.g. `openssl rand -hex 32`). The panel
     will refuse to start without this.
   - `ALLOWED_ORIGINS` — required in production; comma-separated list of origins
     allowed to talk to the panel from a browser. If you're putting Cloudflare
     in front of the panel, this should be the exact public origin your
     visitors use (e.g. `https://panel.example.com`), and Cloudflare's SSL
     mode should be set to "Full" or "Full (strict)".

4. Build the application:
   ```bash
   npm run build
   ```

5. Create your admin account with the CLI tool:
   ```bash
   npm run createuser
   ```
   This prompts for a username/password in the terminal and creates an admin
   account directly — no public signup involved.

6. (Recommended) Disable public self-registration, so the account you just
   created stays the only way in. In `.data/settings.json`, set:
   ```json
   { "allowRegistration": false }
   ```
   You can toggle this later from the panel's Settings page as an admin.

7. Start the server:
   ```bash
   npm run start
   ```

## Development

To run the panel in development mode with auto-reloading:

```bash
npm run dev
```

## Security notes

- Never commit your `.env` file or share your `JWT_SECRET`.
- Set `ALLOWED_ORIGINS` before exposing the panel publicly — without it in
  production, cross-origin requests are rejected by default.
- Regular users can only access servers they own or have been added to as a
  sub-user. Admin/owner accounts can access everything.

## Using a custom domain / Cloudflare

If you used the one-command installer and chose the domain or Cloudflare
option, this is already set up for you. This section is for setting it up
manually (fresh manual install, or changing it later):

1. Point your domain's DNS at your VPS's IP address (an A record).
2. If using Cloudflare: enable the orange-cloud proxy, and set **SSL/TLS mode
   to "Full" or "Full (strict)"** under Cloudflare's SSL/TLS settings —
   "Flexible" mode will break the panel's cookie/session handling.
3. Set `ALLOWED_ORIGINS` in `.env` to your exact public URL, e.g.
   `ALLOWED_ORIGINS=https://panel.example.com`.
4. Put a reverse proxy (nginx, Caddy, or Cloudflare Tunnel) in front of the
   panel to terminate HTTPS and forward to `localhost:3000` (or whatever
   `PORT` you set) — FrostByte Panel itself serves plain HTTP. For nginx +
   Let's Encrypt specifically, `sudo certbot --nginx -d your-domain.com`
   after pointing nginx at the panel will handle certificate issuance and
   renewal automatically.
