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

This installs Node.js/PM2 if missing, clones the repo, installs dependencies,
generates a random `JWT_SECRET`, builds the panel, creates a first admin
account, and starts it with PM2 — printing the generated admin username and
password once at the end. **Save that password immediately**, it is not
shown again.

Re-running the same command later will `git pull` and rebuild in place
instead of re-cloning.

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
     allowed to talk to the panel from a browser.

4. Build the application:
   ```bash
   npm run build
   ```

5. Create your first admin account — either:
   - Open the panel and register normally. The **first account created on a
     fresh instance automatically becomes the owner**.
   - Or run the CLI tool, which can also promote an existing account to admin:
     ```bash
     npm run createuser
     ```

6. Start the server:
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
