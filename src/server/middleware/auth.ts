import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET environment variable is not set. Refusing to start with an insecure default secret."
  );
}

export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = authHeader.split(" ")[1];

  // API Key Authentication
  if (token.startsWith("fb-") || token.startsWith("fb_")) {
    try {
      const { readJSON, writeJSON } = await import("../services/db.js");
      const apiKeys = await readJSON("api_keys.json") || [];
      const keyHash = crypto.createHash('sha256').update(token).digest('hex');
      
      const apiKey = apiKeys.find((k: any) => k.key_hash === keyHash);
      if (!apiKey || apiKey.revoked) {
        res.status(401).json({ error: "Invalid or revoked API key" });
        return;
      }
      if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
        res.status(401).json({ error: "API key expired" });
        return;
      }

      // Update last_used_at
      apiKey.last_used_at = new Date().toISOString();
      await writeJSON("api_keys.json", apiKeys);

      // Verify the creator is still an admin
      const users = await readJSON("users.json") || [];
      const creator = users.find((u: any) => u.id === apiKey.created_by);
      if (!creator || (creator.role !== "admin" && creator.role !== "owner")) {
         res.status(403).json({ error: "Forbidden: API Key creator is no longer an admin" });
         return;
      }
      const adminRole = creator.role;

      (req as any).user = { id: apiKey.created_by, username: creator.username, role: adminRole, isApiKey: true, scopes: apiKey.scopes };
      next();
      return;
    } catch (err) {
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.role !== 'admin' && decoded.role !== 'owner') {
       res.status(403).json({ error: "Forbidden: Admin access only" });
       return;
    }

    const { readJSON } = await import("../services/db.js");
    const users = await readJSON("users.json") || [];
    const user = users.find((u: any) => u.id === decoded.id);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    if ((user.passwordVersion || 0) !== (decoded.passwordVersion || 0)) {
      res.status(401).json({ error: "Session expired" });
      return;
    }
    
    (req as any).user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
};

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = authHeader.split(" ")[1];

  // API Key Authentication
  if (token.startsWith("fb-") || token.startsWith("fb_")) {
    try {
      const { readJSON, writeJSON } = await import("../services/db.js");
      const apiKeys = await readJSON("api_keys.json") || [];
      const keyHash = crypto.createHash('sha256').update(token).digest('hex');
      
      const apiKey = apiKeys.find((k: any) => k.key_hash === keyHash);
      if (!apiKey || apiKey.revoked) {
        res.status(401).json({ error: "Invalid or revoked API key" });
        return;
      }
      if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
        res.status(401).json({ error: "API key expired" });
        return;
      }

      // Update last_used_at
      apiKey.last_used_at = new Date().toISOString();
      await writeJSON("api_keys.json", apiKeys);

      const users = await readJSON("users.json") || [];
      const creator = users.find((u: any) => u.id === apiKey.created_by);
      if (!creator) {
        res.status(403).json({ error: "Forbidden: API Key creator no longer exists" });
        return;
      }
      const role = creator.role || "user";

      (req as any).user = { id: apiKey.created_by, username: creator.username, role, isApiKey: true, scopes: apiKey.scopes };
      next();
      return;
    } catch (err) {
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    // Reject scoped tokens outright here — e.g. the short-lived
    // "2fa-pending" token minted mid-login only proves a password was
    // correct, not that the second factor was verified, and must never be
    // usable as a real session token on any authenticated route.
    if (decoded.purpose) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const { readJSON } = await import("../services/db.js");
    const users = await readJSON("users.json") || [];
    const user = users.find((u: any) => u.id === decoded.id);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    if ((user.passwordVersion || 0) !== (decoded.passwordVersion || 0)) {
      res.status(401).json({ error: "Session expired" });
      return;
    }
    
    (req as any).user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
};

/**
 * Ensures the authenticated user is an admin/owner, OR the owner of the
 * specific server referenced by req.params.id, OR a sub-user with the
 * required permission on that server. Attaches the loaded `server` object
 * to req for downstream handlers to reuse (avoids double reads).
 */
export const requireServerAccess = (permission?: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: "Missing server id" });
        return;
      }

      const { readJSON } = await import("../services/db.js");
      const servers = await readJSON("servers.json") || [];
      const server = servers.find((s: any) => s.id === id);

      if (!server) {
        res.status(404).json({ error: "Server not found" });
        return;
      }

      if (user.role === "admin" || user.role === "owner") {
        (req as any).server = server;
        next();
        return;
      }

      if (server.owner === user.id) {
        (req as any).server = server;
        next();
        return;
      }

      const subUser = (server.subUsers || []).find((su: any) => su.userId === user.id);
      if (subUser && (!permission || subUser.permissions?.includes(permission))) {
        (req as any).server = server;
        next();
        return;
      }

      res.status(403).json({ error: "Forbidden: you do not have access to this server" });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Internal Server Error" });
    }
  };
};
