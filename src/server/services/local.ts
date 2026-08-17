import fs from "fs-extra";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import { exec } from "child_process";
import axios from "axios";
import { downloadJar } from "./jarDownloader.js";
import { io } from "../../../server.js";

// The local process engine — an alternative to Docker for hosts that don't
// allow nested containers (some managed VPS platforms block the kernel
// operations Docker's bridge networking needs, even when running as root
// inside the box). Instead of a container, each server becomes a plain
// child process on the host, with its own working directory under
// .data/servers/<id> — the exact same directory Docker containers already
// bind-mount, so nothing about file storage or the panel's file manager
// needs to change to support this.
//
// This trades real OS-level isolation (a Docker container can't see or
// touch another container's filesystem or process list; a plain child
// process technically can, if it tried) for the ability to run at all on
// a host where Docker itself is unavailable. That tradeoff is deliberate
// and install.sh makes it an explicit, informed choice at setup time
// rather than a silent fallback.

const execAsync = promisify(exec);
const processes = new Map<string, ChildProcess>();
const localStartedAt = new Map<string, string>();

function emitLog(serverId: string, text: string) {
  io.to(`server_${serverId}`).emit("log", text);
}

/**
 * Resolves a Java binary matching the Minecraft version being run. Checks,
 * in order: an explicit JAVA_BIN env override, a previously-provisioned
 * portable JRE under .data/bin, common system install paths, then finally
 * auto-downloads the right Temurin OpenJDK build if nothing else is found
 * — this is what lets a from-scratch VPS run a Minecraft server without
 * the operator having to manually install Java first.
 */
export const resolveJavaBinary = async (serverData?: any, onLog?: (msg: string) => void): Promise<string> => {
  if (process.env.JAVA_BIN && await fs.pathExists(process.env.JAVA_BIN)) {
    return process.env.JAVA_BIN;
  }

  let targetVer = "21";
  if (serverData?.javaVersion && String(serverData.javaVersion).trim() !== "") {
    targetVer = String(serverData.javaVersion).trim().toLowerCase().replace(/^java/, "");
  } else if (serverData?.version) {
    const v = String(serverData.version).toLowerCase();
    if (["1.7", "1.8", "1.9", "1.10", "1.11", "1.12", "1.13", "1.14", "1.15"].some((p) => v.startsWith(p))) {
      targetVer = "8";
    } else if (v.startsWith("1.16")) {
      targetVer = "11";
    } else if (["1.17", "1.18", "1.19", "1.20.1", "1.20.2", "1.20.3", "1.20.4"].some((p) => v.startsWith(p))) {
      targetVer = "17";
    } else {
      targetVer = "21";
    }
  }

  const localPortableJava = path.join(process.cwd(), ".data", "bin", `jre-${targetVer}`, "bin", "java");
  if (await fs.pathExists(localPortableJava)) return localPortableJava;

  const candidates = [
    `/usr/lib/jvm/java-${targetVer}-openjdk-amd64/bin/java`,
    `/usr/lib/jvm/java-${targetVer}-openjdk-arm64/bin/java`,
    `/usr/lib/jvm/java-${targetVer}-openjdk/bin/java`,
    `/usr/lib/jvm/java-${targetVer}/bin/java`,
    `/usr/lib/jvm/temurin-${targetVer}-jdk-amd64/bin/java`,
    `/opt/java/openjdk-${targetVer}/bin/java`,
    "/usr/bin/java",
    "/usr/local/bin/java",
  ];
  for (const cand of candidates) {
    if (await fs.pathExists(cand)) return cand;
  }
  try {
    await execAsync("which java");
    return "java";
  } catch { /* fall through to auto-provisioning */ }

  try {
    const binDir = path.join(process.cwd(), ".data", "bin");
    const jreDir = path.join(binDir, `jre-${targetVer}`);
    const tarPath = path.join(binDir, `jre-${targetVer}.tar.gz`);

    onLog?.(`Java ${targetVer} runtime not found on host. Provisioning OpenJDK ${targetVer} LTS...`);
    await fs.ensureDir(binDir);

    const res = await axios({
      method: "GET",
      url: `https://api.adoptium.net/v3/binary/latest/${targetVer}/ga/linux/x64/jre/hotspot/normal/eclipse`,
      responseType: "stream",
      maxRedirects: 5,
      timeout: 60000,
    });
    const writer = fs.createWriteStream(tarPath);
    res.data.pipe(writer);
    await new Promise<void>((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    await fs.ensureDir(jreDir);
    await execAsync(`tar -xzf "${tarPath}" -C "${jreDir}" --strip-components=1`);
    await fs.remove(tarPath).catch(() => {});
    await execAsync(`chmod +x "${localPortableJava}"`);

    onLog?.(`OpenJDK ${targetVer} runtime provisioned successfully.`);
    return localPortableJava;
  } catch (err: any) {
    onLog?.(`Auto-provisioning JRE ${targetVer} failed: ${err.message}. Falling back to 'java' on PATH.`);
  }

  return process.env.JAVA_BIN || "java";
};

export const resolvePythonBinary = async (): Promise<string> => {
  for (const cand of ["python3", "python"]) {
    try {
      await execAsync(`which ${cand}`);
      return cand;
    } catch { /* try next candidate */ }
  }
  return "python3";
};

export const resolveNodeBinary = async (): Promise<string> => process.execPath;

/**
 * Sets up a server's working directory before first start: writes default
 * source files for Node/Python "applications" (mirrors what the Docker
 * image's own startup script would generate), or ensures a server.jar
 * exists for Minecraft-family types.
 */
export const createLocalServer = async (serverData: any) => {
  const serverPath = path.join(process.cwd(), ".data", "servers", serverData.id);
  await fs.ensureDir(serverPath);
  const type = (serverData.type || "paper").toLowerCase();

  if (type === "nodejs" || type === "node") {
    const indexPath = path.join(serverPath, "index.js");
    const pkgPath = path.join(serverPath, "package.json");
    if (!await fs.pathExists(indexPath)) {
      await fs.writeFile(
        indexPath,
        `// Node.js application on FrostByte Panel\nconst http = require('http');\nconst port = process.env.PORT || process.env.SERVER_PORT || ${serverData.port || 3000};\nconsole.log('Node.js app listening on port ' + port);\nhttp.createServer((req, res) => {\n  res.writeHead(200, { 'Content-Type': 'application/json' });\n  res.end(JSON.stringify({ status: 'online', runtime: 'node.js' }));\n}).listen(port, '0.0.0.0');\n`
      );
    }
    if (!await fs.pathExists(pkgPath)) {
      await fs.writeFile(pkgPath, JSON.stringify({
        name: (serverData.name || "node-app").toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
        version: "1.0.0",
        main: "index.js",
        scripts: { start: "node index.js" },
      }, null, 2));
    }
    return `local-${serverData.id}`;
  }

  if (type === "python" || type === "python3") {
    const mainPath = path.join(serverPath, "main.py");
    if (!await fs.pathExists(mainPath)) {
      await fs.writeFile(
        mainPath,
        `# Python application on FrostByte Panel\nimport os\nfrom http.server import HTTPServer, BaseHTTPRequestHandler\nport = int(os.environ.get("SERVER_PORT", ${serverData.port || 8000}))\nclass Handler(BaseHTTPRequestHandler):\n    def do_GET(self):\n        self.send_response(200)\n        self.end_headers()\n        self.wfile.write(b'{"status":"online"}')\nHTTPServer(('0.0.0.0', port), Handler).serve_forever()\n`
      );
    }
    return `local-${serverData.id}`;
  }

  if (type === "velocity") {
    const configPath = path.join(serverPath, "velocity.toml");
    if (!await fs.pathExists(configPath)) {
      await fs.writeFile(configPath, `bind = "0.0.0.0:${serverData.port || 25577}"\n`);
    }
    return `local-${serverData.id}`;
  }

  if (type === "bungeecord" || type === "waterfall") {
    const configPath = path.join(serverPath, "config.yml");
    if (!await fs.pathExists(configPath)) {
      await fs.writeFile(configPath, `listeners:\n- query_port: ${serverData.port || 25577}\n  host: 0.0.0.0:${serverData.port || 25577}\n`);
    }
    return `local-${serverData.id}`;
  }

  // Minecraft-family (vanilla/paper/spigot/forge/fabric): ensure EULA and
  // a server.jar exist. The actual download happens here rather than at
  // start time so createServerContainer's caller can surface failures
  // before ever attempting to start the process.
  await fs.writeFile(path.join(serverPath, "eula.txt"), "eula=true\n");
  const propsPath = path.join(serverPath, "server.properties");
  if (!await fs.pathExists(propsPath)) {
    await fs.writeFile(propsPath, `server-port=${serverData.port || 25565}\n`);
  }

  const jarPath = path.join(serverPath, "server.jar");
  const needDownload = !await fs.pathExists(jarPath) || (await fs.stat(jarPath)).size < 500 * 1024;
  if (needDownload) {
    try {
      await downloadJar(type, serverData.version || "latest", jarPath);
    } catch (e: any) {
      // Deferred rather than thrown — a slow/unreachable mirror during
      // creation shouldn't block the server record from being created;
      // startLocalServer will retry the download and surface a real error
      // there if it's still missing when the operator hits Start.
      console.warn(`[Local Server] Deferred JAR download: ${e.message}`);
    }
  }

  return `local-${serverData.id}`;
};

/**
 * Starts (or resumes) a server as a native child process, wiring its
 * stdout/stderr to both a persistent panel.log file and the live console
 * socket, matching how attachContainerSocket streams Docker container
 * output to the same server_<id> room.
 */
export const startLocalServer = async (id: string, serverData: any) => {
  const serverPath = path.join(process.cwd(), ".data", "servers", id);
  await fs.ensureDir(serverPath);
  const type = (serverData.type || "paper").toLowerCase();

  const logPath = path.join(serverPath, "panel.log");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const logMessage = (msg: string) => {
    const formatted = `[Panel] ${msg}\r\n`;
    if (logStream.writable) logStream.write(formatted);
    emitLog(id, formatted);
  };

  let child: ChildProcess;

  if (type === "nodejs" || type === "node") {
    const nodeBin = await resolveNodeBinary();
    if (serverData.startupCommand?.trim()) {
      const [bin, ...args] = serverData.startupCommand.trim().split(/\s+/);
      logMessage(`Executing custom startup command: ${serverData.startupCommand.trim()}`);
      child = spawn(bin, args, {
        cwd: serverPath,
        env: { ...process.env, PORT: String(serverData.port || 3000), SERVER_PORT: String(serverData.port || 3000), NODE_ENV: "production" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      let entry = "index.js";
      const pkgPath = path.join(serverPath, "package.json");
      if (await fs.pathExists(pkgPath)) {
        try {
          const pkg = await fs.readJSON(pkgPath);
          if (pkg.main && await fs.pathExists(path.join(serverPath, pkg.main))) entry = pkg.main;
        } catch { /* fall through to default entry candidates */ }
      }
      const candidates = ["index.js", "app.js", "server.js", "main.js", "bot.js", "run.js"];
      for (const f of candidates) {
        if (await fs.pathExists(path.join(serverPath, f))) { entry = f; break; }
      }
      logMessage(`Starting Node.js application (${entry}) on port ${serverData.port || 3000}...`);
      child = spawn(nodeBin, [entry], {
        cwd: serverPath,
        env: { ...process.env, PORT: String(serverData.port || 3000), SERVER_PORT: String(serverData.port || 3000), NODE_ENV: "production" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
  } else if (type === "python" || type === "python3") {
    const pythonBin = await resolvePythonBinary();
    if (serverData.startupCommand?.trim()) {
      const [bin, ...args] = serverData.startupCommand.trim().split(/\s+/);
      logMessage(`Executing custom startup command: ${serverData.startupCommand.trim()}`);
      child = spawn(bin, args, {
        cwd: serverPath,
        env: { ...process.env, PORT: String(serverData.port || 8000), SERVER_PORT: String(serverData.port || 8000), PYTHONUNBUFFERED: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      let entry = "main.py";
      const candidates = ["main.py", "app.py", "bot.py", "server.py", "run.py"];
      for (const f of candidates) {
        if (await fs.pathExists(path.join(serverPath, f))) { entry = f; break; }
      }
      logMessage(`Starting Python application (${entry}) on port ${serverData.port || 8000}...`);
      child = spawn(pythonBin, ["-u", entry], {
        cwd: serverPath,
        env: { ...process.env, PORT: String(serverData.port || 8000), SERVER_PORT: String(serverData.port || 8000), PYTHONUNBUFFERED: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
  } else {
    // Minecraft-family
    const jarPath = path.join(serverPath, "server.jar");
    if (!await fs.pathExists(jarPath) || (await fs.stat(jarPath)).size < 500 * 1024) {
      logMessage(`Server JAR missing or incomplete. Downloading ${type} (${serverData.version || "latest"})...`);
      try {
        await downloadJar(type, serverData.version || "latest", jarPath);
        logMessage("Server JAR downloaded successfully.");
      } catch (dlErr: any) {
        logMessage(`Failed to download JAR: ${dlErr.message}`);
        throw new Error(`Failed to download server.jar: ${dlErr.message}`);
      }
    }

    await fs.writeFile(path.join(serverPath, "eula.txt"), "eula=true\n");
    const memoryMb = Math.round((serverData.ram || 2) * 1024);
    const javaBin = await resolveJavaBinary(serverData, logMessage);

    if (serverData.startupCommand?.trim()) {
      const [bin, ...args] = serverData.startupCommand.trim().split(/\s+/);
      child = spawn(bin, args, { cwd: serverPath, stdio: ["pipe", "pipe", "pipe"] });
    } else {
      child = spawn(
        javaBin,
        ["-Xms128M", `-Xmx${memoryMb}M`, "-Dterminal.jline=false", "-Dterminal.ansi=true", "-Dfile.encoding=UTF-8", "-jar", "server.jar", "--nogui"],
        { cwd: serverPath, stdio: ["pipe", "pipe", "pipe"] }
      );
    }
  }

  processes.set(id, child);

  child.on("spawn", () => {
    localStartedAt.set(id, new Date().toISOString());
    logMessage(`Server process started with PID ${child.pid} for ${serverData.name || id} (${type})`);
  });

  child.on("error", (err: Error) => {
    localStartedAt.delete(id);
    logMessage(`Failed to start server process: ${err.message}`);
    if (err.message.includes("ENOENT")) {
      logMessage("---- RUNTIME NOTICE ----");
      logMessage(`Required executable for runtime "${type}" is missing or not on PATH.`);
      logMessage("For Minecraft servers this usually means Java isn't installed:");
      logMessage("  sudo apt update && sudo apt install -y openjdk-21-jre-headless");
      logMessage("------------------------");
    }
  });

  child.on("close", (code: number | null) => {
    logMessage(`Server process exited with code ${code}`);
    processes.delete(id);
    localStartedAt.delete(id);
  });

  child.stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    if (logStream.writable) logStream.write(text);
    emitLog(id, text);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    if (logStream.writable) logStream.write(text);
    emitLog(id, text);
  });

  return child;
};

export const stopLocalServer = async (id: string) => {
  localStartedAt.delete(id);
  const child = processes.get(id);
  if (!child) return;
  if (child.stdin?.writable) {
    try { child.stdin.write("stop\nend\nexit\n"); } catch { /* process may already be exiting */ }
  }
  setTimeout(() => {
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
  }, 2000);
};

export const restartLocalServer = async (id: string, serverData: any) => {
  await stopLocalServer(id);
  setTimeout(() => {
    startLocalServer(id, serverData).catch((err) => console.error("[Local Server] Restart failed:", err));
  }, 2500);
};

export const deleteLocalServer = async (id: string) => {
  await stopLocalServer(id);
  localStartedAt.delete(id);
  await fs.remove(path.join(process.cwd(), ".data", "servers", id)).catch(() => {});
};

/** Matches dockerode's container.inspect() shape closely enough that
 * getContainerStatus's existing callers don't need to know which backend
 * produced the result. */
export const getLocalServerStatus = async (id: string) => {
  const isRunning = processes.has(id);
  return {
    State: {
      Running: isRunning,
      Status: isRunning ? "running" : "exited",
      StartedAt: isRunning ? localStartedAt.get(id) || null : null,
    },
  };
};

export const getLocalServerStats = async (id: string): Promise<{ cpu: number; ram: number; disk: number }> => {
  const child = processes.get(id);
  if (!child?.pid) return { cpu: 0, ram: 0, disk: 0 };
  try {
    const { stdout } = await execAsync(`ps -p ${child.pid} -o %cpu,rss`);
    const lines = stdout.trim().split("\n");
    if (lines.length > 1) {
      const [cpuStr, rssStr] = lines[1].trim().split(/\s+/);
      return { cpu: parseFloat(cpuStr) || 0, ram: (parseInt(rssStr) || 0) / 1024, disk: 2.1 };
    }
  } catch { /* process may have just exited between .has() and ps */ }
  return { cpu: 0, ram: 0, disk: 0 };
};

export const getLocalServerLogs = async (id: string): Promise<string> => {
  const logPath = path.join(process.cwd(), ".data", "servers", id, "panel.log");
  if (await fs.pathExists(logPath)) {
    const logs = await fs.readFile(logPath, "utf8");
    return logs.split("\n").slice(-100).join("\n");
  }
  return "";
};

export const sendLocalServerCommand = async (id: string, command: string) => {
  const child = processes.get(id);
  if (!child?.stdin) return;
  child.stdin.write(command + "\n");
  const logPath = path.join(process.cwd(), ".data", "servers", id, "panel.log");
  const formatted = `> ${command}\r\n`;
  await fs.appendFile(logPath, formatted).catch(() => {});
  emitLog(id, formatted);
};

export const isLocalServerRunning = (id: string): boolean => processes.has(id);
