import { Request, Response } from "express";
import { readJSON, writeJSON, updateJSON } from "../services/db.js";
import { createServerContainer, startContainer, stopContainer, restartContainer, deleteContainer, getContainerStatus, sendContainerCommand, attachContainerSocket, getContainerStats } from "../services/docker.js";
import { createSftpUser, deleteSftpUser } from "../services/sftp.js";
import { logActivity } from "../services/activityLog.js";
import { v4 as uuidv4 } from "uuid";
import fs from "fs-extra";
import path from "path";
import { ZipArchive } from "archiver";
import extract from "extract-zip";

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
       const content = await fs.readFile(targetPath, "utf-8");
       return res.json({ isFile: true, content });
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
    const archive = new ZipArchive({ zlib: { level: 9 } });

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
    const archive = new ZipArchive({ zlib: { level: 9 } });

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
