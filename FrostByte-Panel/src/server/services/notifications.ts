import { randomUUID } from "crypto";
import { updateJSON, readJSON } from "./db.js";

const NOTIFICATIONS_FILE = "notifications.json";
const MAX_PER_USER = 200;

export type NotificationType = "info" | "success" | "warning" | "error";

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  serverId?: string;
  link?: string;
  read: boolean;
  createdAt: string;
}

/**
 * Creates a notification for a single user, persists it, and pushes it in
 * real time over their private socket room if they're currently connected.
 * Safe to call even if socket.io hasn't been imported yet at module load
 * time — the io instance is lazily imported to avoid a circular import with
 * server.ts (which itself imports services that may import this module).
 */
export async function notifyUser(userId: string, notification: Omit<Notification, "id" | "userId" | "read" | "createdAt">): Promise<Notification> {
  const entry: Notification = {
    id: randomUUID(),
    userId,
    read: false,
    createdAt: new Date().toISOString(),
    ...notification,
  };

  try {
    await updateJSON<Notification[]>(NOTIFICATIONS_FILE, (current) => {
      const all = current || [];
      all.push(entry);
      // Trim per-user rather than globally, so one noisy user's history
      // can't push another user's older notifications out of the file.
      const forUser = all.filter((n) => n.userId === userId);
      if (forUser.length > MAX_PER_USER) {
        const toDrop = new Set(
          forUser
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
            .slice(0, forUser.length - MAX_PER_USER)
            .map((n) => n.id)
        );
        return all.filter((n) => !toDrop.has(n.id));
      }
      return all;
    });
  } catch (err) {
    console.error("Failed to persist notification:", err);
  }

  try {
    const { io } = await import("../../../server.js");
    io.to(`user_${userId}`).emit("notification", entry);
  } catch (err) {
    // socket.io not ready yet or user not connected — the notification is
    // still persisted and will be picked up on next fetch.
  }

  return entry;
}

/**
 * Notifies every admin/owner account. Used for panel-wide events an
 * operator should know about (e.g. a server repeatedly crashing).
 */
export async function notifyAdmins(notification: Omit<Notification, "id" | "userId" | "read" | "createdAt">): Promise<void> {
  const users = (await readJSON("users.json")) || [];
  const admins = users.filter((u: any) => u.role === "admin" || u.role === "owner");
  await Promise.all(admins.map((u: any) => notifyUser(u.id, notification)));
}

export async function getNotifications(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Notification[]> {
  const all = (await readJSON(NOTIFICATIONS_FILE)) as Notification[] || [];
  let mine = all.filter((n) => n.userId === userId);
  if (opts.unreadOnly) mine = mine.filter((n) => !n.read);
  mine.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return opts.limit ? mine.slice(0, opts.limit) : mine;
}

export async function markRead(userId: string, notificationId: string | "all"): Promise<void> {
  await updateJSON<Notification[]>(NOTIFICATIONS_FILE, (current) => {
    const all = current || [];
    for (const n of all) {
      if (n.userId !== userId) continue;
      if (notificationId === "all" || n.id === notificationId) n.read = true;
    }
    return all;
  });
}

export async function deleteNotification(userId: string, notificationId: string): Promise<void> {
  await updateJSON<Notification[]>(NOTIFICATIONS_FILE, (current) => {
    const all = current || [];
    return all.filter((n) => !(n.userId === userId && n.id === notificationId));
  });
}
