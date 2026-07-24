import { randomUUID } from "crypto";
import { updateJSON, readJSON } from "./db.js";

const ACTIVITY_LOG_FILE = "activity_log.json";
const MAX_ENTRIES = 2000; // keep the log bounded so it can't grow forever

export type ActivityAction =
  | "auth.login" | "auth.register"
  | "server.create" | "server.delete" | "server.start" | "server.stop" | "server.restart"
  | "server.owner_change" | "server.version_change" | "server.resource_change"
  | "file.upload" | "file.delete" | "file.rename"
  | "backup.create" | "backup.delete" | "backup.restore"
  | "subuser.add" | "subuser.remove"
  | "sftp.create" | "sftp.reset"
  | "user.create" | "user.delete" | "user.password_reset"
  | "settings.update";

export interface ActivityEntry {
  id: string;
  timestamp: string;
  actorId: string;
  actorUsername: string;
  action: ActivityAction;
  target?: string; // human-readable target, e.g. a server name or username
  serverId?: string;
  metadata?: Record<string, any>;
}

/**
 * Records an activity log entry. Fire-and-forget from the caller's
 * perspective — logging failures are swallowed so a logging bug can never
 * take down the actual feature it's instrumenting.
 */
export async function logActivity(entry: Omit<ActivityEntry, "id" | "timestamp">): Promise<void> {
  try {
    await updateJSON<ActivityEntry[]>(ACTIVITY_LOG_FILE, (current) => {
      const log = current || [];
      log.push({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        ...entry,
        actorUsername: entry.actorUsername || "unknown",
      });
      // Keep only the most recent MAX_ENTRIES to prevent unbounded growth.
      return log.length > MAX_ENTRIES ? log.slice(log.length - MAX_ENTRIES) : log;
    });
  } catch (err) {
    console.error("Failed to write activity log entry:", err);
  }
}

/**
 * Returns activity entries visible to the given user: admins/owners see
 * everything, regular users see only entries scoped to servers they own or
 * are a sub-user on, plus their own account-level actions.
 */
export async function getActivityForUser(
  user: { id: string; role: string },
  opts: { limit?: number; serverId?: string } = {}
): Promise<ActivityEntry[]> {
  const log = (await readJSON(ACTIVITY_LOG_FILE)) as ActivityEntry[] || [];
  const isAdmin = user.role === "admin" || user.role === "owner";

  let visible = log;
  if (!isAdmin) {
    const servers = (await readJSON("servers.json")) || [];
    const accessibleServerIds = new Set(
      servers
        .filter((s: any) => s.owner === user.id || (s.subUsers || []).some((su: any) => su.userId === user.id))
        .map((s: any) => s.id)
    );
    visible = log.filter((e) => e.actorId === user.id || (e.serverId && accessibleServerIds.has(e.serverId)));
  }

  if (opts.serverId) {
    visible = visible.filter((e) => e.serverId === opts.serverId);
  }

  const sorted = [...visible].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return opts.limit ? sorted.slice(0, opts.limit) : sorted;
}
