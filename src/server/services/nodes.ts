import crypto from "crypto";
import { readJSON, writeJSON, updateJSON } from "./db.js";

export interface FrostByteNode {
  id: string;
  name: string;
  secretHash: string;
  createdAt: string;
  createdBy: string;
  // Populated once the agent actually connects — a freshly-registered
  // node has none of these until its first successful handshake.
  status: "online" | "offline";
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
  telemetry: {
    cpuPercent: number;
    ramUsedMb: number;
    ramTotalMb: number;
    diskUsedGb: number;
    diskTotalGb: number;
  } | null;
}

const NODES_FILE = "nodes.json";

export const listNodes = async (): Promise<FrostByteNode[]> => {
  return (await readJSON(NODES_FILE)) || [];
};

export const createNode = async (name: string, createdBy: string): Promise<{ node: FrostByteNode; rawSecret: string }> => {
  const rawSecret = crypto.randomBytes(32).toString("hex");
  const secretHash = crypto.createHash("sha256").update(rawSecret).digest("hex");
  const node: FrostByteNode = {
    id: crypto.randomUUID(),
    name,
    secretHash,
    createdAt: new Date().toISOString(),
    createdBy,
    status: "offline",
    lastHeartbeatAt: null,
    agentVersion: null,
    telemetry: null,
  };
  await updateJSON<FrostByteNode[]>(NODES_FILE, (current) => [...(current || []), node]);
  // The raw secret is only ever available at creation time — it's never
  // stored or retrievable again, same convention as the API key system.
  return { node, rawSecret };
};

export const deleteNode = async (id: string): Promise<boolean> => {
  let found = false;
  await updateJSON<FrostByteNode[]>(NODES_FILE, (current) => {
    const list = current || [];
    const next = list.filter((n) => {
      if (n.id === id) { found = true; return false; }
      return true;
    });
    return next;
  });
  return found;
};

// Verifies a raw secret against a node's stored hash. Used by the agent
// socket namespace's auth middleware on every connection attempt.
export const verifyNodeSecret = async (nodeId: string, rawSecret: string): Promise<FrostByteNode | null> => {
  const nodes = await listNodes();
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const hash = crypto.createHash("sha256").update(rawSecret).digest("hex");
  // Constant-time comparison — avoids leaking hash-match progress via
  // response timing, same reasoning as password comparisons elsewhere.
  const a = Buffer.from(hash);
  const b = Buffer.from(node.secretHash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return node;
};

export const recordHeartbeat = async (nodeId: string, telemetry: FrostByteNode["telemetry"], agentVersion: string) => {
  await updateJSON<FrostByteNode[]>(NODES_FILE, (current) => {
    const list = current || [];
    const node = list.find((n) => n.id === nodeId);
    if (node) {
      node.status = "online";
      node.lastHeartbeatAt = new Date().toISOString();
      node.telemetry = telemetry;
      node.agentVersion = agentVersion;
    }
    return list;
  });
};

export const markNodeOffline = async (nodeId: string) => {
  await updateJSON<FrostByteNode[]>(NODES_FILE, (current) => {
    const list = current || [];
    const node = list.find((n) => n.id === nodeId);
    if (node) node.status = "offline";
    return list;
  });
};

// Nodes that haven't sent a heartbeat within this window are considered
// offline even if their socket technically never fired a disconnect event
// (network partition, agent process killed ungracefully, etc.) — a pure
// disconnect-event-based check alone isn't reliable for that case.
const HEARTBEAT_TIMEOUT_MS = 45_000;

export const sweepStaleNodes = async () => {
  const now = Date.now();
  await updateJSON<FrostByteNode[]>(NODES_FILE, (current) => {
    const list = current || [];
    for (const node of list) {
      if (node.status === "online" && node.lastHeartbeatAt) {
        const age = now - new Date(node.lastHeartbeatAt).getTime();
        if (age > HEARTBEAT_TIMEOUT_MS) node.status = "offline";
      }
    }
    return list;
  });
};
