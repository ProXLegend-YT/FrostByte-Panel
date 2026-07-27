/**
 * Game Definitions Registry
 * ==========================
 * The central place that knows how to turn a "create server" request into
 * an actual runnable container, for every supported game/application type.
 * This is FrostByte's equivalent of Pterodactyl's "eggs" — each entry fully
 * describes one deployable thing: what image it runs in, what environment
 * variables it needs, what port it listens on, and how to fetch its
 * available versions.
 *
 * Adding a new game means adding one entry here (plus a category/icon hint
 * on the frontend) — nothing else in the container-creation path needs to
 * change, since createServerContainer() in docker.ts is generic over this
 * registry rather than hardcoding any single game.
 */

export interface EnvBuilderContext {
  serverData: any; // the stored server record (name, ram, cpu, port, version, type, ...)
  rconPassword?: string;
}

export interface GameDefinition {
  id: string;              // stable identifier stored on the server record as `game`
  name: string;             // display name
  category: "minecraft" | "source" | "survival" | "discord-bot" | "other";
  description: string;
  dockerImage: string;
  /** Path inside the container where persistent data should be mounted. */
  containerDataPath: string;
  /** "tcp" | "udp" — most game servers are tcp, some (e.g. some Source games) need udp too. */
  portProtocol: "tcp" | "udp" | "both";
  /** Whether this type has sub-variants (e.g. Minecraft: Paper/Forge/Fabric/Vanilla/proxies). */
  subtypes?: { id: string; name: string; description: string; isProxy?: boolean }[];
  /** Builds the container's environment variables for a given server record. */
  buildEnv: (ctx: EnvBuilderContext) => string[];
  /** Returns available versions for this game (and optional subtype). Static list or fetched. */
  getVersions: (subtype?: string) => Promise<string[]> | string[];
  /** Default resource suggestions shown in the UI, in GB / % of one core. */
  defaultRam: number;
  defaultCpu: number;
  defaultDisk: number;
  /** Whether RCON-style remote console is meaningful for this game (Minecraft-specific concept). */
  supportsRcon: boolean;
  /**
   * Returns the container's startup command (Docker `Cmd`), if this game
   * type needs one explicitly. Minecraft's image has its own built-in
   * entrypoint driven entirely by env vars, so it returns undefined —
   * Discord bots (running in a generic node/python base image) need an
   * explicit command to actually install dependencies and run the user's
   * uploaded code.
   */
  getStartupCommand?: (ctx: EnvBuilderContext) => string[] | undefined;
}

const MINECRAFT_VERSIONS = [
  "latest", "1.21.11", "1.21.10", "1.21.9", "1.21.8", "1.21.7", "1.21.6", "1.21.5", "1.21.4", "1.21.3", "1.21.1", "1.21",
  "1.20.6", "1.20.5", "1.20.4", "1.20.2", "1.20.1", "1.20",
  "1.19.4", "1.19.3", "1.19.2", "1.19.1", "1.19",
  "1.18.2", "1.18.1", "1.18", "1.17.1", "1.17", "1.16.5", "1.16.4", "1.16.3", "1.16.2", "1.16.1", "1.15.2", "1.15.1", "1.15",
  "1.14.4", "1.14.3", "1.14.2", "1.14.1", "1.14", "1.13.2", "1.13.1", "1.13", "1.12.2", "1.12.1", "1.12", "1.11.2", "1.10.2",
  "1.9.4", "1.8.8", "1.7.10",
];

const minecraftEnv = ({ serverData, rconPassword }: EnvBuilderContext): string[] => {
  const subtype = (serverData.type || "PAPER").toUpperCase();
  const isProxy = ["VELOCITY", "BUNGEECORD", "WATERFALL"].includes(subtype);

  const env = [
    `TYPE=${subtype}`,
    `VERSION=${serverData.version}`,
    `MEMORY=${serverData.ram}G`,
    `INIT_MEMORY=128M`,
    `SERVER_PORT=${serverData.port}`,
  ];

  if (!isProxy) {
    env.push(
      `EULA=TRUE`,
      `ENABLE_RCON=true`,
      `RCON_PASSWORD=${rconPassword}`,
      `JVM_OPTS=-DPaper.IgnoreWorldDataVersion=true`,
      `JVM_DD_OPTS=Paper.IgnoreWorldDataVersion=true,paper.ignoreWorldDataVersion=true`
    );
  }

  return env;
};

export const GAME_DEFINITIONS: Record<string, GameDefinition> = {
  minecraft: {
    id: "minecraft",
    name: "Minecraft",
    category: "minecraft",
    description: "Java Edition servers and proxies — Paper, Forge, Fabric, Vanilla, Velocity, BungeeCord.",
    dockerImage: "itzg/minecraft-server",
    containerDataPath: "/data",
    portProtocol: "tcp",
    subtypes: [
      { id: "PAPER", name: "Paper", description: "Performance-focused vanilla" },
      { id: "FORGE", name: "Forge", description: "Modded Minecraft" },
      { id: "FABRIC", name: "Fabric", description: "Lightweight mod loader" },
      { id: "VANILLA", name: "Vanilla", description: "Unmodified official server" },
      { id: "VELOCITY", name: "Velocity", description: "Next-gen proxy", isProxy: true },
      { id: "BUNGEECORD", name: "BungeeCord", description: "Classic proxy", isProxy: true },
    ],
    buildEnv: (ctx) => {
      const subtype = (ctx.serverData.type || "PAPER").toUpperCase();
      const isProxy = ["VELOCITY", "BUNGEECORD", "WATERFALL"].includes(subtype);
      // Proxies actually run a different image (itzg/bungeecord covers both
      // Velocity and BungeeCord) — handled via getDockerImage() below, since
      // buildEnv doesn't control the image, only env vars.
      return minecraftEnv(ctx);
    },
    getVersions: (subtype) => {
      const t = (subtype || "PAPER").toUpperCase();
      if (t === "VELOCITY") return ["latest", "3.3.0-SNAPSHOT"];
      if (t === "BUNGEECORD" || t === "WATERFALL") return ["latest"];
      return MINECRAFT_VERSIONS;
    },
    defaultRam: 4,
    defaultCpu: 150,
    defaultDisk: 10,
    supportsRcon: true,
  },

  "discord-bot": {
    id: "discord-bot",
    name: "Discord Bot",
    category: "discord-bot",
    description: "Run a Node.js or Python Discord bot from your own uploaded code.",
    dockerImage: "node:20-slim",
    containerDataPath: "/app",
    portProtocol: "tcp",
    subtypes: [
      { id: "NODE", name: "Node.js", description: "npm install && node index.js" },
      { id: "PYTHON", name: "Python", description: "pip install -r requirements.txt && python bot.py" },
    ],
    buildEnv: ({ serverData }) => {
      const env: string[] = [];
      if (serverData.discordToken) env.push(`DISCORD_TOKEN=${serverData.discordToken}`);
      if (serverData.startCommand) env.push(`START_COMMAND=${serverData.startCommand}`);
      return env;
    },
    getVersions: () => ["latest"],
    defaultRam: 1,
    defaultCpu: 50,
    defaultDisk: 2,
    supportsRcon: false,
    getStartupCommand: ({ serverData }) => {
      // Runs inside the container, cwd = containerDataPath (/app), which is
      // the bind-mounted server directory. The user uploads their bot's
      // code there via the file manager before starting the server.
      // "tail -f /dev/null" as a fallback keeps the container alive (so the
      // console/file-manager stay usable) instead of exiting immediately
      // if no start command has been configured yet.
      const cmd = serverData.startCommand?.trim();
      if (!cmd) {
        return ["sh", "-c", "echo 'No start command configured yet. Set one in server settings, upload your bot code, then restart.' && tail -f /dev/null"];
      }
      return ["sh", "-c", cmd];
    },
  },

  rust: {
    id: "rust",
    name: "Rust",
    category: "survival",
    description: "Rust dedicated server via SteamCMD, auto-updating.",
    dockerImage: "didstopia/rust-server",
    containerDataPath: "/steamcmd/rust",
    portProtocol: "both",
    buildEnv: ({ serverData }) => [
      `RUST_SERVER_NAME=${serverData.name}`,
      `RUST_SERVER_PORT=${serverData.port}`,
      `RUST_SERVER_QUERYPORT=${Number(serverData.port) + 1}`,
      `RUST_RCON_PORT=${Number(serverData.port) + 2}`,
      `RUST_RCON_PASSWORD=${crypto.randomBytes(8).toString("hex")}`,
      `RUST_RCON_WEB=1`,
    ],
    getVersions: () => ["latest"],
    defaultRam: 8,
    defaultCpu: 300,
    defaultDisk: 20,
    supportsRcon: true,
  },

  valheim: {
    id: "valheim",
    name: "Valheim",
    category: "survival",
    description: "Valheim dedicated server via SteamCMD.",
    dockerImage: "ghcr.io/lloesche/valheim-server",
    containerDataPath: "/config",
    portProtocol: "udp",
    // Valheim's server refuses to start if SERVER_PASS is under 5 characters
    // — the fallback here is intentionally longer than that minimum.
    buildEnv: ({ serverData }) => [
      `SERVER_NAME=${serverData.name}`,
      `SERVER_PORT=${serverData.port}`,
      `WORLD_NAME=${serverData.name.replace(/[^a-zA-Z0-9]/g, "")}`,
      `SERVER_PASS=${serverData.serverPassword || "changeme123"}`,
      `SERVER_PUBLIC=false`,
    ],
    getVersions: () => ["latest"],
    defaultRam: 4,
    defaultCpu: 200,
    defaultDisk: 10,
    supportsRcon: false,
  },

  terraria: {
    id: "terraria",
    name: "Terraria",
    category: "survival",
    description: "TShock-powered Terraria dedicated server.",
    dockerImage: "ryshe/terraria",
    containerDataPath: "/root/.local/share/Terraria/Worlds",
    portProtocol: "tcp",
    // This image has no PORT/MAX_PLAYERS env vars — the listen port is
    // purely controlled by Docker's own port mapping (handled separately
    // in createServerContainer), and the world file name is the one
    // meaningful env var it actually reads.
    buildEnv: ({ serverData }) => [
      `WORLD_FILENAME=${serverData.name.replace(/[^a-zA-Z0-9]/g, "")}.wld`,
    ],
    getVersions: () => ["latest"],
    defaultRam: 2,
    defaultCpu: 100,
    defaultDisk: 5,
    supportsRcon: false,
  },

  ark: {
    id: "ark",
    name: "ARK: Survival Evolved",
    category: "survival",
    description: "ARK: Survival Evolved dedicated server via ARK-Server-Tools. Note: ARK needs several fixed ports beyond the one configured here (7778/udp, 27015/udp, 27020/tcp) — open those on your firewall too.",
    dockerImage: "hermsi/ark-server",
    containerDataPath: "/app",
    portProtocol: "udp",
    buildEnv: ({ serverData }) => [
      `SESSION_NAME=${serverData.name}`,
      `SERVER_MAP=TheIsland`,
      `SERVER_PASSWORD=${serverData.serverPassword || ""}`,
      `ADMIN_PASSWORD=${crypto.randomBytes(6).toString("hex")}`,
      `MAX_PLAYERS=20`,
      `UPDATE_ON_START=true`,
    ],
    getVersions: () => ["latest"],
    defaultRam: 10,
    defaultCpu: 400,
    defaultDisk: 30,
    supportsRcon: true,
  },

  palworld: {
    id: "palworld",
    name: "Palworld",
    category: "survival",
    description: "Palworld dedicated server via SteamCMD. Also requires UDP port 27015 open for the server browser query port.",
    dockerImage: "thijsvanloef/palworld-server-docker",
    containerDataPath: "/palworld",
    portProtocol: "udp",
    buildEnv: ({ serverData }) => [
      `PORT=${serverData.port}`,
      `PLAYERS=16`,
      `SERVER_NAME=${serverData.name}`,
      `SERVER_PASSWORD=${serverData.serverPassword || ""}`,
      `ADMIN_PASSWORD=${crypto.randomBytes(6).toString("hex")}`,
      `MULTITHREADING=true`,
      `RCON_ENABLED=true`,
    ],
    getVersions: () => ["latest"],
    defaultRam: 8,
    defaultCpu: 300,
    defaultDisk: 15,
    supportsRcon: true,
  },

  cs2: {
    id: "cs2",
    name: "Counter-Strike 2",
    category: "source",
    description: "CS2 dedicated server via SteamCMD. Requires ~60GB disk space.",
    dockerImage: "joedwards32/cs2",
    containerDataPath: "/home/steam/cs2-dedicated",
    portProtocol: "both",
    buildEnv: ({ serverData }) => [
      `CS2_PORT=${serverData.port}`,
      `SRCDS_TOKEN=${serverData.srcdsToken || ""}`,
      `CS2_RCONPW=${crypto.randomBytes(8).toString("hex")}`,
      `CS2_SERVERNAME=${serverData.name}`,
    ],
    getVersions: () => ["latest"],
    defaultRam: 4,
    defaultCpu: 200,
    defaultDisk: 65, // image documents a 60GB minimum; a small margin avoids an install that fills the disk exactly to the limit
    supportsRcon: true,
  },
};

/**
 * Resolves the actual Docker image to use for a server, accounting for
 * cases (like Minecraft proxies) where the subtype changes the image, not
 * just the env vars.
 */
export function getDockerImageFor(gameId: string, subtype?: string): string {
  const def = GAME_DEFINITIONS[gameId];
  if (!def) throw new Error(`Unknown game type: ${gameId}`);

  if (gameId === "minecraft") {
    const isProxy = ["VELOCITY", "BUNGEECORD", "WATERFALL"].includes((subtype || "").toUpperCase());
    return isProxy ? "itzg/bungeecord" : "itzg/minecraft-server";
  }

  if (gameId === "discord-bot") {
    return subtype === "PYTHON" ? "python:3.12-slim" : "node:20-slim";
  }

  return def.dockerImage;
}

export function getGameDefinition(gameId: string): GameDefinition {
  const def = GAME_DEFINITIONS[gameId];
  if (!def) throw new Error(`Unknown game type: ${gameId}`);
  return def;
}

export function listGameDefinitions(): GameDefinition[] {
  return Object.values(GAME_DEFINITIONS);
}
