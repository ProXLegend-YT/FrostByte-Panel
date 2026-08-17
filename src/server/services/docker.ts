import Docker from "dockerode";
import fs from "fs-extra";
import path from "path";
import crypto from "crypto";
import { io } from "../../../server.js"; // Import socket for logs
import { readJSON } from "./db.js";
import { getGameDefinition, getDockerImageFor } from "../gameDefinitions.js";
import * as local from "./local.js";

// RUNTIME_MODE=local is an install-time choice (see install.sh) for hosts
// that don't permit nested Docker containers — some managed VPS platforms
// block the kernel-level networking operations Docker's bridge driver
// needs, even for a process running as root inside the box, because
// allowing it could let one tenant affect others sharing the physical
// host. On such a host, isSandbox alone doesn't help: Docker's daemon
// itself is present and briefly reachable, it simply can't finish
// initializing its network layer. RUNTIME_MODE lets an operator route
// around that at setup time and get real running servers via native child
// processes instead, rather than being silently stuck in demo/sandbox
// behavior forever with no way to actually run anything.
export const isLocalMode = (process.env.RUNTIME_MODE || "docker").toLowerCase() === "local";

export const isSandbox = !isLocalMode && !fs.existsSync("/var/run/docker.sock") && process.platform !== "win32";

export const docker = new Docker({ socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock' });

// Mock state for sandbox demo
const mockState: Record<string, boolean> = {};

// Tracks servers we're expecting to stop because a user explicitly requested
// it (stop/restart/delete), so the crash-detection logic in
// attachContainerSocket can tell a normal stop apart from an unexpected
// crash and only notify on the latter.
const expectedStops = new Set<string>();
export const markExpectedStop = (containerId: string) => expectedStops.add(containerId);

export const getVersions = async (type: string = "PAPER", gameId: string = "minecraft") => {
  const gameDef = getGameDefinition(gameId);
  return gameDef.getVersions(type);
};

const DOCKER_IMAGE = "itzg/minecraft-server";

export const createServerContainer = async (serverData: any) => {
  if (isLocalMode) return local.createLocalServer(serverData);
  if (isSandbox) {
    mockState[serverData.id] = false;
    return "mock-container-id-" + serverData.id;
  }

  // Existing server records predate multi-game support and have no `game`
  // field — treat those as Minecraft so nothing already deployed breaks.
  const gameId = serverData.game || "minecraft";
  const gameDef = getGameDefinition(gameId);
  const subtype = serverData.type || (gameDef.subtypes ? gameDef.subtypes[0].id : undefined);
  const dockerImage = getDockerImageFor(gameId, subtype);
  const isProxy = gameId === "minecraft" && ["VELOCITY", "BUNGEECORD", "WATERFALL"].includes((subtype || "").toUpperCase());

  // Pull image if not exists
  console.log(`Ensuring ${dockerImage} is pulled...`);
  await new Promise((resolve, reject) => {
    docker.pull(dockerImage, (err: any, stream: any) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, onFinished, onProgress);
      function onFinished(err: any, output: any) {
        if (err) return reject(err);
        resolve(output);
      }
      function onProgress(event: any) {}
    });
  });

  const serverDir = path.join(process.cwd(), ".data", "servers", serverData.id);
  await fs.ensureDir(serverDir);

  const rconPassword = gameDef.supportsRcon && !isProxy ? crypto.randomBytes(16).toString("hex") : undefined;
  const envVars = gameDef.buildEnv({ serverData, rconPassword });
  const startupCommand = gameDef.getStartupCommand?.({ serverData, rconPassword });

  const containerDataPath = isProxy ? "/server" : gameDef.containerDataPath;

  const protocols: ("tcp" | "udp")[] =
    gameDef.portProtocol === "both" ? ["tcp", "udp"] : [gameDef.portProtocol];

  const exposedPorts: Record<string, {}> = {};
  const portBindings: Record<string, { HostPort: string }[]> = {};
  for (const proto of protocols) {
    const key = `${serverData.port}/${proto}`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostPort: `${serverData.port}` }];
  }

  const container = await docker.createContainer({
    Image: dockerImage,
    name: `frostbyte-server-${serverData.id}`,
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    Env: envVars,
    ...(startupCommand ? { Cmd: startupCommand, WorkingDir: containerDataPath } : {}),
    ExposedPorts: exposedPorts,
    HostConfig: {
      PortBindings: portBindings,
      Binds: [`${serverDir}:${containerDataPath}`],
      ...buildResourceLimits(serverData),
    }
  });

  return container.id;
};

/**
 * Translates the panel's stored limit fields into real Docker HostConfig
 * resource constraints, so a server's "RAM limit" and "CPU limit" are
 * actually enforced by the container runtime — not just passed as a hint
 * to the JVM inside the container, which a misbehaving or non-JVM process
 * could ignore entirely. This matters most on a shared/public host, where
 * one tenant's container should never be able to starve another's.
 *
 * - ram is stored in GB. A small headroom margin isn't added here — the
 *   admin-set number is treated as the hard ceiling.
 * - cpu is stored as a percentage of one core (100 = 1 full core), matching
 *   how it's already displayed in the UI. Docker's NanoCpus wants a
 *   fractional core count in units of 1e9.
 */
function buildResourceLimits(serverData: any): { Memory?: number; NanoCpus?: number; MemorySwap?: number } {
  const limits: { Memory?: number; NanoCpus?: number; MemorySwap?: number } = {};

  const ramGb = Number(serverData.ram);
  if (Number.isFinite(ramGb) && ramGb > 0) {
    const bytes = Math.round(ramGb * 1024 * 1024 * 1024);
    limits.Memory = bytes;
    // Disable swap beyond the memory limit so a container can't silently
    // exceed its RAM allocation by spilling to disk swap.
    limits.MemorySwap = bytes;
  }

  const cpuPercent = Number(serverData.cpu);
  if (Number.isFinite(cpuPercent) && cpuPercent > 0) {
    limits.NanoCpus = Math.round((cpuPercent / 100) * 1_000_000_000);
  }

  return limits;
}

/**
 * Live-updates the CPU/RAM limits on a running or stopped container without
 * recreating it. Used when an admin adjusts a server's resource limits
 * after creation.
 */
export const updateContainerResources = async (containerId: string, ram?: number, cpu?: number) => {
  if (isSandbox || isLocalMode) return; // local mode enforces no hard resource caps — see local.ts header comment

  const update: { Memory?: number; MemorySwap?: number; NanoCpus?: number } = {};
  if (ram !== undefined && Number.isFinite(ram) && ram > 0) {
    const bytes = Math.round(ram * 1024 * 1024 * 1024);
    update.Memory = bytes;
    update.MemorySwap = bytes;
  }
  if (cpu !== undefined && Number.isFinite(cpu) && cpu > 0) {
    update.NanoCpus = Math.round((cpu / 100) * 1_000_000_000);
  }

  if (Object.keys(update).length === 0) return;

  const container = docker.getContainer(containerId);
  await container.update(update);
};

/** Local-mode container "IDs" are local-<serverId> — this strips the
 * prefix and loads the full server record local.ts's functions need
 * (unlike dockerode, which only ever needs the container ID itself). */
async function loadServerForLocalId(containerId: string): Promise<{ id: string; server: any } | null> {
  const id = containerId.replace(/^local-/, "");
  const servers = (await readJSON("servers.json")) || [];
  const server = servers.find((s: any) => s.id === id);
  return server ? { id, server } : null;
}

export const startContainer = async (containerId: string) => {
  if (isLocalMode) {
    const found = await loadServerForLocalId(containerId);
    if (found) await local.startLocalServer(found.id, found.server);
    return;
  }
  if (isSandbox) {
    const id = containerId.replace("mock-container-id-", "");
    mockState[id] = true;
    
    // In sandbox mode, mock the generation of server files that the docker container would normally do
    try {
      const servers = await readJSON("servers.json") || [];
      const server = servers.find((s: any) => s.id === id);
      if (server) {
        const serverDir = path.join(process.cwd(), ".data", "servers", id);
        await fs.ensureDir(serverDir);
        const type = (server.type || "PAPER").toUpperCase();
        
        if (["VELOCITY", "BUNGEECORD", "WATERFALL"].includes(type)) {
          const configName = type === "VELOCITY" ? "velocity.toml" : "config.yml";
          const configPath = path.join(serverDir, configName);
          if (!fs.existsSync(configPath)) {
            await fs.writeFile(configPath, "# Autogenerated proxy config in sandbox mode\n# Port: " + server.port + "\n");
          }
        } else {
          const propsPath = path.join(serverDir, "server.properties");
          if (!fs.existsSync(propsPath)) {
            await fs.writeFile(propsPath, "server-port=" + server.port + "\nmotd=A Minecraft Server\n");
          }
        }
      }
    } catch(e) {}
    
    io.to(`server_${id}`).emit("log", `[System] Server started (Sandbox Mode).\r\n`);
    return;
  }
  const container = docker.getContainer(containerId);
  await container.start();
};

export const stopContainer = async (containerId: string) => {
  if (isLocalMode) {
    const found = await loadServerForLocalId(containerId);
    if (found) await local.stopLocalServer(found.id);
    return;
  }
  if (isSandbox) {
    const id = containerId.replace("mock-container-id-", "");
    mockState[id] = false;
    io.to(`server_${id}`).emit("log", `[System] Server stopped (Sandbox Mode).\r\n`);
    return;
  }
  markExpectedStop(containerId);
  // Real (non-sandbox) containers previously got zero console feedback on
  // stop — sandbox mode always emitted a message, but the real path went
  // straight to container.stop() with nothing surfaced to anyone watching
  // the console. From the user's side this looked exactly like "nothing
  // happens when I stop the server," even though the stop itself worked.
  const serverIdForLog = await resolveServerIdFromContainerId(containerId);
  if (serverIdForLog) {
    io.to(`server_${serverIdForLog}`).emit("log", `[System] Stopping server...\r\n`);
  }
  const container = docker.getContainer(containerId);
  await container.stop();
  if (serverIdForLog) {
    io.to(`server_${serverIdForLog}`).emit("log", `[System] Server stopped.\r\n`);
  }
};

/** Looks up which server owns a given container ID — used only for
 * emitting console messages tied to a serverId, since stopContainer only
 * receives the containerId from its caller. */
async function resolveServerIdFromContainerId(containerId: string): Promise<string | null> {
  try {
    const { readJSON } = await import("./db.js");
    const servers = (await readJSON("servers.json")) || [];
    const server = servers.find((s: any) => s.containerId === containerId);
    return server?.id || null;
  } catch {
    return null;
  }
}

export const restartContainer = async (containerId: string) => {
  if (isLocalMode) {
    const found = await loadServerForLocalId(containerId);
    if (found) await local.restartLocalServer(found.id, found.server);
    return;
  }
  if (isSandbox) {
    const id = containerId.replace("mock-container-id-", "");
    mockState[id] = true;
    io.to(`server_${id}`).emit("log", `[System] Server restarted (Sandbox Mode).\r\n`);
    return;
  }
  markExpectedStop(containerId);
  const container = docker.getContainer(containerId);
  await container.restart();
};

export const deleteContainer = async (containerId: string) => {
  if (isLocalMode) {
    const found = await loadServerForLocalId(containerId);
    if (found) await local.deleteLocalServer(found.id);
    return;
  }
  if (isSandbox) {
    const id = containerId.replace("mock-container-id-", "");
    delete mockState[id];
    return;
  }
  markExpectedStop(containerId);
  const container = docker.getContainer(containerId);
  try {
    const info = await container.inspect();
    if (info.State.Running) {
      await container.stop();
    }
    await container.remove({ force: true });
  } catch (err) {
    console.error("Error deleting container", err);
  }
};

export const getContainerStatus = async (containerId: string) => {
  if (isLocalMode) {
    const id = containerId.replace(/^local-/, "");
    return local.getLocalServerStatus(id);
  }
  if (isSandbox) {
    const id = containerId.replace("mock-container-id-", "");
    const isRunning = mockState[id] || false;
    return { State: { Running: isRunning, Status: isRunning ? "running" : "exited" } };
  }
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    return info;
  } catch (e) {
    return null;
  }
};

export const getContainerStats = async (containerId: string) => {
  if (isLocalMode) {
    const id = containerId.replace(/^local-/, "");
    return local.getLocalServerStats(id);
  }
  if (isSandbox) {
    const id = containerId.replace("mock-container-id-", "");
    if (!mockState[id]) return { cpu: 0, ram: 0, disk: 0 };
    
    // Stable pseudo-random mock stats based on time so it fluctuates realistically
    const timeSec = Math.floor(Date.now() / 5000);
    const floatPseudo = (Math.sin(timeSec + id.charCodeAt(0)) + 1) / 2; // 0 to 1
    
    return {
      cpu: floatPseudo * 10 + 2, // 2% to 12%
      ram: 600 + (floatPseudo * 50 - 25), // ~600 MB
      disk: 2.1
    };
  }
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    if (!info.State.Running) {
      return { cpu: 0, ram: 0, disk: 0 };
    }
    const statsResult = await container.stats({ stream: false });
    
    let cpuPercent = 0.0;
    try {
      const cpuDelta = statsResult.cpu_stats.cpu_usage.total_usage - statsResult.precpu_stats.cpu_usage.total_usage;
      const systemDelta = statsResult.cpu_stats.system_cpu_usage - statsResult.precpu_stats.system_cpu_usage;
      if (systemDelta > 0.0 && cpuDelta > 0.0) {
        const cpus = statsResult.cpu_stats.online_cpus || statsResult.cpu_stats.cpu_usage.percpu_usage?.length || 1;
        cpuPercent = (cpuDelta / systemDelta) * cpus * 100.0;
      }
    } catch(e) {}

    let ramMB = 0.0;
    try {
      const stats = statsResult.memory_stats.stats as any || {};
      const cache = stats.cache || stats.inactive_file || stats.total_inactive_file || 0;
      const usedMemory = statsResult.memory_stats.usage - cache;
      ramMB = usedMemory / 1024 / 1024;
    } catch(e) {}

    // Roughly calculate disk size from the volume directory if possible, or provide a default for now.
    return {
      cpu: cpuPercent,
      ram: ramMB,
      disk: 2.1
    };
  } catch (e) {
    return { cpu: 0, ram: 0, disk: 0 };
  }
};

export const getContainerLogs = async (containerId: string): Promise<string> => {
  if (isSandbox) return "[System] Sandbox mode. No historical logs available.\r\n";
  try {
    const container = docker.getContainer(containerId);
    
    // Convert Buffer log output to string safely. dockerode returns interleaved multiplexed streams if tty is false,
    // but we use tty: true in createServerContainer, so it's a raw stream buffer.
    const logsBuffer = await container.logs({ stdout: true, stderr: true, tail: 100 });
    return logsBuffer.toString('utf8');
  } catch (e) {
    return "";
  }
};

const activeStreams: Record<string, NodeJS.ReadWriteStream> = {};

export const attachContainerSocket = async (containerId: string, serverId: string) => {
  if (isLocalMode) {
    // No-op by design: startLocalServer already wires the child process's
    // stdout/stderr directly to io.to(`server_${id}`).emit("log", ...) the
    // moment it spawns — there's no separate container to "attach" to
    // after the fact the way a Docker container's stream needs attaching.
    return;
  }
  if (isSandbox) {
    return;
  }
  try {
    const container = docker.getContainer(containerId);

    // Always tear down and reattach fresh, rather than skipping when a
    // cache entry already exists for this containerId. The previous
    // "only attach if not already attached" check assumed a cached stream
    // was still live, but a restart gives the container a genuinely new
    // process with a new stdout — the *container ID* stays the same, but
    // the old attached stream doesn't automatically follow the new
    // process. If the old stream's 'end' event hadn't fired yet (or ever)
    // by the time restart/start ran again, attachContainerSocket would
    // silently do nothing: no new listener, no forwarded output — which
    // is exactly "nothing shows up when I start/restart the server."
    const existing = activeStreams[containerId];
    if (existing) {
      try {
        existing.removeAllListeners();
        if (typeof (existing as any).destroy === "function") (existing as any).destroy();
      } catch { /* best-effort cleanup of a possibly-already-dead stream */ }
      delete activeStreams[containerId];
    }

    const stream = await container.attach({ stream: true, stdout: true, stderr: true, stdin: true });
    activeStreams[containerId] = stream;
    stream.on('data', (chunk) => {
      io.to(`server_${serverId}`).emit("log", chunk.toString());
    });
    stream.on('end', async () => {
      delete activeStreams[containerId];

      const wasExpected = expectedStops.delete(containerId);
      if (wasExpected) return;

      // Stream ended without us having asked for a stop — likely a crash.
      // Give the daemon a moment to record the exit, then check.
      try {
        await new Promise((r) => setTimeout(r, 1500));
        const info = await container.inspect();
        if (info.State && !info.State.Running && info.State.ExitCode !== 0) {
          // Surface this in the console itself, not just as a toast —
          // someone actively watching the console when a crash happens
          // should see a clear reason, not just the stream going quiet.
          io.to(`server_${serverId}`).emit(
            "log",
            `[System Error] Container exited unexpectedly with code ${info.State.ExitCode}.\r\n`
          );

          const { updateJSON, readJSON } = await import("./db.js");
          let crashedServer: any = null;
          await updateJSON("servers.json", (current: any[]) => {
            const servers = current || [];
            const server = servers.find((s: any) => s.id === serverId);
            if (server) {
              server.status = "offline";
              crashedServer = server;
            }
            return servers;
          });

          if (crashedServer) {
            const { notifyUser } = await import("./notifications.js");
            const recipients = [crashedServer.owner, ...(crashedServer.subUsers || []).map((su: any) => su.userId)].filter(Boolean);
            for (const uid of recipients) {
              notifyUser(uid, {
                type: "error",
                title: "Server stopped unexpectedly",
                message: `"${crashedServer.name}" exited with code ${info.State.ExitCode}. Check the console for details.`,
                serverId,
                link: `/servers/${serverId}`,
              }).catch(() => {});
            }

            const { notifyServerDiscord } = await import("./discord.js");
            notifyServerDiscord(crashedServer, "server.crash", `Exited with code ${info.State.ExitCode}. Check the console for details.`).catch(() => {});
          }
        }
      } catch (inspectErr) {
        console.error("Crash-detection inspect failed:", inspectErr);
      }
    });
  } catch(e) {
    console.error("Attach error", e);
  }
};

export const sendContainerCommand = async (containerId: string, command: string) => {
  if (isLocalMode) {
    const id = containerId.replace(/^local-/, "");
    await local.sendLocalServerCommand(id, command);
    return;
  }
  if (isSandbox) {
    const id = containerId.replace("mock-container-id-", "");
    io.to(`server_${id}`).emit("log", `> ${command}\r\n`);
    return;
  }
  if (activeStreams[containerId]) {
    activeStreams[containerId].write(command + "\n");
  } else {
    try {
      const container = docker.getContainer(containerId);
      const stream = await container.attach({ stream: true, stdout: true, stderr: true, stdin: true });
      activeStreams[containerId] = stream;
      stream.write(command + "\n");
      stream.on('data', (chunk) => {
        // Will be broadcasted due to existing or new attach
      });
    } catch(e) {
       console.error("Command error", e);
    }
  }
};
