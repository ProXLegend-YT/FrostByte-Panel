import { Request, Response } from "express";
import { readJSON, writeJSON, updateJSON } from "../services/db.js";
import { createServerContainer, startContainer, stopContainer, restartContainer, deleteContainer, getContainerStatus, sendContainerCommand, attachContainerSocket, getContainerStats } from "../services/docker.js";
import { createSftpUser, deleteSftpUser } from "../services/sftp.js";
import { logActivity } from "../services/activityLog.js";
import { randomUUID as uuidv4, createHash } from "crypto";
import fs from "fs-extra";
import path from "path";
// NOTE: archiver is intentionally never statically imported here. Its newer
// major versions are published as ESM-only, and esbuild compiles a static
// `import` into a `require()` call in the CJS bundle this project builds —
// which crashes immediately on startup (ERR_REQUIRE_ESM) the moment a fresh
// `npm install` happens to pull a newer archiver. Every usage below goes
// through `await import("archiver")` instead, which works with both CJS and
// ESM-only packages regardless of which one npm happens to install.
// extract-zip is also dynamically imported at each call site below, for the
// same reason archiver is above — defensive against a future ESM-only
// release breaking the CJS build the same way.

/**
 * Returns true only if `target` is exactly `base` or a genuine descendant of it.
 * Guards against prefix-matching bypasses, e.g. base ".../servers/abc" incorrectly
 * matching target ".../servers/abc-evil" under a naive `startsWith` check.
 */
function isWithinBase(target: string, base: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
}

// Same heuristic git and most editors use: if a NUL byte shows up in the
// first chunk of the file, treat it as binary. This lets the file editor
// safely open *any* genuinely text-based file (not just a hardcoded
// extension whitelist) while still refusing jars, images, world data,
// etc. — opening those as UTF-8 text can produce garbage on save and
// silently corrupt the original binary.
const BINARY_SNIFF_BYTES = 8192;
function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, BINARY_SNIFF_BYTES));
  return sample.includes(0);
}

// Server resource limit bounds — shared between creation and later admin
// updates so a server can never be created outside the range an admin could
// later constrain it to anyway.
const MIN_RAM_GB = 0.5;
const MAX_RAM_GB = 128;
const MIN_CPU_PERCENT = 10;
const MAX_CPU_PERCENT = 1600; // 16 cores worth, generous ceiling against fat-fingered input

export const getServers = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const servers = await readJSON("servers.json") || [];
  
  // Filter for normal users
  const userServers = user.role === "admin" || user.role === "owner" ? servers : servers.filter((s: any) => s.owner === user.id);

  // Update statuses
  const updatedServers = await Promise.all(userServers.map(async (server: any) => {
    if (server.containerId) {
      const status = await getContainerStatus(server.containerId);
      server.status = status?.State?.Running ? "online" : "offline";
    }
    return server;
  }));

  res.json(updatedServers);
};

export const getServer = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;
  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);
  if (!server) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const status = await getContainerStatus(server.containerId);
  server.status = status?.State?.Running ? "online" : "offline";
  res.json(server);
};

export const getServerStats = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;
  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);
  if (!server) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (server.containerId) {
    const stats = await getContainerStats(server.containerId);
    res.json({
      ...stats,
      limitRam: server.ram ? server.ram * 1024 : 1024,
      limitCpu: server.cpu || 100,
      limitDisk: server.disk || 10
    });
  } else {
    res.json({ cpu: 0, ram: 0, disk: 0, limitRam: server.ram ? server.ram * 1024 : 1024, limitCpu: server.cpu || 100, limitDisk: server.disk || 10 });
  }
};

const VALID_RANGES = ["1h", "6h", "24h", "7d", "30d"];

export const getServerStatHistory = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;
  const range = VALID_RANGES.includes(req.query.range as string) ? (req.query.range as any) : "6h";

  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);
  if (!server) return res.status(404).json({ error: "Server not found" });
  if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { getStatHistory } = await import("../services/statsHistory.js");
  const samples = await getStatHistory(id, range);
  res.json({
    range,
    samples,
    limitRam: server.ram ? server.ram * 1024 : 1024,
    limitCpu: server.cpu || 100,
  });
};

export const createServer = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const isPrivileged = user.role === "admin" || user.role === "owner";

  // Permission resolution order for normal users:
  //   1. An explicit per-user override (Settings → per-user "Server Access")
  //      always wins, whether it grants or denies.
  //   2. Otherwise, fall back to the panel-wide default
  //      (Settings → Administrator Controls → "Allow normal users to
  //      create servers", with its own shared quota).
  // This means admins can flip on server creation for everyone at once via
  // the global switch, while still being able to hand-tune or lock out a
  // specific account without that override being clobbered by the global
  // setting.
  let effectiveCaps: { maxServers: number; maxRamGb: number; maxCpuPercent: number; maxDiskGb: number } | null = null;
  if (!isPrivileged) {
    const users = await readJSON("users.json") || [];
    const record = users.find((u: any) => u.id === user.id);
    const hasPerUserOverride = !!record && record.canCreateServers !== undefined;

    if (hasPerUserOverride) {
      if (!record.canCreateServers) {
        return res.status(403).json({ error: "You don't have permission to create servers. Ask an admin to enable this for your account." });
      }
      effectiveCaps = {
        maxServers: typeof record.maxServers === "number" ? record.maxServers : 1,
        maxRamGb: typeof record.maxRamGb === "number" ? record.maxRamGb : 4,
        maxCpuPercent: typeof record.maxCpuPercent === "number" ? record.maxCpuPercent : 200,
        maxDiskGb: typeof record.maxDiskGb === "number" ? record.maxDiskGb : 10,
      };
    } else {
      const settings = await readJSON("settings.json") || {};
      if (settings.allowUserServerCreation !== true) {
        return res.status(403).json({ error: "You don't have permission to create servers. Ask an admin to enable this." });
      }
      effectiveCaps = {
        maxServers: typeof settings.defaultMaxServers === "number" ? settings.defaultMaxServers : 1,
        maxRamGb: typeof settings.defaultMaxRamGb === "number" ? settings.defaultMaxRamGb : 4,
        maxCpuPercent: typeof settings.defaultMaxCpuPercent === "number" ? settings.defaultMaxCpuPercent : 200,
        maxDiskGb: typeof settings.defaultMaxDiskGb === "number" ? settings.defaultMaxDiskGb : 10,
      };
    }

    const allServers = await readJSON("servers.json") || [];
    const ownedCount = allServers.filter((s: any) => s.owner === user.id).length;
    if (ownedCount >= effectiveCaps.maxServers) {
      return res.status(403).json({ error: `You've reached your server limit (${effectiveCaps.maxServers}). Ask an admin to raise it.` });
    }
  }

  const { name, ram, port, version, theme, cpu, disk, owner, ipAlias, type, game, discordToken, startCommand, serverPassword, srcdsToken } = req.body;
  if (!name || !ram || !port) {
    res.status(400).json({ error: "Missing required fields (name, ram, port)" });
    return;
  }
  if (typeof ram !== "number" || ram < MIN_RAM_GB || ram > MAX_RAM_GB) {
    return res.status(400).json({ error: `RAM must be between ${MIN_RAM_GB} and ${MAX_RAM_GB} GB` });
  }
  if (cpu !== undefined && (typeof cpu !== "number" || cpu < MIN_CPU_PERCENT || cpu > MAX_CPU_PERCENT)) {
    return res.status(400).json({ error: `CPU must be between ${MIN_CPU_PERCENT}% and ${MAX_CPU_PERCENT}%` });
  }

  // A permitted normal user is further bounded by their effective caps
  // (per-user override if set, otherwise the panel-wide default), so one
  // enabled account can't request a server sized to eat the whole host.
  if (!isPrivileged && effectiveCaps) {
    if (ram > effectiveCaps.maxRamGb) {
      return res.status(403).json({ error: `Your account is limited to ${effectiveCaps.maxRamGb}GB RAM per server.` });
    }
    if ((cpu || 100) > effectiveCaps.maxCpuPercent) {
      return res.status(403).json({ error: `Your account is limited to ${effectiveCaps.maxCpuPercent}% CPU per server.` });
    }
    if ((disk || 10) > effectiveCaps.maxDiskGb) {
      return res.status(403).json({ error: `Your account is limited to ${effectiveCaps.maxDiskGb}GB disk per server.` });
    }
    // Normal users can only ever create servers for themselves — owner
    // assignment stays an admin-only capability so a permitted user can't
    // use their quota to spin up servers on someone else's behalf.
    if (owner && owner !== user.id) {
      return res.status(403).json({ error: "Only admins can assign a server to another user." });
    }
  }

  const { getGameDefinition } = await import("../gameDefinitions.js");
  const gameId = game || "minecraft";
  try {
    getGameDefinition(gameId); // throws if unknown — validate before creating anything
  } catch {
    return res.status(400).json({ error: `Unknown game type: ${gameId}` });
  }

  const id = uuidv4();
  const serverData: any = {
    id,
    name,
    owner: owner || user.id, // Support assigning owner at creation
    ram,
    cpu: cpu || 100,
    disk: disk || 10,
    port,
    ipAlias: ipAlias || "",
    game: gameId,
    type: type || (gameId === "minecraft" ? "PAPER" : undefined),
    version: version || (gameId === "minecraft" ? "1.21.1" : "latest"),
    theme: theme || "default",
    status: "installing",
    createdAt: new Date().toISOString(),
    containerId: null,
  };

  // Discord bot-specific fields — kept off the base server record shape for
  // other game types rather than always present-but-empty.
  if (gameId === "discord-bot") {
    if (discordToken) serverData.discordToken = discordToken;
    if (startCommand) serverData.startCommand = startCommand;
  }

  if (["rust", "valheim", "ark", "palworld"].includes(gameId) && serverPassword) {
    serverData.serverPassword = serverPassword;
  }
  if (gameId === "cs2" && srcdsToken) {
    serverData.srcdsToken = srcdsToken;
  }

  let portConflict = false;
  const servers = await updateJSON<any[]>("servers.json", (current) => {
    const list = current || [];
    if (list.find((s: any) => s.port == port)) {
      portConflict = true;
      return list; // no-op write, we'll bail out below
    }
    list.push(serverData);
    return list;
  });

  if (portConflict) {
    res.status(400).json({ error: "Port is already in use by another server." });
    return;
  }

  try {
    const containerId = await createServerContainer(serverData);
    serverData.containerId = containerId;
    serverData.status = "offline";
    await updateJSON<any[]>("servers.json", (current) =>
      (current || []).map((s: any) => (s.id === id ? serverData : s))
    );
    await createSftpUser(id).catch(e => console.error("SFTP user creation failed:", e));
    logActivity({ actorId: user.id, actorUsername: user.username, action: "server.create", target: name, serverId: id });
    try {
      const { notifyUser } = await import("../services/notifications.js");
      await notifyUser(user.id, {
        type: "success",
        title: "Server created",
        message: `${name} is ready.`,
        serverId: id,
        link: `/servers/${id}`,
      });
    } catch { /* notification is best-effort — server already created */ }
    res.json(serverData);
  } catch (err: any) {
    console.error(err);
    // Container creation failed — remove the orphaned entry rather than
    // leaving a permanently stuck "installing" server occupying the port
    // with no way to retry or clean it up through the normal UI.
    await updateJSON<any[]>("servers.json", (current) =>
      (current || []).filter((s: any) => s.id !== id)
    ).catch(() => {});
    res.status(500).json({ error: err.message });
  }
};

export const updateOwner = async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") {
    return res.status(403).json({ error: "Only admins can update owner" });
  }

  const { id } = req.params;
  const { owner } = req.body;

  if (!owner) return res.status(400).json({ error: "Owner required" });

  let notFound = false;
  let serverName = "";
  await updateJSON<any[]>("servers.json", (current) => {
    const servers = current || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) { notFound = true; return servers; }
    server.owner = owner;
    serverName = server.name;
    return servers;
  });

  if (notFound) return res.status(404).json({ error: "Server not found" });

  logActivity({ actorId: user.id, actorUsername: user.username, action: "server.owner_change", target: serverName, serverId: id, metadata: { newOwner: owner } });
  
  res.json({ success: true });
};

export const updateIpAlias = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { id } = req.params;
  const { ipAlias } = req.body;

  let notFound = false;
  let forbidden = false;
  await updateJSON<any[]>("servers.json", (current) => {
    const servers = current || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) { notFound = true; return servers; }
    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      forbidden = true;
      return servers;
    }
    server.ipAlias = ipAlias;
    return servers;
  });

  if (notFound) return res.status(404).json({ error: "Server not found" });
  if (forbidden) return res.status(403).json({ error: "Forbidden" });

  res.json({ success: true });
};

const DISCORD_ALERT_EVENTS = ["server.start", "server.stop", "server.crash", "backup.create"];

export const updateDiscordWebhook = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { id } = req.params;
  const { discordWebhookUrl, discordAlerts } = req.body;

  if (discordWebhookUrl) {
    let parsed: URL;
    try { parsed = new URL(discordWebhookUrl); } catch {
      return res.status(400).json({ error: "That doesn't look like a valid URL." });
    }
    if (parsed.hostname !== "discord.com" && parsed.hostname !== "discordapp.com") {
      return res.status(400).json({ error: "Webhook URL must be a discord.com webhook link." });
    }
  }
  if (discordAlerts !== undefined) {
    if (!Array.isArray(discordAlerts) || discordAlerts.some((e: any) => !DISCORD_ALERT_EVENTS.includes(e))) {
      return res.status(400).json({ error: "Invalid alert event list." });
    }
  }

  let notFound = false;
  let forbidden = false;
  await updateJSON<any[]>("servers.json", (current) => {
    const servers = current || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) { notFound = true; return servers; }
    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      forbidden = true;
      return servers;
    }
    if (discordWebhookUrl !== undefined) server.discordWebhookUrl = discordWebhookUrl || undefined;
    if (discordAlerts !== undefined) server.discordAlerts = discordAlerts;
    return servers;
  });

  if (notFound) return res.status(404).json({ error: "Server not found" });
  if (forbidden) return res.status(403).json({ error: "Forbidden" });

  logActivity({ actorId: user.id, actorUsername: user.username, action: "server.discord_webhook_update", serverId: id });
  res.json({ success: true });
};

export const testDiscordWebhook = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { webhookUrl } = req.body;
  if (!webhookUrl) return res.status(400).json({ error: "webhookUrl is required." });

  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);
  if (!server) return res.status(404).json({ error: "Server not found" });

  const { sendDiscordTestMessage } = await import("../services/discord.js");
  const result = await sendDiscordTestMessage(webhookUrl, server.name || "This server");
  if (!result.success) return res.status(502).json({ error: result.error });
  res.json({ success: true });
};

export const deleteServer = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = (req as any).user;
    
    let servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    if (user.role !== "admin" && user.role !== "owner") {
      return res.status(403).json({ error: "Only admins can delete servers" });
    }

    if (server.containerId) {
      await deleteContainer(server.containerId);
    }
    
    await updateJSON<any[]>("servers.json", (current) =>
      (current || []).filter((s: any) => s.id !== id)
    );
    
    // Remove files
    const serverDir = path.join(process.cwd(), ".data", "servers", id);
    try {
      await fs.remove(serverDir);
    } catch (e) {
      console.error("Failed to remove server directory", e);
    }

    // Remove the server's resource-history file too — no point retaining
    // months of CPU/RAM samples for a server that no longer exists.
    try {
      const { deleteStatHistory } = await import("../services/statsHistory.js");
      await deleteStatHistory(id);
    } catch (e) {
      console.error("Failed to remove stats history", e);
    }
    
    await deleteSftpUser(id).catch(e => console.error("SFTP user deletion failed:", e));
    logActivity({ actorId: user.id, actorUsername: user.username, action: "server.delete", target: server.name, serverId: id });
    
    res.json({ success: true });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const startServer = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server || !server.containerId) {
      return res.status(404).json({ error: "Not found" });
    }
    try {
      await startContainer(server.containerId);
    } catch (startErr: any) {
      if (startErr.statusCode === 404 || (startErr.message && startErr.message.toLowerCase().includes("no such container"))) {
        console.log(`Container missing for server ${server.id}. Recreating...`);
        const newContainerId = await createServerContainer(server);
        server.containerId = newContainerId;
        await updateJSON<any[]>("servers.json", (current) => {
          const list = current || [];
          const s = list.find((x: any) => x.id === id);
          if (s) s.containerId = newContainerId;
          return list;
        });
        await startContainer(newContainerId);
      } else {
        throw startErr;
      }
    }
    await attachContainerSocket(server.containerId, server.id);
    logActivity({ actorId: (req as any).user.id, actorUsername: (req as any).user.username, action: "server.start", target: server.name, serverId: id });
    const { notifyServerDiscord } = await import("../services/discord.js");
    notifyServerDiscord(server, "server.start").catch(() => {});
    res.json({ success: true });
  } catch (err: any) {
    console.error("Start server error:", err);
    res.status(500).json({ error: err.message || "Failed to start server" });
  }
};

export const stopServer = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server || !server.containerId) {
      return res.status(404).json({ error: "Not found" });
    }
    try {
      await stopContainer(server.containerId);
    } catch (stopErr: any) {
      if (stopErr.statusCode === 404 || (stopErr.message && stopErr.message.toLowerCase().includes("no such container"))) {
        console.log(`Container already missing for server ${server.id}. Assuming stopped.`);
      } else {
        throw stopErr;
      }
    }
    logActivity({ actorId: (req as any).user.id, actorUsername: (req as any).user.username, action: "server.stop", target: server.name, serverId: id });
    const { notifyServerDiscord } = await import("../services/discord.js");
    notifyServerDiscord(server, "server.stop").catch(() => {});
    res.json({ success: true });
  } catch (err: any) {
    console.error("Stop server error:", err);
    res.status(500).json({ error: err.message || "Failed to stop server" });
  }
};

export const restartServer = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server || !server.containerId) {
      return res.status(404).json({ error: "Not found" });
    }
    try {
      await restartContainer(server.containerId);
    } catch (startErr: any) {
      if (startErr.statusCode === 404 || (startErr.message && startErr.message.toLowerCase().includes("no such container"))) {
        console.log(`Container missing for server ${server.id}. Recreating...`);
        const newContainerId = await createServerContainer(server);
        server.containerId = newContainerId;
        await updateJSON<any[]>("servers.json", (current) => {
          const list = current || [];
          const s = list.find((x: any) => x.id === id);
          if (s) s.containerId = newContainerId;
          return list;
        });
        await startContainer(newContainerId);
      } else {
        throw startErr;
      }
    }
    await attachContainerSocket(server.containerId, server.id);
    logActivity({ actorId: (req as any).user.id, actorUsername: (req as any).user.username, action: "server.restart", target: server.name, serverId: id });
    res.json({ success: true });
  } catch (err: any) {
    console.error("Restart server error:", err);
    res.status(500).json({ error: err.message || "Failed to restart server" });
  }
};

export const sendCommand = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { command } = req.body;
    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server || !server.containerId) {
      return res.status(404).json({ error: "Not found" });
    }
    await sendContainerCommand(server.containerId, command);
    res.json({ success: true });
  } catch (err: any) {
    console.error("Command error:", err);
    res.status(500).json({ error: err.message || "Failed to send command" });
  }
};

export const changeServerVersion = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { version, type } = req.body;
    const user = (req as any).user;
    
    if (!version) return res.status(400).json({ error: "Version is required" });
    
    let servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    if (user.role !== "admin" && user.role !== "owner" && server.owner !== user.id) {
      return res.status(403).json({ error: "Only admins or owners can change version" });
    }

    if (server.containerId) {
      const status = await getContainerStatus(server.containerId);
      if (status?.State?.Running) {
        return res.status(400).json({ error: "Server must be stopped before changing version. Please stop the server first." });
      }
      // Delete old container
      await deleteContainer(server.containerId);
    }
    
    // Automatically delete config files to avoid issues when switching versions/types
    const serverDir = path.join(process.cwd(), ".data", "servers", id);
    const filesToDelete = [
      "paper-global.yml", "paper-world-defaults.yml", "paper.yml",
      "config/paper-global.yml", "config/paper-world-defaults.yml",
      "world/data/random_sequences.dat"
    ];
    
    for (const file of filesToDelete) {
      const filePath = path.join(serverDir, file);
      try {
        if (await fs.pathExists(filePath)) {
          await fs.remove(filePath);
        }
      } catch (e) {
        console.error(`Failed to delete ${file}`, e);
      }
    }
    
    server.version = version;
    if (type) {
      server.type = type;
    }
    // Recreate container with new version env
    const newContainerId = await createServerContainer(server);
    server.containerId = newContainerId;

    const finalVersion = version;
    const finalType = server.type;
    await updateJSON<any[]>("servers.json", (current) => {
      const list = current || [];
      const s = list.find((x: any) => x.id === id);
      if (s) {
        s.version = finalVersion;
        s.type = finalType;
        s.containerId = newContainerId;
      }
      return list;
    });
    
    try {
      const { notifyUser } = await import("../services/notifications.js");
      await notifyUser(user.id, {
        type: "success",
        title: "Server updated",
        message: `${server.name} was switched to ${type ? `${type} ` : ""}${version}.`,
        serverId: id,
        link: `/servers/${id}`,
      });
    } catch { /* notification is best-effort — update already succeeded */ }

    res.json({ success: true, version, type: server.type });
  } catch (err: any) {
    console.error("Change version error", err);
    res.status(500).json({ error: err.message });
  }
};

export const updateServerResources = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { ram, cpu } = req.body;
    const user = (req as any).user;

    // Resource limits are intentionally admin/owner-only — a server owner
    // must not be able to grant themselves more resources than an admin
    // allocated, which is the whole point of having enforced limits.
    if (user.role !== "admin" && user.role !== "owner") {
      return res.status(403).json({ error: "Only administrators can change resource limits" });
    }

    if (ram === undefined && cpu === undefined) {
      return res.status(400).json({ error: "Provide at least one of ram or cpu" });
    }
    if (ram !== undefined && (typeof ram !== "number" || ram < MIN_RAM_GB || ram > MAX_RAM_GB)) {
      return res.status(400).json({ error: `RAM must be between ${MIN_RAM_GB} and ${MAX_RAM_GB} GB` });
    }
    if (cpu !== undefined && (typeof cpu !== "number" || cpu < MIN_CPU_PERCENT || cpu > MAX_CPU_PERCENT)) {
      return res.status(400).json({ error: `CPU must be between ${MIN_CPU_PERCENT}% and ${MAX_CPU_PERCENT}%` });
    }

    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    if (server.containerId) {
      try {
        const { updateContainerResources } = await import("../services/docker.js");
        await updateContainerResources(server.containerId, ram, cpu);
      } catch (dockerErr: any) {
        // Never persist a limit change that failed to actually apply to the
        // running container — the stored value must always reflect reality.
        return res.status(500).json({ error: `Failed to apply new limits to the running container: ${dockerErr.message}` });
      }
    }

    let updatedRam = server.ram;
    let updatedCpu = server.cpu;
    let notFound = false;
    await updateJSON<any[]>("servers.json", (current) => {
      const list = current || [];
      const s = list.find((x: any) => x.id === id);
      if (!s) { notFound = true; return list; }
      if (ram !== undefined) s.ram = ram;
      if (cpu !== undefined) s.cpu = cpu;
      updatedRam = s.ram;
      updatedCpu = s.cpu;
      return list;
    });

    if (notFound) return res.status(404).json({ error: "Server not found" });

    logActivity({
      actorId: user.id, actorUsername: user.username,
      action: "server.resource_change",
      target: server.name, serverId: id,
      metadata: { ramChangedTo: ram, cpuChangedTo: cpu },
    });

    res.json({ success: true, ram: updatedRam, cpu: updatedCpu });
  } catch (err: any) {
    console.error("Update resources error:", err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Updates a Discord bot server's start command (and optionally its token),
 * then recreates the container so the new startup command actually takes
 * effect. Unlike RAM/CPU, a container's Cmd can't be changed on a live
 * container — Docker only lets you set it at creation — so this follows
 * the same delete-and-recreate pattern as changeServerVersion.
 */
export const updateBotConfig = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { startCommand, discordToken } = req.body;
    const user = (req as any).user;

    const servers = await readJSON("servers.json") || [];
    const server = servers.find((s: any) => s.id === id);
    if (!server) return res.status(404).json({ error: "Server not found" });

    if (server.game !== "discord-bot") {
      return res.status(400).json({ error: "This server is not a Discord bot instance" });
    }

    const isOwner = server.owner === user.id;
    const isAdmin = user.role === "admin" || user.role === "owner";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (startCommand !== undefined) server.startCommand = startCommand;
    if (discordToken !== undefined && discordToken !== "") server.discordToken = discordToken;

    // Recreate the container so the new Cmd/env actually applies. The
    // server must be stopped first, same requirement as changing version.
    if (server.containerId) {
      const { getContainerStatus, deleteContainer, createServerContainer } = await import("../services/docker.js");
      const status = await getContainerStatus(server.containerId).catch(() => null);
      if (status?.State?.Running) {
        return res.status(400).json({ error: "Stop the bot before changing its configuration." });
      }
      await deleteContainer(server.containerId);
    }

    const newContainerId = await createServerContainer(server);
    server.containerId = newContainerId;

    await updateJSON<any[]>("servers.json", (current) => {
      const list = current || [];
      const s = list.find((x: any) => x.id === id);
      if (s) {
        if (startCommand !== undefined) s.startCommand = startCommand;
        if (discordToken !== undefined && discordToken !== "") s.discordToken = discordToken;
        s.containerId = newContainerId;
      }
      return list;
    });

    logActivity({
      actorId: user.id, actorUsername: user.username,
      action: "server.resource_change", // reusing the closest existing "server config changed" activity type
      target: server.name, serverId: id,
    });

    res.json({ success: true });
  } catch (err: any) {
    console.error("Update bot config error:", err);
    res.status(500).json({ error: err.message });
  }
};

// File manager basics
export const getFiles = async (req: Request, res: Response) => {
  const { id } = req.params;
  const dirPath = req.query.path ? String(req.query.path) : "/";
  const targetPath = path.join(process.cwd(), ".data", "servers", id, dirPath);
  
  if (!isWithinBase(targetPath, path.join(process.cwd(), ".data", "servers", id))) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    const stats = await fs.stat(targetPath).catch(() => null);
    if (!stats) {
      // Return empty if not found
      return res.json([]);
    }
    if (stats.isFile()) {
       const MAX_EDITABLE_SIZE = 5 * 1024 * 1024; // 5MB — generous for configs/logs, small enough to not choke a browser editor
       if (stats.size > MAX_EDITABLE_SIZE) {
         return res.json({ isFile: true, tooLarge: true, size: stats.size });
       }
       const raw = await fs.readFile(targetPath);
       if (looksBinary(raw)) {
         return res.json({ isFile: true, isBinary: true, size: stats.size });
       }
       return res.json({ isFile: true, content: raw.toString("utf-8") });
    }
    const files = await fs.readdir(targetPath, { withFileTypes: true });
    res.json(files.map(f => ({
      name: f.name,
      isDirectory: f.isDirectory(),
      size: f.isDirectory() ? 0 : fs.statSync(path.join(targetPath, f.name)).size
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const uploadFile = async (req: Request, res: Response) => {
  const { id } = req.params;
  const dirPath = req.body.path || "/";
  const baseDir = path.join(process.cwd(), ".data", "servers", id);
  const targetPath = path.join(baseDir, dirPath);

  if (!isWithinBase(targetPath, baseDir)) {
    if (req.file) await fs.remove(req.file.path).catch(() => {});
    return res.status(403).json({ error: "Invalid path" });
  }

  if (req.file) {
    const safeName = path.basename(req.file.originalname);
    await fs.ensureDir(targetPath);
    await fs.move(req.file.path, path.join(targetPath, safeName), { overwrite: true });
  }
  res.json({ success: true });
};

export const deleteFile = async (req: Request, res: Response) => {
  const { id } = req.params;
  const filePaths = req.body.paths || (req.body.path ? [req.body.path] : []);
  
  try {
    for (const filePath of filePaths) {
      const targetPath = path.join(process.cwd(), ".data", "servers", id, filePath);
      
      if (!isWithinBase(targetPath, path.join(process.cwd(), ".data", "servers", id))) {
        return res.status(403).json({ error: "Invalid path" });
      }
      
      await fs.remove(targetPath);
    }
    logActivity({ actorId: (req as any).user.id, actorUsername: (req as any).user.username, action: "file.delete", target: filePaths.join(", "), serverId: id });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

export const zipFiles = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { dirPath, fileNames, outputName } = req.body;
  
  const baseDir = path.join(process.cwd(), ".data", "servers", id, dirPath);
  const outZipPath = path.join(baseDir, outputName || "archive.zip");

  if (!isWithinBase(baseDir, path.join(process.cwd(), ".data", "servers", id))) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    const output = fs.createWriteStream(outZipPath);
    const archiver = (await import("archiver")).default;
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      res.json({ success: true, filename: outputName || "archive.zip" });
    });

    archive.on("error", (err: any) => {
      console.error("Archive error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });

    archive.pipe(output);

    for (const name of fileNames) {
      const filePath = path.join(baseDir, name);
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        archive.directory(filePath, name);
      } else {
        archive.file(filePath, { name });
      }
    }

    await archive.finalize();
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
};

export const renameFile = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { oldPath, newPath } = req.body;

  const targetOldPath = path.join(process.cwd(), ".data", "servers", id, oldPath);
  const targetNewPath = path.join(process.cwd(), ".data", "servers", id, newPath);

  if (!isWithinBase(targetOldPath, path.join(process.cwd(), ".data", "servers", id)) ||
      !isWithinBase(targetNewPath, path.join(process.cwd(), ".data", "servers", id))) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    await fs.rename(targetOldPath, targetNewPath);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export const unzipFile = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { path: filePath } = req.body;

  const targetPath = path.join(process.cwd(), ".data", "servers", id, filePath);
  
  if (!isWithinBase(targetPath, path.join(process.cwd(), ".data", "servers", id))) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    const destDir = path.dirname(targetPath);
    const extract = (await import("extract-zip")).default;
    await extract(targetPath, { dir: destDir });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

export const saveFileContent = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { filePath, content } = req.body;

  const targetPath = path.join(process.cwd(), ".data", "servers", id, filePath);

  if (!isWithinBase(targetPath, path.join(process.cwd(), ".data", "servers", id))) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    // If a file already exists at this path and looks binary, refuse to
    // overwrite it with text content — this endpoint shouldn't rely solely
    // on the frontend having gated access correctly upstream.
    const existing = await fs.stat(targetPath).catch(() => null);
    if (existing && existing.isFile()) {
      const existingRaw = await fs.readFile(targetPath).catch(() => null);
      if (existingRaw && looksBinary(existingRaw)) {
        return res.status(400).json({ error: "This file appears to be binary and can't be edited as text." });
      }
    }
    await fs.writeFile(targetPath, content, "utf-8");
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export const getBackups = async (req: Request, res: Response) => {
  const { id } = req.params;
  const backupsDir = path.join(process.cwd(), ".data", "backups", id);
  await fs.ensureDir(backupsDir);

  try {
    const files = await fs.readdir(backupsDir);
    const backups = [];
    for (const file of files) {
      if (file.endsWith(".zip")) {
        const stats = await fs.stat(path.join(backupsDir, file));
        backups.push({
          filename: file,
          size: stats.size,
          createdAt: stats.birthtime,
        });
      }
    }
    backups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    res.json(backups);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

export const createBackup = async (req: Request, res: Response) => {
  const { id } = req.params;
  const serverDir = path.join(process.cwd(), ".data", "servers", id);
  const backupsDir = path.join(process.cwd(), ".data", "backups", id);
  await fs.ensureDir(backupsDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `backup-${timestamp}.zip`;
  const backupPath = path.join(backupsDir, filename);

  try {
    const serverExists = await fs.pathExists(serverDir);
    if (!serverExists) {
       await fs.ensureDir(serverDir); // ensure it acts properly if empty
    }

    const output = fs.createWriteStream(backupPath);
    const archiver = (await import("archiver")).default;
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", async () => {
      if (!res.headersSent) {
        const actor = (req as any).user;
        logActivity({ actorId: actor.id, actorUsername: actor.username, action: "backup.create", target: filename, serverId: id });
        try {
          const { notifyUser } = await import("../services/notifications.js");
          await notifyUser(actor.id, {
            type: "success",
            title: "Backup complete",
            message: `${filename} was created successfully.`,
            serverId: id,
            link: `/servers/${id}/backup`,
          });
        } catch { /* notification is best-effort — backup already succeeded */ }

        try {
          const servers = await readJSON("servers.json") || [];
          const server = servers.find((s: any) => s.id === id);
          if (server) {
            const { notifyServerDiscord } = await import("../services/discord.js");
            notifyServerDiscord(server, "backup.create", filename).catch(() => {});
          }
        } catch { /* best-effort, same as above */ }

        res.json({ success: true, filename });
      }
    });

    archive.on("error", (err: any) => {
      console.error("Archive error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });

    archive.pipe(output);
    archive.directory(serverDir, false);
    await archive.finalize();
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
};

export const downloadBackup = async (req: Request, res: Response) => {
  const { id, filename } = req.params;
  const backupPath = path.join(process.cwd(), ".data", "backups", id, filename);

  // basic path traversal prevention
  if (!isWithinBase(backupPath, path.join(process.cwd(), ".data", "backups", id))) {
    return res.status(403).send("Invalid path");
  }

  if (await fs.pathExists(backupPath)) {
    res.download(backupPath);
  } else {
    res.status(404).send("Backup not found");
  }
};

export const deleteBackup = async (req: Request, res: Response) => {
  const { id, filename } = req.params;
  const backupPath = path.join(process.cwd(), ".data", "backups", id, filename);

  if (!isWithinBase(backupPath, path.join(process.cwd(), ".data", "backups", id))) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    await fs.remove(backupPath);
    logActivity({ actorId: (req as any).user.id, actorUsername: (req as any).user.username, action: "backup.delete", target: filename, serverId: id });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};
export const installPlugin = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { source, pluginId, pluginName } = req.body;
  
  // Allow direct downloadUrl fallback for backward compatibility
  if (req.body.downloadUrl) {
     try {
        const serverDir = path.join(process.cwd(), ".data", "servers", id);
        const pluginsDir = path.join(serverDir, "plugins");
        await fs.ensureDir(pluginsDir);
        const filePath = path.join(pluginsDir, req.body.filename);
        if (req.body.downloadUrl === 'dummy') {
          await fs.writeFile(filePath, '');
        } else {
          const axios = (await import("axios")).default;
          const response = await axios({ url: req.body.downloadUrl, method: 'GET', responseType: 'stream' });
          const writer = fs.createWriteStream(filePath);
          response.data.pipe(writer);
          await new Promise<void>((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        }
        return res.json({ success: true, message: "Plugin installed successfully" });
     } catch(e) {
        return res.status(500).json({ error: "Failed to install plugin" });
     }
  }

  if (!source || !pluginId || !pluginName) {
    return res.status(400).json({ error: "Missing source, pluginId, or pluginName" });
  }

  try {
    const serverDir = path.join(process.cwd(), ".data", "servers", id);
    const pluginsDir = path.join(serverDir, "plugins");
    await fs.ensureDir(pluginsDir);
    
    let downloadUrl = null;
    let filename = `${pluginName.replace(/[^a-zA-Z0-9]/g, '_')}.jar`;
    const axios = (await import("axios")).default;

    if (source === 'modrinth') {
      const verRes = await axios.get(`https://api.modrinth.com/v2/project/${pluginId}/version`);
      if (verRes.data && verRes.data.length > 0) {
        const file = verRes.data[0].files.find((f: any) => f.primary) || verRes.data[0].files[0];
        if (file) {
           downloadUrl = file.url;
           filename = file.filename || filename;
        }
      }
    } else if (source === 'spigot') {
       const apiRes = await axios.get(`https://api.spiget.org/v2/resources/${pluginId}`);
       if (apiRes.data && apiRes.data.file) {
         if (apiRes.data.file.type === 'external' && apiRes.data.file.externalUrl) {
           const extUrl = apiRes.data.file.externalUrl;
           if (extUrl.includes('github.com') && extUrl.includes('/releases/')) {
             // Try to extract github repo to get the jar
             const match = extUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/releases\/tag\/([^\/]+)/);
             if (match) {
               const owner = match[1];
               const repo = match[2];
               const tag = match[3];
               const ghRes = await axios.get(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`);
               if (ghRes.data && ghRes.data.assets) {
                 const jarAsset = ghRes.data.assets.find((a: any) => a.name.endsWith('.jar'));
                 if (jarAsset) {
                   downloadUrl = jarAsset.browser_download_url;
                   filename = jarAsset.name;
                 }
               }
             } else {
               const matchLatest = extUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/releases\/latest/);
               if (matchLatest) {
                 const owner = matchLatest[1];
                 const repo = matchLatest[2];
                 const ghRes = await axios.get(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
                 if (ghRes.data && ghRes.data.assets) {
                   const jarAsset = ghRes.data.assets.find((a: any) => a.name.endsWith('.jar'));
                   if (jarAsset) {
                     downloadUrl = jarAsset.browser_download_url;
                     filename = jarAsset.name;
                   }
                 }
               }
             }
           }
           
           if (!downloadUrl) {
             return res.status(400).json({ error: "This plugin must be downloaded externally from: " + extUrl });
           }
         } else {
           downloadUrl = `https://api.spiget.org/v2/resources/${pluginId}/download`;
         }
       } else {
         downloadUrl = `https://api.spiget.org/v2/resources/${pluginId}/download`;
       }
    } else if (source === 'hangar') {
       const [owner, slug] = pluginId.split('/');
       const verRes = await axios.get(`https://hangar.papermc.io/api/v1/projects/${owner}/${slug}/versions`);
       if (verRes.data && verRes.data.result && verRes.data.result.length > 0) {
         const version = verRes.data.result[0];
         const download = version.downloads.PAPER || Object.values(version.downloads)[0];
         if (download && (download as any).downloadUrl) {
            downloadUrl = (download as any).downloadUrl;
            if ((download as any).fileInfo && (download as any).fileInfo.name) {
                filename = (download as any).fileInfo.name;
            }
         } else if (download && (download as any).externalUrl) {
            return res.status(400).json({ error: "This plugin must be downloaded externally from: " + (download as any).externalUrl });
         }
       }
    }

    if (!downloadUrl) {
      return res.status(404).json({ error: "Could not find a valid download URL for this plugin." });
    }

    const filePath = path.join(pluginsDir, filename);
    const response = await axios({
      url: downloadUrl,
      method: 'GET',
      responseType: 'stream',
      headers: {
         'User-Agent': 'React-Minecraft-Panel/1.0'
      }
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    try {
      const { notifyUser } = await import("../services/notifications.js");
      await notifyUser((req as any).user.id, {
        type: "success",
        title: "Plugin installed",
        message: `${pluginName} was installed successfully.`,
        serverId: id,
        link: `/servers/${id}/plugins`,
      });
    } catch { /* notification is best-effort — install already succeeded */ }

    res.json({ success: true, message: "Plugin installed successfully" });
  } catch (error: any) {
    console.error("Plugin installation failed:", error.message);
    res.status(500).json({ error: "Plugin installation failed: " + error.message });
  }
};

export const installMod = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { pluginId, pluginName } = req.body; 

  if (!pluginId || !pluginName) {
    return res.status(400).json({ error: "Missing pluginId or pluginName" });
  }

  try {
    const serverDir = path.join(process.cwd(), ".data", "servers", id);
    const modsDir = path.join(serverDir, "mods");
    await fs.ensureDir(modsDir);
    
    let downloadUrl = null;
    let filename = `${pluginName.replace(/[^a-zA-Z0-9]/g, '_')}.jar`;
    const axios = (await import("axios")).default;

    const verRes = await axios.get(`https://api.modrinth.com/v2/project/${pluginId}/version`);
    if (verRes.data && verRes.data.length > 0) {
      const file = verRes.data[0].files.find((f: any) => f.primary) || verRes.data[0].files[0];
      if (file) {
          downloadUrl = file.url;
          filename = file.filename || filename;
      }
    }

    if (!downloadUrl) {
      return res.status(404).json({ error: "Could not find a valid download URL for this mod." });
    }

    const filePath = path.join(modsDir, filename);
    const response = await axios({
      url: downloadUrl,
      method: 'GET',
      responseType: 'stream',
      headers: {
         'User-Agent': 'React-Minecraft-Panel/1.0'
      }
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    try {
      const { notifyUser } = await import("../services/notifications.js");
      await notifyUser((req as any).user.id, {
        type: "success",
        title: "Mod installed",
        message: `${pluginName} was installed successfully.`,
        serverId: id,
        link: `/servers/${id}/mods`,
      });
    } catch { /* notification is best-effort — install already succeeded */ }

    res.json({ success: true, message: "Mod installed successfully" });
  } catch (error: any) {
    console.error("Mod installation failed:", error.message);
    res.status(500).json({ error: "Mod installation failed: " + error.message });
  }
};

// --- World installer -------------------------------------------------------
// There's no clean, no-auth, CORS-friendly marketplace API for full
// Minecraft worlds the way Modrinth serves mods/plugins — everything real
// out there is scraped wikis or paid listings, which isn't something to
// wire a "one-click install" against. So this delivers the part that's
// actually valuable and honest: safe, one-click *installation* of a world
// the admin/user already has (uploaded, or a direct URL they trust) —
// handling extraction, level-name detection/sync, and an automatic backup
// of whatever world is being replaced, which is the tedious/risky part
// people actually get stuck on.

function readServerProperties(propsPath: string): Record<string, string> {
  const props: Record<string, string> = {};
  if (!fs.existsSync(propsPath)) return props;
  const raw = fs.readFileSync(propsPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    props[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return props;
}

function writeServerPropertiesKey(propsPath: string, key: string, value: string) {
  let raw = fs.existsSync(propsPath) ? fs.readFileSync(propsPath, "utf8") : "";
  const lines = raw.split("\n");
  let found = false;
  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) nextLines.push(`${key}=${value}`);
  fs.writeFileSync(propsPath, nextLines.join("\n"));
}

// A zip can either have level.dat at its root, or wrap the whole world in a
// single subfolder (the common case when someone just zips their saves
// folder). This finds the real world root inside the extracted staging dir
// so we install the right thing either way.
function findWorldRoot(stagingDir: string): string | null {
  if (fs.existsSync(path.join(stagingDir, "level.dat"))) return stagingDir;
  const entries = fs.readdirSync(stagingDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const entry of entries) {
    const candidate = path.join(stagingDir, entry.name);
    if (fs.existsSync(path.join(candidate, "level.dat"))) return candidate;
  }
  return null;
}

export const installWorld = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;
  const { sourceUrl, worldName } = req.body;

  const serverDir = path.join(process.cwd(), ".data", "servers", id);
  if (!fs.existsSync(serverDir)) {
    if (req.file) await fs.remove(req.file.path).catch(() => {});
    return res.status(404).json({ error: "Server not found" });
  }

  // Swapping world files under a running server risks corrupting the save
  // (the server process has the region files open and periodically writes
  // to them) — require it to be stopped first, same as changeServerVersion.
  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);
  if (server?.containerId) {
    const status = await getContainerStatus(server.containerId);
    if (status?.State?.Running) {
      if (req.file) await fs.remove(req.file.path).catch(() => {});
      return res.status(409).json({ error: "Stop the server before installing a new world." });
    }
  }

  let zipPath: string | null = null;
  let cleanupZip = false;
  try {
    if (req.file) {
      zipPath = req.file.path;
      cleanupZip = true;
    } else if (sourceUrl) {
      let parsed: URL;
      try {
        parsed = new URL(sourceUrl);
      } catch {
        return res.status(400).json({ error: "Invalid source URL." });
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return res.status(400).json({ error: "Source URL must be http or https." });
      }
      const axios = (await import("axios")).default;
      const tempDir = path.join(process.cwd(), ".data", "temp");
      await fs.ensureDir(tempDir);
      zipPath = path.join(tempDir, `world-${uuidv4()}.zip`);
      cleanupZip = true;
      const response = await axios({ url: sourceUrl, method: "GET", responseType: "stream", headers: { "User-Agent": "FrostByte-Panel/1.0" }, maxRedirects: 5 });
      const writer = fs.createWriteStream(zipPath);
      response.data.pipe(writer);
      await new Promise<void>((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
    } else {
      return res.status(400).json({ error: "Provide either a world zip file or a sourceUrl." });
    }

    // Extract into a staging directory first — never straight into the live
    // world — so a corrupt/partial zip can't leave the server half-broken.
    const stagingDir = path.join(process.cwd(), ".data", "temp", `world-staging-${uuidv4()}`);
    await fs.ensureDir(stagingDir);
    try {
      const extract = (await import("extract-zip")).default;
      await extract(zipPath, { dir: stagingDir });
    } catch (extractErr: any) {
      await fs.remove(stagingDir).catch(() => {});
      return res.status(400).json({ error: "Could not extract the file — is it a valid zip?" });
    }

    const worldRoot = findWorldRoot(stagingDir);
    if (!worldRoot) {
      await fs.remove(stagingDir).catch(() => {});
      return res.status(400).json({ error: "This doesn't look like a Minecraft world — no level.dat found in the zip." });
    }

    const propsPath = path.join(serverDir, "server.properties");
    const currentProps = readServerProperties(propsPath);
    const levelName = (worldName || currentProps["level-name"] || "world").replace(/[^a-zA-Z0-9_\-]/g, "_") || "world";
    const targetWorldDir = path.join(serverDir, levelName);

    if (!isWithinBase(targetWorldDir, serverDir)) {
      await fs.remove(stagingDir).catch(() => {});
      return res.status(400).json({ error: "Invalid world name." });
    }

    // Auto-backup whatever world is already there before replacing it —
    // this is the actual safety net that makes a one-click install
    // reasonable. Skipped only if there's nothing there yet.
    let backupNote = "";
    if (fs.existsSync(targetWorldDir)) {
      const backupsDir = path.join(serverDir, "backups");
      await fs.ensureDir(backupsDir);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupName = `pre-world-install-${levelName}-${timestamp}.zip`;
      const backupPath = path.join(backupsDir, backupName);
      const archiver = (await import("archiver")).default;
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(backupPath);
        const archive = archiver("zip", { zlib: { level: 9 } });
        output.on("close", () => resolve());
        archive.on("error", reject);
        archive.pipe(output);
        archive.directory(targetWorldDir, false);
        archive.finalize();
      });
      await fs.remove(targetWorldDir);
      backupNote = ` Your previous world was backed up as ${backupName} before replacing it.`;
    }

    await fs.move(worldRoot, targetWorldDir, { overwrite: true });
    await fs.remove(stagingDir).catch(() => {});

    // Keep server.properties in sync so the server actually loads the
    // world we just installed, rather than looking for whatever level-name
    // was set before.
    if (currentProps["level-name"] !== levelName) {
      writeServerPropertiesKey(propsPath, "level-name", levelName);
    }

    logActivity({ actorId: user.id, actorUsername: user.username, action: "world.install", target: levelName, serverId: id });

    try {
      const { notifyUser } = await import("../services/notifications.js");
      await notifyUser(user.id, {
        type: "success",
        title: "World installed",
        message: `${levelName} is ready.${backupNote}`,
        serverId: id,
        link: `/servers/${id}/files`,
      });
    } catch { /* notification is best-effort — install already succeeded */ }

    res.json({ success: true, worldName: levelName, message: `World installed successfully.${backupNote}` });
  } catch (error: any) {
    console.error("World installation failed:", error.message);
    res.status(500).json({ error: "World installation failed: " + error.message });
  } finally {
    if (cleanupZip && zipPath) {
      await fs.remove(zipPath).catch(() => {});
    }
  }
};

// --- Modpack installer ------------------------------------------------
// Modrinth's .mrpack format is a real, documented standard — a zip
// containing a modrinth.index.json manifest (list of every mod + its
// exact CDN download URL + sha1/sha512 hashes) plus an overrides/ folder
// of config files, resource packs, etc. Unlike "worlds" (no clean API),
// this is honest one-click territory: download the pack, read the
// manifest, fetch every listed mod file in parallel, verify each against
// its published hash, drop overrides/ on top, back up whatever mods/
// folder existed first. No guessing, no scraping.

interface MrpackFile {
  path: string;
  hashes: { sha1?: string; sha512?: string };
  downloads: string[];
  fileSize: number;
  env?: { client?: string; server?: string };
}

interface MrpackIndex {
  formatVersion: number;
  game: string;
  versionId: string;
  name: string;
  dependencies: Record<string, string>; // e.g. "minecraft": "1.20.1", "fabric-loader": "0.15.0"
  files: MrpackFile[];
}

async function sha1File(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return createHash("sha1").update(buf).digest("hex");
}

export const installModpack = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;
  const { sourceUrl, projectId, versionId } = req.body;

  const serverDir = path.join(process.cwd(), ".data", "servers", id);
  if (!fs.existsSync(serverDir)) {
    if (req.file) await fs.remove(req.file.path).catch(() => {});
    return res.status(404).json({ error: "Server not found" });
  }

  // Same reasoning as installWorld: swapping the mods folder under a
  // running server is asking for a corrupted/half-loaded state, and a
  // modpack install can touch dozens of files at once — stop first.
  const servers = await readJSON("servers.json") || [];
  const server = servers.find((s: any) => s.id === id);
  if (server?.containerId) {
    const status = await getContainerStatus(server.containerId);
    if (status?.State?.Running) {
      if (req.file) await fs.remove(req.file.path).catch(() => {});
      return res.status(409).json({ error: "Stop the server before installing a modpack." });
    }
  }

  const axios = (await import("axios")).default;
  let mrpackPath: string | null = null;
  let cleanupMrpack = false;

  try {
    if (req.file) {
      mrpackPath = req.file.path;
      cleanupMrpack = true;
    } else if (projectId && versionId) {
      // Resolve a specific Modrinth modpack version to its .mrpack download URL.
      const verRes = await axios.get(`https://api.modrinth.com/v2/version/${versionId}`, {
        headers: { "User-Agent": "FrostByte-Panel/1.0" },
      });
      const file = (verRes.data.files || []).find((f: any) => f.filename?.endsWith(".mrpack")) || verRes.data.files?.[0];
      if (!file) return res.status(404).json({ error: "This version has no downloadable pack file." });

      const tempDir = path.join(process.cwd(), ".data", "temp");
      await fs.ensureDir(tempDir);
      mrpackPath = path.join(tempDir, `modpack-${uuidv4()}.mrpack`);
      cleanupMrpack = true;
      const dl = await axios({ url: file.url, method: "GET", responseType: "stream", headers: { "User-Agent": "FrostByte-Panel/1.0" } });
      const writer = fs.createWriteStream(mrpackPath);
      dl.data.pipe(writer);
      await new Promise<void>((resolve, reject) => { writer.on("finish", resolve); writer.on("error", reject); });
    } else if (sourceUrl) {
      let parsed: URL;
      try { parsed = new URL(sourceUrl); } catch { return res.status(400).json({ error: "Invalid source URL." }); }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return res.status(400).json({ error: "Source URL must be http or https." });
      }
      const tempDir = path.join(process.cwd(), ".data", "temp");
      await fs.ensureDir(tempDir);
      mrpackPath = path.join(tempDir, `modpack-${uuidv4()}.mrpack`);
      cleanupMrpack = true;
      const dl = await axios({ url: sourceUrl, method: "GET", responseType: "stream", headers: { "User-Agent": "FrostByte-Panel/1.0" }, maxRedirects: 5 });
      const writer = fs.createWriteStream(mrpackPath);
      dl.data.pipe(writer);
      await new Promise<void>((resolve, reject) => { writer.on("finish", resolve); writer.on("error", reject); });
    } else {
      return res.status(400).json({ error: "Provide a .mrpack file, a sourceUrl, or a projectId+versionId." });
    }

    const stagingDir = path.join(process.cwd(), ".data", "temp", `modpack-staging-${uuidv4()}`);
    await fs.ensureDir(stagingDir);
    try {
      const extract = (await import("extract-zip")).default;
      await extract(mrpackPath, { dir: stagingDir });
    } catch {
      await fs.remove(stagingDir).catch(() => {});
      return res.status(400).json({ error: "Could not extract the pack — is it a valid .mrpack file?" });
    }

    const indexPath = path.join(stagingDir, "modrinth.index.json");
    if (!fs.existsSync(indexPath)) {
      await fs.remove(stagingDir).catch(() => {});
      return res.status(400).json({ error: "This doesn't look like a Modrinth modpack — no modrinth.index.json found." });
    }
    const index: MrpackIndex = await fs.readJson(indexPath);

    if (index.game !== "minecraft") {
      await fs.remove(stagingDir).catch(() => {});
      return res.status(400).json({ error: `This pack is for "${index.game}", not Minecraft.` });
    }

    // Back up the existing mods folder before touching anything — same
    // safety net pattern as world install. Skipped if there's nothing there.
    const modsDir = path.join(serverDir, "mods");
    let backupNote = "";
    if (fs.existsSync(modsDir) && (await fs.readdir(modsDir)).length > 0) {
      const backupsDir = path.join(serverDir, "backups");
      await fs.ensureDir(backupsDir);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupName = `pre-modpack-install-${timestamp}.zip`;
      const backupPath = path.join(backupsDir, backupName);
      const archiver = (await import("archiver")).default;
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(backupPath);
        const archive = archiver("zip", { zlib: { level: 9 } });
        output.on("close", () => resolve());
        archive.on("error", reject);
        archive.pipe(output);
        archive.directory(modsDir, false);
        archive.finalize();
      });
      backupNote = ` Your previous mods folder was backed up as ${backupName}.`;
    }
    await fs.ensureDir(modsDir);

    // Download every server-side mod file listed in the manifest, in
    // parallel batches (not all at once — packs can list 100+ mods, and
    // firing 100 concurrent connections at once is a good way to get
    // rate-limited or choke the box's network). Each file is verified
    // against its published sha1 hash so a corrupted download doesn't
    // silently land in the mods folder.
    const serverFiles = index.files.filter((f) => f.env?.server !== "unsupported");
    const failed: string[] = [];
    const BATCH_SIZE = 6;
    for (let i = 0; i < serverFiles.length; i += BATCH_SIZE) {
      const batch = serverFiles.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (file) => {
        const targetPath = path.join(serverDir, file.path);
        if (!isWithinBase(targetPath, serverDir)) { failed.push(file.path); return; }
        await fs.ensureDir(path.dirname(targetPath));
        const url = file.downloads[0];
        if (!url) { failed.push(file.path); return; }
        try {
          const dl = await axios({ url, method: "GET", responseType: "stream", headers: { "User-Agent": "FrostByte-Panel/1.0" } });
          const writer = fs.createWriteStream(targetPath);
          dl.data.pipe(writer);
          await new Promise<void>((resolve, reject) => { writer.on("finish", resolve); writer.on("error", reject); });
          if (file.hashes?.sha1) {
            const actual = await sha1File(targetPath);
            if (actual !== file.hashes.sha1) {
              await fs.remove(targetPath).catch(() => {});
              failed.push(file.path);
            }
          }
        } catch {
          failed.push(file.path);
        }
      }));
    }

    // overrides/ is configs, resource packs, and anything else the pack
    // author bundled directly rather than fetching from Modrinth — copy
    // it straight over the server directory, on top of the downloaded mods.
    const overridesDir = path.join(stagingDir, "overrides");
    const serverOverridesDir = path.join(stagingDir, "server-overrides");
    for (const dir of [overridesDir, serverOverridesDir]) {
      if (fs.existsSync(dir)) {
        await fs.copy(dir, serverDir, { overwrite: true });
      }
    }

    await fs.remove(stagingDir).catch(() => {});

    logActivity({
      actorId: user.id,
      actorUsername: user.username,
      action: "modpack.install",
      target: index.name || "modpack",
      serverId: id,
      metadata: { minecraftVersion: index.dependencies?.minecraft, modLoader: Object.keys(index.dependencies || {}).find((k) => k !== "minecraft"), fileCount: serverFiles.length, failedCount: failed.length },
    });

    const summary = failed.length > 0
      ? `Installed ${index.name} with ${serverFiles.length - failed.length}/${serverFiles.length} mods (${failed.length} failed — check logs).${backupNote}`
      : `Installed ${index.name} — ${serverFiles.length} mods ready.${backupNote}`;

    try {
      const { notifyUser } = await import("../services/notifications.js");
      await notifyUser(user.id, {
        type: failed.length > 0 ? "warning" : "success",
        title: "Modpack installed",
        message: summary,
        serverId: id,
        link: `/servers/${id}/mods`,
      });
    } catch { /* best-effort */ }

    res.json({
      success: true,
      packName: index.name,
      minecraftVersion: index.dependencies?.minecraft,
      modLoader: Object.keys(index.dependencies || {}).find((k) => k !== "minecraft"),
      installedCount: serverFiles.length - failed.length,
      failedFiles: failed,
      message: summary,
    });
  } catch (error: any) {
    console.error("Modpack installation failed:", error.message);
    res.status(500).json({ error: "Modpack installation failed: " + error.message });
  } finally {
    if (cleanupMrpack && mrpackPath) {
      await fs.remove(mrpackPath).catch(() => {});
    }
  }
};

// --- Scheduled tasks ---------------------------------------------------
// Thin HTTP layer over src/server/services/scheduler.ts, which owns the
// actual storage and the background tick loop that runs due tasks.

const VALID_ACTIONS = ["restart", "backup", "command", "stop", "start"];

function validateRecurrence(recurrence: any): string | null {
  if (!recurrence || typeof recurrence !== "object") return "Missing recurrence.";
  if (!["interval", "daily", "weekly"].includes(recurrence.frequency)) {
    return "recurrence.frequency must be 'interval', 'daily', or 'weekly'.";
  }
  if (recurrence.frequency === "interval") {
    if (typeof recurrence.intervalMinutes !== "number" || recurrence.intervalMinutes < 5 || recurrence.intervalMinutes > 10080) {
      return "intervalMinutes must be between 5 and 10080 (one week).";
    }
  } else {
    if (recurrence.hour !== undefined && (typeof recurrence.hour !== "number" || recurrence.hour < 0 || recurrence.hour > 23)) {
      return "hour must be between 0 and 23.";
    }
    if (recurrence.minute !== undefined && (typeof recurrence.minute !== "number" || recurrence.minute < 0 || recurrence.minute > 59)) {
      return "minute must be between 0 and 59.";
    }
    if (recurrence.frequency === "weekly" && recurrence.dayOfWeek !== undefined) {
      if (typeof recurrence.dayOfWeek !== "number" || recurrence.dayOfWeek < 0 || recurrence.dayOfWeek > 6) {
        return "dayOfWeek must be between 0 (Sunday) and 6 (Saturday).";
      }
    }
  }
  return null;
}

export const getScheduledTasks = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const { getTasks } = await import("../services/scheduler.js");
    const tasks = await getTasks(id);
    res.json(tasks);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to load scheduled tasks." });
  }
};

export const createScheduledTask = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;
  const { name, action, commandText, recurrence } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "A task name is required." });
  }
  if (!VALID_ACTIONS.includes(action)) {
    return res.status(400).json({ error: `action must be one of: ${VALID_ACTIONS.join(", ")}` });
  }
  if (action === "command" && (!commandText || typeof commandText !== "string" || !commandText.trim())) {
    return res.status(400).json({ error: "commandText is required for the 'command' action." });
  }
  const recurrenceError = validateRecurrence(recurrence);
  if (recurrenceError) return res.status(400).json({ error: recurrenceError });

  try {
    const { createTask } = await import("../services/scheduler.js");
    const task = await createTask({
      serverId: id,
      name: name.trim(),
      action,
      commandText: action === "command" ? commandText.trim() : undefined,
      recurrence,
      createdBy: user.id,
    });
    logActivity({ actorId: user.id, actorUsername: user.username, action: "scheduledTask.create", target: task.name, serverId: id });
    res.json(task);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to create scheduled task." });
  }
};

export const updateScheduledTask = async (req: Request, res: Response) => {
  const { id, taskId } = req.params;
  const user = (req as any).user;
  const { name, enabled, recurrence, commandText } = req.body;

  if (recurrence !== undefined) {
    const recurrenceError = validateRecurrence(recurrence);
    if (recurrenceError) return res.status(400).json({ error: recurrenceError });
  }

  try {
    const { getTasks, updateTask } = await import("../services/scheduler.js");
    const existing = (await getTasks(id)).find((t) => t.id === taskId);
    if (!existing) return res.status(404).json({ error: "Scheduled task not found." });

    const updated = await updateTask(taskId, { name, enabled, recurrence, commandText });
    logActivity({ actorId: user.id, actorUsername: user.username, action: "scheduledTask.update", target: updated?.name || taskId, serverId: id });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to update scheduled task." });
  }
};

export const deleteScheduledTask = async (req: Request, res: Response) => {
  const { id, taskId } = req.params;
  const user = (req as any).user;
  try {
    const { getTasks, deleteTask } = await import("../services/scheduler.js");
    const existing = (await getTasks(id)).find((t) => t.id === taskId);
    if (!existing) return res.status(404).json({ error: "Scheduled task not found." });

    await deleteTask(taskId);
    logActivity({ actorId: user.id, actorUsername: user.username, action: "scheduledTask.delete", target: existing.name, serverId: id });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to delete scheduled task." });
  }
};
