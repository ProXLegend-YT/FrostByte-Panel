// Server operation locking and transitional state tracking.
//
// Before this, start/stop/restart had no concept of "an operation is
// already running for this server" — two concurrent requests (e.g. a
// double-tap on the Start button, or a scheduled restart firing while a
// user manually restarts) would both proceed against Docker/the local
// process engine at the same time, which can leave a server in a broken
// half-started/half-stopped state with no clear cause.
//
// This is deliberately simple: an in-memory map, not a distributed lock.
// That's a correct match for this panel's architecture (single Node
// process, flat-file JSON storage, no multi-node support) — a heavier
// solution (Redis locks, a job queue) would be solving a problem this
// panel doesn't have yet.

import { io } from "../../../server.js";

export type ServerOperation = "starting" | "stopping" | "restarting";

const operationLocks = new Map<string, ServerOperation>();

/**
 * Attempts to acquire the lock for a server. Returns the currently
 * in-progress operation if one is already running (caller should treat
 * this as "reject/no-op", not overwrite it), or null if the lock was
 * acquired successfully.
 */
export const acquireOperationLock = (serverId: string, operation: ServerOperation): ServerOperation | null => {
  const existing = operationLocks.get(serverId);
  if (existing) return existing;
  operationLocks.set(serverId, operation);
  broadcastServerState(serverId, operation);
  return null;
};

export const releaseOperationLock = (serverId: string) => {
  operationLocks.delete(serverId);
};

export const getServerOperation = (serverId: string): ServerOperation | null => {
  return operationLocks.get(serverId) || null;
};

// Pushes a transitional state to anyone watching this server's page, so
// the UI can show "Starting..." immediately rather than waiting for the
// next status poll (which could be several seconds, depending on the
// panel's poll interval).
export const broadcastServerState = (serverId: string, state: ServerOperation | "online" | "offline") => {
  io.to(`server:${serverId}`).emit("server:state", { serverId, state });
};
