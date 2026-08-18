import express from "express";
import path from "path";
import { requireAuth, requireServerAccess } from "../middleware/auth.js";
import { readJSON } from "../services/db.js";
import { getServers, createServer, getServer, deleteServer, startServer, stopServer, restartServer, changeServerVersion, updateServerResources, updateBotConfig, getFiles, uploadFile, deleteFile, renameFile, saveFileContent, sendCommand, getServerStats, getServerStatHistory, updateOwner, updateIpAlias, updateDiscordWebhook, testDiscordWebhook, getBackups, createBackup, downloadBackup, deleteBackup, unzipFile, zipFiles, installPlugin, installMod, installWorld, installModpack, getScheduledTasks, createScheduledTask, updateScheduledTask, deleteScheduledTask, getPlayitTunnelStatus, startPlayitTunnelHandler, stopPlayitTunnelHandler, resetPlayitTunnelHandler } from "../controllers/servers.js";
import multer from "multer";

const router = express.Router();
const upload = multer({ dest: path.join(process.cwd(), ".data/temp/") });

router.use(requireAuth);

// Playit is an admin-gated feature. Even with the tab hidden client-side,
// someone could still call these endpoints directly — this blocks that.
const requirePlayitEnabled = async (req: any, res: any, next: any) => {
  const settings = await readJSON("settings.json") || {};
  if (settings.enablePlayit !== true) {
    return res.status(403).json({ error: "Playit tunnel is disabled by the panel administrator." });
  }
  next();
};

router.get("/", getServers);
router.post("/", createServer);
router.get("/:id", requireServerAccess(), getServer);
router.get("/:id/stats", requireServerAccess(), getServerStats);
router.get("/:id/stats/history", requireServerAccess(), getServerStatHistory);
router.delete("/:id", requireServerAccess(), deleteServer);
router.put("/:id/owner", requireServerAccess(), updateOwner);
router.put("/:id/ipalias", requireServerAccess("settings"), updateIpAlias);
router.put("/:id/discord-webhook", requireServerAccess("settings"), updateDiscordWebhook);
router.post("/:id/discord-webhook/test", requireServerAccess("settings"), testDiscordWebhook);

router.put("/:id/version", requireServerAccess("settings"), changeServerVersion);
router.put("/:id/resources", requireServerAccess(), updateServerResources);
router.put("/:id/bot-config", requireServerAccess(), updateBotConfig);

router.post("/:id/start", requireServerAccess("start"), startServer);
router.post("/:id/stop", requireServerAccess("stop"), stopServer);
router.post("/:id/restart", requireServerAccess("restart"), restartServer);
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
router.get("/:id/backups", requireServerAccess("backup"), getBackups);
router.post("/:id/backups", requireServerAccess("backup"), createBackup);
router.get("/:id/backups/:filename", requireServerAccess("backup"), downloadBackup);
router.delete("/:id/backups/:filename", requireServerAccess("backup"), deleteBackup);


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
router.post("/:id/worlds/install", requireServerAccess("files"), upload.single("file"), installWorld);
router.post("/:id/modpack/install", requireServerAccess("files"), upload.single("file"), installModpack);

router.get("/:id/schedule", requireServerAccess("schedule"), getScheduledTasks);
router.post("/:id/schedule", requireServerAccess("schedule"), createScheduledTask);

router.get("/:id/playit", requireServerAccess(), requirePlayitEnabled, getPlayitTunnelStatus);
router.post("/:id/playit/start", requireServerAccess("settings"), requirePlayitEnabled, startPlayitTunnelHandler);
router.post("/:id/playit/stop", requireServerAccess("settings"), requirePlayitEnabled, stopPlayitTunnelHandler);
router.post("/:id/playit/reset", requireServerAccess("settings"), requirePlayitEnabled, resetPlayitTunnelHandler);
router.put("/:id/schedule/:taskId", requireServerAccess("schedule"), updateScheduledTask);
router.delete("/:id/schedule/:taskId", requireServerAccess("schedule"), deleteScheduledTask);
export default router;
