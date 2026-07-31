import fs from "fs-extra";
import path from "path";
import { readJSON, writeJSON, updateJSON } from "./db.js";
import { restartContainer, stopContainer, startContainer, sendContainerCommand, getContainerStatus } from "./docker.js";
import { logActivity } from "./activityLog.js";

export type ScheduledTaskAction = "restart" | "backup" | "command" | "stop" | "start";

export interface ScheduledTask {
  id: string;
  serverId: string;
  name: string;
  action: ScheduledTaskAction;
  // For action "command", the console command to send.
  commandText?: string;
  // Simple recurrence spec — deliberately not a full cron parser, since the
  // vast majority of real use cases ("every N hours", "daily at HH:MM",
  // "weekly on day X at HH:MM") are covered by this and a hand-rolled cron
  // parser is a lot of surface area for edge cases nobody will hit here.
  recurrence: {
    frequency: "interval" | "daily" | "weekly";
    intervalMinutes?: number; // for "interval"
    hour?: number; // for "daily"/"weekly", 0-23, in the server's local time
    minute?: number; // for "daily"/"weekly", 0-59
    dayOfWeek?: number; // for "weekly", 0 (Sunday) - 6 (Saturday)
  };
  enabled: boolean;
  lastRunAt?: string;
  lastRunStatus?: "success" | "error";
  lastRunMessage?: string;
  nextRunAt: string;
  createdBy: string;
  createdAt: string;
}

const TASKS_FILE = "scheduledTasks.json";
const TICK_INTERVAL_MS = 30_000; // check every 30s — fine-grained enough for
                                   // minute-level schedules without hammering
                                   // the disk with reads.

function computeNextRun(recurrence: ScheduledTask["recurrence"], from: Date = new Date()): Date {
  const next = new Date(from);

  if (recurrence.frequency === "interval") {
    const minutes = Math.max(1, recurrence.intervalMinutes || 60);
    next.setTime(from.getTime() + minutes * 60_000);
    return next;
  }

  // daily / weekly: find the next occurrence of hour:minute (optionally on
  // a specific weekday) strictly after `from`.
  const hour = recurrence.hour ?? 3;
  const minute = recurrence.minute ?? 0;
  next.setHours(hour, minute, 0, 0);

  if (recurrence.frequency === "weekly") {
    const targetDay = recurrence.dayOfWeek ?? 0;
    let daysUntilTarget = (targetDay - next.getDay() + 7) % 7;
    if (daysUntilTarget === 0 && next <= from) daysUntilTarget = 7;
    next.setDate(next.getDate() + daysUntilTarget);
    return next;
  }

  // daily
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}

export async function getTasks(serverId?: string): Promise<ScheduledTask[]> {
  const tasks: ScheduledTask[] = (await readJSON(TASKS_FILE)) || [];
  return serverId ? tasks.filter((t) => t.serverId === serverId) : tasks;
}

export async function createTask(input: {
  serverId: string;
  name: string;
  action: ScheduledTaskAction;
  commandText?: string;
  recurrence: ScheduledTask["recurrence"];
  createdBy: string;
}): Promise<ScheduledTask> {
  const task: ScheduledTask = {
    id: (await import("crypto")).randomUUID(),
    serverId: input.serverId,
    name: input.name,
    action: input.action,
    commandText: input.commandText,
    recurrence: input.recurrence,
    enabled: true,
    nextRunAt: computeNextRun(input.recurrence).toISOString(),
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  await updateJSON<ScheduledTask[]>(TASKS_FILE, (current) => [...(current || []), task]);
  return task;
}

export async function updateTask(id: string, patch: Partial<Pick<ScheduledTask, "name" | "enabled" | "recurrence" | "commandText">>): Promise<ScheduledTask | null> {
  let updated: ScheduledTask | null = null;
  await updateJSON<ScheduledTask[]>(TASKS_FILE, (current) => {
    const tasks = current || [];
    return tasks.map((t) => {
      if (t.id !== id) return t;
      updated = {
        ...t,
        ...patch,
        // Recompute the schedule if recurrence changed, so an edit takes
        // effect immediately rather than waiting for the old cadence.
        nextRunAt: patch.recurrence ? computeNextRun(patch.recurrence).toISOString() : t.nextRunAt,
      };
      return updated;
    });
  });
  return updated;
}

export async function deleteTask(id: string): Promise<boolean> {
  let existed = false;
  await updateJSON<ScheduledTask[]>(TASKS_FILE, (current) => {
    const tasks = current || [];
    existed = tasks.some((t) => t.id === id);
    return tasks.filter((t) => t.id !== id);
  });
  return existed;
}

// Runs a task's action against a server. Kept independent of any HTTP
// request/response so it can be called equally from the ticking scheduler
// or (later, if wanted) an admin "run now" button.
async function executeTask(task: ScheduledTask): Promise<{ status: "success" | "error"; message: string }> {
  const servers = (await readJSON("servers.json")) || [];
  const server = servers.find((s: any) => s.id === task.serverId);
  if (!server) {
    return { status: "error", message: "Server no longer exists." };
  }

  try {
    switch (task.action) {
      case "restart": {
        if (!server.containerId) return { status: "error", message: "Server has no container." };
        await restartContainer(server.containerId);
        return { status: "success", message: "Server restarted." };
      }
      case "stop": {
        if (!server.containerId) return { status: "error", message: "Server has no container." };
        await stopContainer(server.containerId);
        return { status: "success", message: "Server stopped." };
      }
      case "start": {
        if (!server.containerId) return { status: "error", message: "Server has no container." };
        await startContainer(server.containerId);
        return { status: "success", message: "Server started." };
      }
      case "command": {
        if (!server.containerId) return { status: "error", message: "Server has no container." };
        if (!task.commandText) return { status: "error", message: "No command configured." };
        const status = await getContainerStatus(server.containerId);
        if (!status?.State?.Running) return { status: "error", message: "Server is offline — command skipped." };
        await sendContainerCommand(server.containerId, task.commandText);
        return { status: "success", message: `Sent: ${task.commandText}` };
      }
      case "backup": {
        const filename = await performScheduledBackup(task.serverId);
        return { status: "success", message: `Created ${filename}.` };
      }
      default:
        return { status: "error", message: `Unknown action: ${task.action}` };
    }
  } catch (err: any) {
    return { status: "error", message: err.message || "Task failed." };
  }
}

// Standalone backup routine, mirroring createBackup's core logic but
// without any Express req/res — this is what lets the scheduler (and
// potentially other future callers) trigger a backup without an HTTP
// request in flight.
async function performScheduledBackup(serverId: string): Promise<string> {
  const serverDir = path.join(process.cwd(), ".data", "servers", serverId);
  const backupsDir = path.join(process.cwd(), ".data", "backups", serverId);
  await fs.ensureDir(backupsDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `scheduled-backup-${timestamp}.zip`;
  const backupPath = path.join(backupsDir, filename);

  const serverExists = await fs.pathExists(serverDir);
  if (!serverExists) await fs.ensureDir(serverDir);

  const archiver = (await import("archiver")).default;
  const output = fs.createWriteStream(backupPath);
  const archive = archiver("zip", { zlib: { level: 9 } });

  await new Promise<void>((resolve, reject) => {
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(serverDir, false);
    archive.finalize();
  });

  return filename;
}

let tickHandle: NodeJS.Timeout | null = null;

async function tick() {
  try {
    const tasks = await getTasks();
    const now = new Date();
    const due = tasks.filter((t) => t.enabled && new Date(t.nextRunAt) <= now);

    for (const task of due) {
      const result = await executeTask(task);

      await updateJSON<ScheduledTask[]>(TASKS_FILE, (current) => {
        const list = current || [];
        return list.map((t) =>
          t.id === task.id
            ? {
                ...t,
                lastRunAt: new Date().toISOString(),
                lastRunStatus: result.status,
                lastRunMessage: result.message,
                nextRunAt: computeNextRun(t.recurrence, new Date()).toISOString(),
              }
            : t
        );
      });

      const scheduledActionMap: Record<ScheduledTaskAction, `scheduledTask.${ScheduledTaskAction}`> = {
        restart: "scheduledTask.restart",
        backup: "scheduledTask.backup",
        command: "scheduledTask.command",
        stop: "scheduledTask.stop",
        start: "scheduledTask.start",
      };

      logActivity({
        actorId: "system",
        actorUsername: "Scheduler",
        action: scheduledActionMap[task.action],
        target: task.name,
        serverId: task.serverId,
      });

      try {
        const { notifyUser } = await import("./notifications.js");
        await notifyUser(task.createdBy, {
          type: result.status === "success" ? "success" : "error",
          title: result.status === "success" ? "Scheduled task ran" : "Scheduled task failed",
          message: `${task.name}: ${result.message}`,
          serverId: task.serverId,
          link: `/servers/${task.serverId}/schedule`,
        });
      } catch { /* notification is best-effort */ }
    }
  } catch (err) {
    console.error("Scheduler tick failed:", err);
  }
}

// Starts the background tick loop. Safe to call once at server boot — a
// second call is a no-op so accidental double-init (e.g. during dev hot
// reload) doesn't spin up duplicate timers that would double-execute tasks.
export function startScheduler() {
  if (tickHandle) return;
  tickHandle = setInterval(tick, TICK_INTERVAL_MS);
  // Also run one tick shortly after boot, in case something was due while
  // the panel was offline (e.g. a nightly backup during a restart window).
  setTimeout(tick, 5_000);
}

export function stopScheduler() {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}
