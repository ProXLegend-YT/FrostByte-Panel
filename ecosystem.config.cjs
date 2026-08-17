module.exports = {
  apps: [
    {
      name: "frostbyte-panel",
      script: "npm",
      args: "run start",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      max_memory_restart: "500M",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      // JWT_SECRET and ALLOWED_ORIGINS are loaded from your .env file at
      // runtime (via dotenv) — the panel will refuse to start without
      // JWT_SECRET set. Do not hardcode secrets in this file.
    },
  ],
};
