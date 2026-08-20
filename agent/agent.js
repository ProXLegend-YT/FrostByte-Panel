// FrostByte Agent
//
// Runs on a remote VPS/node. Connects OUT to the panel over Socket.IO
// (the panel never connects in to the node) and authenticates with a
// per-node secret generated when the node was registered in the panel's
// admin UI. This avoids requiring any inbound port to be opened on the
// node — the node only ever makes outbound connections, same trust
// direction as the panel's existing Cloudflare Tunnel / Playit tunnel
// integrations.
//
// Scope of this version: registration, secure handshake, and live
// telemetry (CPU/RAM/disk) only. It does NOT yet run or manage servers
// on this node — that's a deliberate, separate follow-up once node
// connectivity itself is confirmed reliable. See serverOperations.ts and
// the Phase 2 discussion in chat for why.
//
// Usage:
//   PANEL_URL=https://panel.example.com NODE_ID=<id> NODE_SECRET=<secret> node agent/agent.js
//
// Or via the generated one-line install command shown in the panel's
// Nodes admin page after creating a node.

const { io } = require("socket.io-client");
const os = require("os");
const { exec } = require("child_process");

const AGENT_VERSION = "0.1.0";
const HEARTBEAT_INTERVAL_MS = 15_000;

const PANEL_URL = process.env.PANEL_URL;
const NODE_ID = process.env.NODE_ID;
const NODE_SECRET = process.env.NODE_SECRET;

if (!PANEL_URL || !NODE_ID || !NODE_SECRET) {
  console.error(
    "FrostByte Agent: missing required environment variables.\n" +
    "Required: PANEL_URL, NODE_ID, NODE_SECRET\n" +
    "Example: PANEL_URL=https://panel.example.com NODE_ID=abc123 NODE_SECRET=xyz789 node agent.js"
  );
  process.exit(1);
}

// Same normalization logic as the panel's own /api/system/stats endpoint
// (src/server/routes/system.ts) — kept in sync intentionally so a node's
// self-reported numbers mean the same thing as the panel's own host
// stats, rather than two different formulas producing different-looking
// percentages for what's conceptually the same metric.
function getCpuPercent() {
  const cores = os.cpus().length || 1;
  const loadAvg1min = os.loadavg()[0];
  return Math.min(100, Math.round((loadAvg1min / cores) * 100));
}

function getDiskUsage() {
  return new Promise((resolve) => {
    exec(`df -k "${process.cwd()}"`, { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve({ usedGb: 0, totalGb: 0 });
      try {
        const dataLine = stdout.trim().split("\n")[1];
        const parts = dataLine?.trim().split(/\s+/);
        if (parts && parts.length >= 4) {
          const totalKb = parseInt(parts[1], 10);
          const usedKb = parseInt(parts[2], 10);
          resolve({
            usedGb: Math.round((usedKb / 1024 / 1024) * 10) / 10,
            totalGb: Math.round((totalKb / 1024 / 1024) * 10) / 10,
          });
        } else {
          resolve({ usedGb: 0, totalGb: 0 });
        }
      } catch {
        resolve({ usedGb: 0, totalGb: 0 });
      }
    });
  });
}

async function collectTelemetry() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const disk = await getDiskUsage();
  return {
    cpuPercent: getCpuPercent(),
    ramUsedMb: Math.round((totalMem - freeMem) / 1024 / 1024),
    ramTotalMb: Math.round(totalMem / 1024 / 1024),
    diskUsedGb: disk.usedGb,
    diskTotalGb: disk.totalGb,
  };
}

console.log(`FrostByte Agent v${AGENT_VERSION} starting...`);
console.log(`Connecting to ${PANEL_URL} as node ${NODE_ID}`);

const socket = io(`${PANEL_URL}/agent`, {
  auth: { nodeId: NODE_ID, secret: NODE_SECRET },
  reconnection: true,
  reconnectionDelay: 2000,
  reconnectionDelayMax: 15000,
});

let heartbeatTimer = null;

socket.on("connect", () => {
  console.log("Connected to panel. Starting heartbeat...");
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
});

async function sendHeartbeat() {
  try {
    const telemetry = await collectTelemetry();
    socket.emit("heartbeat", { telemetry, agentVersion: AGENT_VERSION });
  } catch (err) {
    console.error("Failed to collect/send telemetry:", err.message);
  }
}

socket.on("disconnect", (reason) => {
  console.log(`Disconnected from panel: ${reason}. Will attempt to reconnect...`);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
});

socket.on("connect_error", (err) => {
  console.error(`Connection error: ${err.message}`);
});

process.on("SIGINT", () => {
  console.log("\nShutting down agent...");
  socket.disconnect();
  process.exit(0);
});
process.on("SIGTERM", () => {
  socket.disconnect();
  process.exit(0);
});
