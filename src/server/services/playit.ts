import fs from "fs-extra";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import { exec } from "child_process";
import { io } from "../../../server.js";

const execAsync = promisify(exec);

// One playit-cli process per server, keyed by server id.
const processes = new Map<string, ChildProcess>();
const logs = new Map<string, string>();
const claimLinks = new Map<string, string | null>();
const secretPaths = new Map<string, string>();

const MAX_LOG_CHARS = 20000;

const appendLog = (id: string, chunk: string) => {
  const current = logs.get(id) || "";
  const next = (current + chunk).slice(-MAX_LOG_CHARS);
  logs.set(id, next);
  io.to(`server:${id}`).emit("playit:log", { serverId: id, chunk });
};

// playit-cli is a single static binary; we resolve it once and cache the path.
let cachedBinary: string | null = null;
export const resolvePlayitBinary = async (): Promise<string> => {
  if (cachedBinary) return cachedBinary;
  try {
    const { stdout } = await execAsync("which playit");
    if (stdout.trim()) {
      cachedBinary = stdout.trim();
      return cachedBinary;
    }
  } catch {
    /* not on PATH, fall through */
  }
  const fallback = "/usr/local/bin/playit";
  if (await fs.pathExists(fallback)) {
    cachedBinary = fallback;
    return fallback;
  }
  throw new Error(
    "playit-cli binary not found. Install it first: https://playit.gg/download (place the binary at /usr/local/bin/playit or ensure it's on PATH)."
  );
};

export const getPlayitStatus = (id: string) => {
  const running = processes.has(id);
  return {
    status: running ? ("running" as const) : ("stopped" as const),
    claimLink: claimLinks.get(id) || null,
    logs: logs.get(id) || "",
  };
};

export const startPlayitTunnel = async (id: string, localPort: number) => {
  if (processes.has(id)) {
    throw new Error("Playit tunnel is already running for this server.");
  }

  const binary = await resolvePlayitBinary();

  const dataDir = path.join(process.cwd(), ".data", "playit");
  await fs.ensureDir(dataDir);
  const secretPath = path.join(dataDir, `${id}.secret`);
  secretPaths.set(id, secretPath);

  logs.set(id, "");
  claimLinks.set(id, null);

  // playit-cli auto-generates a claim URL on first run if no secret file
  // exists yet; on later runs with a saved secret it reconnects silently.
  const child = spawn(binary, ["--secret-path", secretPath, "--stdout"], {
    cwd: dataDir,
    env: { ...process.env, PLAYIT_LOCAL_PORT: String(localPort) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  processes.set(id, child);

  const claimRegex = /(https?:\/\/playit\.gg\/claim\/[a-zA-Z0-9-]+)/;

  child.stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    appendLog(id, text);
    const match = text.match(claimRegex);
    if (match && !claimLinks.get(id)) {
      claimLinks.set(id, match[1]);
      io.to(`server:${id}`).emit("playit:claim", { serverId: id, claimLink: match[1] });
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    appendLog(id, data.toString());
  });

  child.on("exit", (code) => {
    processes.delete(id);
    appendLog(id, `\n[playit] process exited with code ${code}\n`);
    io.to(`server:${id}`).emit("playit:status", { serverId: id, status: "stopped" });
  });

  child.on("error", (err) => {
    processes.delete(id);
    appendLog(id, `\n[playit] failed to start: ${err.message}\n`);
  });

  return getPlayitStatus(id);
};

export const stopPlayitTunnel = async (id: string) => {
  const child = processes.get(id);
  if (!child) return getPlayitStatus(id);
  child.kill("SIGTERM");
  processes.delete(id);
  return getPlayitStatus(id);
};

// Removes the saved claim secret so the next start requires re-claiming
// (useful if the tunnel was claimed by the wrong playit.gg account).
export const resetPlayitTunnel = async (id: string) => {
  await stopPlayitTunnel(id);
  const secretPath = secretPaths.get(id) || path.join(process.cwd(), ".data", "playit", `${id}.secret`);
  await fs.remove(secretPath).catch(() => {});
  claimLinks.set(id, null);
  logs.set(id, "");
  return getPlayitStatus(id);
};
