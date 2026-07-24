import express from "express";
import path from "path";
import { requireAuth, requireServerAccess } from "../middleware/auth.js";
import { getServers, createServer, getServer, deleteServer, startServer, stopServer, restartServer, changeServerVersion, updateServerResources, getFiles, uploadFile, deleteFile, renameFile, saveFileContent, sendCommand, getServerStats, updateOwner, updateIpAlias, getBackups, createBackup, downloadBackup, deleteBackup, unzipFile, zipFiles, installPlugin, installMod } from "../controllers/servers.js";
import multer from "multer";

const router = express.Router();
const upload = multer({ dest: path.join(process.cwd(), ".data/temp/") });

router.use(requireAuth);

router.get("/", getServers);
router.post("/", createServer);
router.get("/:id", requireServerAccess(), getServer);
router.get("/:id/stats", requireServerAccess(), getServerStats);
router.delete("/:id", requireServerAccess(), deleteServer);
router.put("/:id/owner", requireServerAccess(), updateOwner);
router.put("/:id/ipalias", requireServerAccess("settings"), updateIpAlias);

router.put("/:id/version", requireServerAccess("settings"), changeServerVersion);
router.put("/:id/resources", requireServerAccess(), updateServerResources);

router.post("/:id/start", requireServerAccess("power"), startServer);
router.post("/:id/stop", requireServerAccess("power"), stopServer);
router.post("/:id/restart", requireServerAccess("power"), restartServer);
router.post("/:id/command", requireServerAccess("console"), sendCommand);

// Simple file endpoints
router.get("/:id/files", requireServerAccess("files"), getFiles);
router.post("/:id/files/upload", requireServerAccess("files"), upload.single("file"), uploadFile);
router.post("/:id/files/rename", requireServerAccess("files"), renameFile);
router.post("/:id/files/save", requireServerAccess("files"), saveFileContent);
router.post("/:id/files/unzip", requireServerAccess("files"), unzipFile);
router.post("/:id/files/zip", requireServerAccess("files"), zipFiles);
router.delete("/:id/files", requireServerAccess("files"), deleteFile);

// Backup endpoints
router.get("/:id/backups", requireServerAccess("backups"), getBackups);
router.post("/:id/backups", requireServerAccess("backups"), createBackup);
router.get("/:id/backups/:filename", requireServerAccess("backups"), downloadBackup);
router.delete("/:id/backups/:filename", requireServerAccess("backups"), deleteBackup);


router.get("/:id/playit", requireServerAccess("settings"), async (req, res) => {
  const server = (req as any).server;
  const serverName = server.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const pm2Name = `playit_${serverName}`;

  const { execFile } = await import("child_process");

  execFile("npx", ["pm2", "jlist"], (err, stdout) => {
    let status = "stopped";
    try {
      const jsonStart = stdout.indexOf('[');
      const jsonEnd = stdout.lastIndexOf(']');
      const jsonStr = jsonStart !== -1 && jsonEnd !== -1 ? stdout.substring(jsonStart, jsonEnd + 1) : stdout;
      const pm2List = JSON.parse(jsonStr);
      const playitProcess = pm2List.find((p: any) => p.name === pm2Name);
      if (playitProcess && playitProcess.pm2_env && playitProcess.pm2_env.status === "online") {
        status = "running";
      }
    } catch (e) {}

    if (status === "running") {
      execFile("npx", ["pm2", "logs", pm2Name, "--nostream", "--lines", "100"], (err, logStdout) => {
        const logs = (logStdout || "").replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b./g, "");
        const claimLinkMatches = logs.match(/https:\/\/playit\.gg\/claim\/[a-zA-Z0-9]+/g);
        res.json({
          status,
          claimLink: claimLinkMatches ? claimLinkMatches[claimLinkMatches.length - 1] : null,
          logs: logs.split('\n').slice(-50).join('\n')
        });
      });
    } else {
      res.json({ status: "stopped", claimLink: null, logs: "" });
    }
  });
});

router.post("/:id/playit/start", requireServerAccess("settings"), async (req, res) => {
  const { id } = req.params;
  const server = (req as any).server;
  const serverName = server.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const pm2Name = `playit_${serverName}`;

  const serverDir = path.join(process.cwd(), ".data", "servers", id);
  const playitBin = path.join(serverDir, `playit_${serverName}`);
  const secretPath = path.join(serverDir, "playit.toml");

  const { execFile } = await import("child_process");
  const fsp = await import("fs/promises");
  const fssync = await import("fs");

  const run = (cmd: string, args: string[]) =>
    new Promise<{ err: any; stdout: string; stderr: string }>((resolve) => {
      execFile(cmd, args, (err, stdout, stderr) => resolve({ err, stdout: stdout || "", stderr: stderr || "" }));
    });

  try {
    await fsp.mkdir(serverDir, { recursive: true });

    if (!fssync.existsSync(playitBin)) {
      const https = await import("https");
      await new Promise<void>((resolve, reject) => {
        const file = fssync.createWriteStream(playitBin);
        const download = (url: string) => {
          https.get(url, (response) => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
              return download(response.headers.location);
            }
            if (response.statusCode !== 200) {
              return reject(new Error(`Failed to download playit agent: HTTP ${response.statusCode}`));
            }
            response.pipe(file);
            file.on("finish", () => file.close(() => resolve()));
          }).on("error", reject);
        };
        download("https://github.com/playit-cloud/playit-agent/releases/download/v0.15.26/playit-linux-amd64");
      });
      await fsp.chmod(playitBin, 0o755);
    }

    await run("npx", ["pm2", "delete", pm2Name]).catch(() => {});
    await run("npx", ["pm2", "flush", pm2Name]).catch(() => {});

    const { err, stderr } = await run("npx", [
      "pm2", "start", playitBin,
      "--name", pm2Name,
      "--", "-s", "--secret_path", secretPath,
    ]);
    if (err) {
      return res.status(500).json({ error: "Failed to start Playit Tunnel", details: stderr });
    }
    await run("npx", ["pm2", "save"]).catch(() => {});
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: "Failed to start Playit Tunnel", details: e.message });
  }
});

router.post("/:id/playit/stop", requireServerAccess("settings"), async (req, res) => {
  const server = (req as any).server;
  const serverName = server.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const pm2Name = `playit_${serverName}`;

  const { execFile } = await import("child_process");
  execFile("npx", ["pm2", "delete", pm2Name], async () => {
    execFile("npx", ["pm2", "save"], () => {
      res.json({ success: true });
    });
  });
});

router.post("/:id/playit/reset", requireServerAccess("settings"), async (req, res) => {
  const { id } = req.params;
  const server = (req as any).server;
  const serverName = server.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const pm2Name = `playit_${serverName}`;
  const serverDir = path.join(process.cwd(), ".data", "servers", id);
  const secretPath = path.join(serverDir, "playit.toml");

  const { execFile } = await import("child_process");
  const fsp = await import("fs/promises");

  execFile("npx", ["pm2", "delete", pm2Name], async () => {
    execFile("npx", ["pm2", "flush", pm2Name], async () => {
      await fsp.unlink(secretPath).catch(() => {});
      execFile("npx", ["pm2", "save"], () => {
        res.json({ success: true });
      });
    });
  });
});

// Sub-users endpoints (owner/admin only — a sub-user must never be able to
// grant themselves or others additional access to the server)
router.get("/:id/subusers", requireServerAccess(), async (req, res) => {
  try {
    const server = (req as any).server;
    const { readJSON } = await import("../services/db.js");
    const users = await readJSON("users.json") || [];
    res.json({
      subUsers: server.subUsers || [],
      availableUsers: users.map((u: any) => ({ id: u.id, username: u.username }))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/subusers", requireServerAccess(), async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, permissions } = req.body;
    const { updateJSON } = await import("../services/db.js");

    let notFound = false;
    let isNewSubUser = false;
    let serverName = "";
    let resultSubUsers: any[] = [];

    await updateJSON<any[]>("servers.json", (current) => {
      const servers = current || [];
      const serverIndex = servers.findIndex((s: any) => s.id === id);
      if (serverIndex === -1) { notFound = true; return servers; }

      if (!servers[serverIndex].subUsers) servers[serverIndex].subUsers = [];
      const subUserIndex = servers[serverIndex].subUsers.findIndex((su: any) => su.userId === userId);
      isNewSubUser = subUserIndex === -1;

      if (subUserIndex !== -1) {
        servers[serverIndex].subUsers[subUserIndex].permissions = permissions;
      } else {
        servers[serverIndex].subUsers.push({ userId, permissions });
      }

      serverName = servers[serverIndex].name;
      resultSubUsers = servers[serverIndex].subUsers;
      return servers;
    });

    if (notFound) return res.status(404).json({ error: "Server not found" });

    const actingUser = (req as any).user;
    const { logActivity } = await import("../services/activityLog.js");
    logActivity({
      actorId: actingUser.id, actorUsername: actingUser.username,
      action: "subuser.add", target: serverName, serverId: id,
    });

    if (isNewSubUser) {
      const { notifyUser } = await import("../services/notifications.js");
      notifyUser(userId, {
        type: "info",
        title: "Server access granted",
        message: `You were added to "${serverName}" by ${actingUser.username}.`,
        serverId: id,
        link: `/servers/${id}`,
      }).catch(() => {});
    }

    res.json({ success: true, subUsers: resultSubUsers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id/subusers/:userId", requireServerAccess(), async (req, res) => {
  try {
    const { id, userId } = req.params;
    const { updateJSON } = await import("../services/db.js");

    let notFound = false;
    let resultSubUsers: any[] = [];

    await updateJSON<any[]>("servers.json", (current) => {
      const servers = current || [];
      const serverIndex = servers.findIndex((s: any) => s.id === id);
      if (serverIndex === -1) { notFound = true; return servers; }

      if (!servers[serverIndex].subUsers) servers[serverIndex].subUsers = [];
      servers[serverIndex].subUsers = servers[serverIndex].subUsers.filter((su: any) => su.userId !== userId);
      resultSubUsers = servers[serverIndex].subUsers;
      return servers;
    });

    if (notFound) return res.status(404).json({ error: "Server not found" });

    res.json({ success: true, subUsers: resultSubUsers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

import { createSftpUser, resetSftpPassword, getSftpUser, deleteSftpUser } from "../services/sftp.js";

// SFTP endpoints
router.get("/:id/sftp", requireServerAccess("files"), async (req, res) => {
  try {
    const { id } = req.params;
    const user = await getSftpUser(id);
    if (!user) return res.status(404).json({ error: "SFTP user not found" });
    
    // We don't send the password hash, but we might want to generate a new temporary 
    // or just say it's hidden. But the UI expects the password to be returned upon creation/reset.
    // So for GET, we don't have the plaintext password. We'll return a placeholder.
    res.json({
      host: req.headers.host?.split(":")[0] || "127.0.0.1",
      port: 6868,
      username: user.username,
      password: "(Hidden - Reset to reveal)"
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/sftp/create", requireServerAccess("files"), async (req, res) => {
  try {
    const { id } = req.params;
    const creds = await createSftpUser(id);
    res.json({
      host: req.headers.host?.split(":")[0] || "127.0.0.1",
      port: 6868,
      username: creds.username,
      password: creds.password
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/sftp/reset-password", requireServerAccess("files"), async (req, res) => {
  try {
    const { id } = req.params;
    const creds = await resetSftpPassword(id);
    res.json({
      host: req.headers.host?.split(":")[0] || "127.0.0.1",
      port: 6868,
      username: creds.username,
      password: creds.password
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id/sftp", requireServerAccess("files"), async (req, res) => {
  try {
    const { id } = req.params;
    await deleteSftpUser(id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/plugins/install", requireServerAccess("files"), installPlugin);
router.post("/:id/mods/install", requireServerAccess("files"), installMod);
export default router;
