import fs from "fs-extra";
import path from "path";
import { readJSON, updateJSON } from "./db.js";
import { getContainerStats, isSandbox } from "./docker.js";

// Resource history — periodic CPU/RAM/disk samples per server, kept on
// disk so graphs survive a page reload instead of only showing whatever
// accumulated in the browser tab's memory since it was opened (which is
// all Sparkline.tsx could do before this).
//
// Storage design: one small JSON file per server under
// .data/stats-history/<serverId>.json, rather than one giant file for
// every server. A single shared file would get rewritten in full on every
// sample tick regardless of how many servers exist, and would keep
// growing without bound as servers are added — a per-server file means
// each write only touches the data that actually changed, and deleting a
// server can simply delete its file.
//
// Retention: this keeps three tiers of resolution so the graph stays
// useful at every zoom level without the file growing forever —
//   - raw:   1 sample/minute, kept 6 hours  (360 points)
//   - hourly: 1 sample/hour,  kept 7 days   (168 points)
//   - daily:  1 sample/day,   kept 30 days  (30 points)
// Older raw samples are rolled up into the hourly tier (averaged) instead
// of just being dropped, so a "last 7 days" view still shows a real trend
// rather than a gap.

interface StatSample {
  t: number; // unix ms
  cpu: number; // percent, 0-100+ (can exceed 100 with multiple cores)
  ram: number; // MB
  disk: number; // GB
}

interface ServerStatHistory {
  raw: StatSample[];
  hourly: StatSample[];
  daily: StatSample[];
}

const HISTORY_DIR = path.join(process.cwd(), ".data", "stats-history");
const RAW_MAX = 360; // 6h at 1/min
const HOURLY_MAX = 168; // 7d at 1/hr
const DAILY_MAX = 30; // 30d at 1/day
const SAMPLE_INTERVAL_MS = 60_000; // 1 minute

function historyPath(serverId: string): string {
  return path.join(HISTORY_DIR, `${serverId}.json`);
}

async function readHistory(serverId: string): Promise<ServerStatHistory> {
  try {
    const data = await fs.readJson(historyPath(serverId));
    return { raw: data.raw || [], hourly: data.hourly || [], daily: data.daily || [] };
  } catch {
    return { raw: [], hourly: [], daily: [] };
  }
}

async function writeHistory(serverId: string, history: ServerStatHistory): Promise<void> {
  await fs.ensureDir(HISTORY_DIR);
  await fs.writeJson(historyPath(serverId), history);
}

function average(samples: StatSample[]): StatSample {
  const n = samples.length;
  return {
    t: samples[n - 1].t,
    cpu: samples.reduce((s, x) => s + x.cpu, 0) / n,
    ram: samples.reduce((s, x) => s + x.ram, 0) / n,
    disk: samples.reduce((s, x) => s + x.disk, 0) / n,
  };
}

/**
 * Records one sample for a server and rolls up older raw samples into the
 * hourly/daily tiers as needed. Called once per SAMPLE_INTERVAL_MS tick,
 * per running server — see startStatsSampler below.
 */
async function recordSample(serverId: string, sample: StatSample): Promise<void> {
  const history = await readHistory(serverId);
  history.raw.push(sample);

  // Roll the oldest raw samples into a hierarchy once we're over budget,
  // rather than just truncating — this is what keeps a "last 7 days" view
  // meaningful instead of only covering the most recent 6 hours.
  if (history.raw.length > RAW_MAX) {
    const overflow = history.raw.splice(0, history.raw.length - RAW_MAX);
    if (overflow.length > 0) {
      history.hourly.push(average(overflow));
      if (history.hourly.length > HOURLY_MAX) {
        const hourlyOverflow = history.hourly.splice(0, history.hourly.length - HOURLY_MAX);
        if (hourlyOverflow.length > 0) {
          history.daily.push(average(hourlyOverflow));
          if (history.daily.length > DAILY_MAX) {
            history.daily.splice(0, history.daily.length - DAILY_MAX);
          }
        }
      }
    }
  }

  await writeHistory(serverId, history);
}

/**
 * Returns history for a server at the requested resolution, capped to a
 * sensible max points so the frontend never has to render more than it
 * needs to.
 */
export async function getStatHistory(serverId: string, range: "1h" | "6h" | "24h" | "7d" | "30d"): Promise<StatSample[]> {
  const history = await readHistory(serverId);
  const now = Date.now();

  switch (range) {
    case "1h":
      return history.raw.filter((s) => s.t >= now - 60 * 60 * 1000);
    case "6h":
      return history.raw;
    case "24h": {
      // Raw covers the last 6h; fill the rest from hourly.
      const cutoff = now - 24 * 60 * 60 * 1000;
      return [...history.hourly.filter((s) => s.t >= cutoff), ...history.raw];
    }
    case "7d":
      return history.hourly;
    case "30d":
      return history.daily;
    default:
      return history.raw;
  }
}

export async function deleteStatHistory(serverId: string): Promise<void> {
  await fs.remove(historyPath(serverId)).catch(() => {});
}

let samplerHandle: NodeJS.Timeout | null = null;

/**
 * Starts the background sampling loop. Only samples servers that are
 * actually running (checked per-tick via each server's stored status) —
 * sampling an offline server would just record zeros forever and bloat
 * its history file for no benefit.
 */
export function startStatsSampler(): void {
  if (samplerHandle || isSandbox) return; // no real containers to sample in sandbox mode

  const tick = async () => {
    try {
      const servers = (await readJSON("servers.json")) || [];
      const running = servers.filter((s: any) => s.containerId && s.status !== "offline");

      // Sequential, not parallel — this is a background job with no user
      // waiting on it, and firing N simultaneous `docker stats` calls
      // every minute against the daemon isn't worth the time saved.
      for (const server of running) {
        try {
          const stats = await getContainerStats(server.containerId);
          if (!stats) continue;
          await recordSample(server.id, {
            t: Date.now(),
            cpu: stats.cpu || 0,
            ram: stats.ram || 0,
            disk: stats.disk || 0,
          });
        } catch {
          // One server's stats failing (container mid-restart, etc.)
          // shouldn't stop the rest of the batch from being sampled.
        }
      }
    } catch (err) {
      console.error("Stats sampler tick failed:", err);
    }
  };

  samplerHandle = setInterval(tick, SAMPLE_INTERVAL_MS);
  tick(); // sample immediately on boot rather than waiting a full interval
}

export function stopStatsSampler(): void {
  if (samplerHandle) {
    clearInterval(samplerHandle);
    samplerHandle = null;
  }
}
