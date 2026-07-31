import "dotenv/config";
import express from "express";
import path from "path";
import cors from "cors";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { createServer as createViteServer } from "vite";
import fs from "fs-extra";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error(
    "FATAL: JWT_SECRET environment variable is not set. " +
    "Set a long random secret before starting FrostByte Panel (e.g. `openssl rand -hex 32`)."
  );
  process.exit(1);
}

// Comma-separated list of allowed origins, e.g. "https://panel.example.com,https://admin.example.com"
// Falls back to reflecting no origin restriction only in local development.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // same-origin / non-browser clients
    if (ALLOWED_ORIGINS.length === 0) {
      if (process.env.NODE_ENV !== "production") return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    }
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
};

const app = express();
const httpServer = createServer(app);
export const io = new SocketIOServer(httpServer, {
  cors: corsOptions as any,
});
app.set("io", io);

// Initialize data folders
const DATA_DIR = path.join(process.cwd(), ".data");
const SERVERS_DIR = path.join(DATA_DIR, "servers");
const BACKUPS_DIR = path.join(process.cwd(), "backups");

fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(SERVERS_DIR);
fs.ensureDirSync(BACKUPS_DIR);
fs.ensureDirSync(path.join(DATA_DIR, "temp"));

if (!fs.existsSync(path.join(DATA_DIR, "users.json"))) fs.writeFileSync(path.join(DATA_DIR, "users.json"), "[]");
if (!fs.existsSync(path.join(DATA_DIR, "servers.json"))) fs.writeFileSync(path.join(DATA_DIR, "servers.json"), "[]");
if (!fs.existsSync(path.join(DATA_DIR, "settings.json"))) fs.writeFileSync(path.join(DATA_DIR, "settings.json"), "{}");

import { attachContainerSocket, getContainerLogs } from "./src/server/services/docker.js";

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error"));
  try {
    const verified: any = jwt.verify(token, JWT_SECRET);
    const { readJSON } = await import("./src/server/services/db.js");
    const users = await readJSON("users.json") || [];
    const user = users.find((u: any) => u.id === verified.id);
    if (!user) return next(new Error("Authentication error"));
    if ((user.passwordVersion || 0) !== (verified.passwordVersion || 0)) {
      return next(new Error("Session expired"));
    }
    (socket as any).user = verified;
    next();
  } catch (err) {
    next(new Error("Authentication error"));
  }
});

io.on("connection", (socket) => {
  // Every authenticated connection automatically joins its own private room,
  // used for personal notifications (backup complete, added as a sub-user,
  // etc.) that shouldn't be visible to anyone else in a shared server room.
  const connectedUser = (socket as any).user;
  if (connectedUser?.id) {
    socket.join(`user_${connectedUser.id}`);
  }

  socket.on("joinServer", async (serverId) => {
    try {
      const user = (socket as any).user;
      const serversJSON = await fs.readFile(path.join(DATA_DIR, "servers.json"), "utf8");
      const servers = JSON.parse(serversJSON);
      const server = Array.isArray(servers) ? servers.find((s: any) => s.id === serverId) : null;
      if (!server) return;

      const isPrivileged = user.role === "admin" || user.role === "owner";
      const isOwner = server.owner === user.id;
      const isSubUser = (server.subUsers || []).some((su: any) => su.userId === user.id);
      if (!isPrivileged && !isOwner && !isSubUser) {
        return; // silently refuse to join a server this user has no access to
      }

      socket.join(`server_${serverId}`);

      // Ensure logs are streamed if container is already running
      if (server.containerId) {
        const logs = await getContainerLogs(server.containerId);
        if (logs) {
           socket.emit("log", logs.trim() + "\n");
        }
        await attachContainerSocket(server.containerId, serverId);
      }
    } catch (e) {
      console.error(e);
    }
  });
  socket.on("leaveServer", (serverId) => {
    socket.leave(`server_${serverId}`);
  });
});

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(cors(corsOptions));

import apiRoutes from "./src/server/routes/api.js";
app.use("/api", apiRoutes);

import { initSFTPServer } from "./src/server/services/sftp.js";
import { startScheduler } from "./src/server/services/scheduler.js";

async function startServer() {
  await initSFTPServer();
  startScheduler();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const HOST = process.env.HOST || "0.0.0.0";
  httpServer.listen(Number(PORT), HOST, () => {
    console.log(`FrostByte Panel running on http://${HOST}:${PORT}`);
  });
}

startServer();

const CRASH_LOG = path.join(process.cwd(), ".data", "crash.log");
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  try { fs.appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] ${String(err.stack)}\n`); } catch {}
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  try { fs.appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] ${String(reason)}\n`); } catch {}
});
