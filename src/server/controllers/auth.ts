import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { readJSON } from "../services/db.js";
import { logActivity } from "../services/activityLog.js";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET environment variable is not set. Refusing to start with an insecure default secret."
  );
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

export const register = async (req: Request, res: Response) => {
  const { username, password } = req.body;

  const { writeJSON } = await import("../services/db.js");
  const settings = await readJSON("settings.json") || {};
  const users = await readJSON("users.json") || [];

  // Registration can be closed by an admin after initial setup. The very
  // first account on a fresh instance is always allowed through regardless,
  // so there's always a way to bootstrap a new deployment.
  if (settings.allowRegistration === false && users.length > 0) {
    return res.status(403).json({ error: "Registration is currently disabled on this panel." });
  }

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: "Username must be 3-32 characters (letters, numbers, _ . -)" });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  if (users.find((u: any) => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: "Username already taken" });
  }

  // The very first account created on a fresh instance becomes the owner.
  const role = users.length === 0 ? "owner" : "user";

  const hashedPassword = await bcrypt.hash(password, 10);
  const user: any = {
    id: randomUUID(),
    username,
    password: hashedPassword,
    role,
    passwordVersion: 0,
    createdAt: new Date().toISOString(),
  };

  if (settings.coinsEnabled === true) {
    const startingBalance = typeof settings.coinsStartingBalance === "number" ? settings.coinsStartingBalance : 100;
    user.coins = startingBalance;
  }

  users.push(user);
  await writeJSON("users.json", users);
  logActivity({ actorId: user.id, actorUsername: user.username, action: "auth.register", target: username, metadata: { role } });

  const token = jwt.sign(
    { id: user.id, username: user.username, role, passwordVersion: 0 },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.status(201).json({ token, user: { id: user.id, username: user.username, role } });
};

export const login = async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: "Username and password required" });
    return;
  }

  const users = await readJSON("users.json") || [];
  
  const user = users.find((u: any) => u.username === username);

  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const isMatch = await bcrypt.compare(password, user.password);

  if (!isMatch) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const role = user.role || "user";

  // If this account has 2FA enabled, the password alone isn't enough to
  // finish logging in — issue a short-lived, narrowly-scoped token that
  // only proves "this password was correct" and can only be redeemed at
  // the 2fa/verify-login endpoint, not used as a real session token
  // anywhere else. The real 7-day session token is only issued after the
  // code is verified.
  if (user.twoFactorEnabled) {
    const tempToken = jwt.sign(
      { id: user.id, purpose: "2fa-pending" },
      JWT_SECRET,
      { expiresIn: "5m" }
    );
    res.json({ requires2FA: true, tempToken });
    return;
  }

  const token = jwt.sign({ id: user.id, username: user.username, role, passwordVersion: user.passwordVersion || 0 }, JWT_SECRET, { expiresIn: "7d" });

  res.json({ token, user: { id: user.id, username: user.username, role } });
};

export const verifyLoginTwoFactor = async (req: Request, res: Response) => {
  const { tempToken, code, recoveryCode } = req.body;
  if (!tempToken) return res.status(400).json({ error: "Missing session token — please log in again." });

  let decoded: any;
  try {
    decoded = jwt.verify(tempToken, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "That login attempt has expired. Please log in again." });
  }
  if (decoded.purpose !== "2fa-pending") {
    return res.status(401).json({ error: "Invalid session token." });
  }

  const users = await readJSON("users.json") || [];
  const userIndex = users.findIndex((u: any) => u.id === decoded.id);
  if (userIndex === -1) return res.status(404).json({ error: "Account not found." });
  const user = users[userIndex];

  if (!user.twoFactorEnabled || !user.twoFactorSecret) {
    return res.status(400).json({ error: "2FA is not enabled on this account." });
  }

  const { verifyTotpCode } = await import("../services/totp.js");
  let verified = false;

  if (code) {
    verified = verifyTotpCode(user.twoFactorSecret, code);
  } else if (recoveryCode) {
    // Recovery codes are single-use — consume it on successful match so it
    // can't be replayed if it ever leaked (e.g. shoulder-surfed).
    const normalized = String(recoveryCode).trim().toUpperCase();
    const codes: string[] = user.twoFactorRecoveryCodes || [];
    const idx = codes.indexOf(normalized);
    if (idx !== -1) {
      verified = true;
      const { writeJSON } = await import("../services/db.js");
      users[userIndex].twoFactorRecoveryCodes = codes.filter((_: string, i: number) => i !== idx);
      await writeJSON("users.json", users);
    }
  } else {
    return res.status(400).json({ error: "Enter your 6-digit code or a recovery code." });
  }

  if (!verified) {
    return res.status(401).json({ error: "Incorrect code. Please try again." });
  }

  const role = user.role || "user";
  const token = jwt.sign({ id: user.id, username: user.username, role, passwordVersion: user.passwordVersion || 0 }, JWT_SECRET, { expiresIn: "7d" });
  logActivity({ actorId: user.id, actorUsername: user.username, action: "auth.login", target: user.username, metadata: { via: recoveryCode ? "2fa-recovery" : "2fa" } });

  res.json({ token, user: { id: user.id, username: user.username, role } });
};

export const logout = (req: Request, res: Response) => {
  res.json({ message: "Logged out" });
};

export const getMe = async (req: Request, res: Response) => {
  const decoded = (req as any).user;
  try {
    const users = await readJSON("users.json") || [];
    const record = users.find((u: any) => u.id === decoded.id);
    if (record) {
      const hasPerUserOverride = record.canCreateServers !== undefined;
      let effective: { canCreateServers: boolean; maxServers: number; maxRamGb: number; maxCpuPercent: number; maxDiskGb: number };

      if (hasPerUserOverride) {
        effective = {
          canCreateServers: !!record.canCreateServers,
          maxServers: typeof record.maxServers === "number" ? record.maxServers : 1,
          maxRamGb: typeof record.maxRamGb === "number" ? record.maxRamGb : 4,
          maxCpuPercent: typeof record.maxCpuPercent === "number" ? record.maxCpuPercent : 200,
          maxDiskGb: typeof record.maxDiskGb === "number" ? record.maxDiskGb : 10,
        };
      } else {
        // No explicit per-user setting — fall back to whatever the panel's
        // global default is (Settings → Administrator Controls).
        const settings = await readJSON("settings.json") || {};
        effective = {
          canCreateServers: settings.allowUserServerCreation === true,
          maxServers: typeof settings.defaultMaxServers === "number" ? settings.defaultMaxServers : 1,
          maxRamGb: typeof settings.defaultMaxRamGb === "number" ? settings.defaultMaxRamGb : 4,
          maxCpuPercent: typeof settings.defaultMaxCpuPercent === "number" ? settings.defaultMaxCpuPercent : 200,
          maxDiskGb: typeof settings.defaultMaxDiskGb === "number" ? settings.defaultMaxDiskGb : 10,
        };
      }

      res.json({ user: { ...decoded, ...effective, twoFactorEnabled: !!record.twoFactorEnabled } });
      return;
    }
  } catch { /* fall through to the JWT-only response below */ }
  res.json({ user: decoded });
};

export const getUsers = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;
  if (reqUser.role !== "admin" && reqUser.role !== "owner") {
    return res.status(403).json({ error: "Forbidden" });
  }
  const users = await readJSON("users.json") || [];
  res.json(users.map((u: any) => ({ id: u.id, username: u.username, role: u.role })));
};

export const changePassword = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;
  const { oldPassword, newPassword } = req.body;
  
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  }
  
  const users = await readJSON("users.json") || [];
  const userIndex = users.findIndex((u: any) => u.id === reqUser.id);
  
  if (userIndex === -1) {
    return res.status(404).json({ error: "User not found" });
  }
  
  const isMatch = await bcrypt.compare(oldPassword || "", users[userIndex].password);
  if (!isMatch) {
    return res.status(401).json({ error: "Incorrect old password" });
  }

  // Use dynamic import for writeJSON since it's in another file
  const { writeJSON } = await import("../services/db.js");
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  
  users[userIndex].password = hashedPassword;
  users[userIndex].passwordVersion = (users[userIndex].passwordVersion || 0) + 1;
  await writeJSON("users.json", users);
  
  res.json({ success: true });
};

// --- Two-factor authentication (TOTP) -----------------------------------
// Enrollment is a two-step confirm flow, not instant-on: /2fa/setup
// generates a secret and returns it (not yet saved to the account), and
// /2fa/confirm only turns 2FA on after the user proves they scanned it
// correctly by entering a real code. This prevents someone from enabling
// 2FA, mistyping their authenticator setup, and immediately locking
// themselves out with no way back in.

export const setupTwoFactor = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;
  const users = await readJSON("users.json") || [];
  const user = users.find((u: any) => u.id === reqUser.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  if (user.twoFactorEnabled) {
    return res.status(400).json({ error: "Two-factor authentication is already enabled on this account." });
  }

  const { generateTotpSecret, buildOtpauthUri } = await import("../services/totp.js");
  const secret = generateTotpSecret();
  const settings = await readJSON("settings.json") || {};
  const issuer = settings.panelName || "FrostByte Panel";
  const otpauthUri = buildOtpauthUri(secret, user.username, issuer);

  // The secret isn't written to the account yet — only staged in the
  // pending-setup state below. It's saved for real in /2fa/confirm, once
  // the user has proven the authenticator app is actually working.
  const { updateJSON } = await import("../services/db.js");
  await updateJSON<any[]>("users.json", (current) => {
    const list = current || [];
    const u = list.find((x: any) => x.id === reqUser.id);
    if (u) u.pendingTwoFactorSecret = secret;
    return list;
  });

  res.json({ secret, otpauthUri });
};

export const confirmTwoFactor = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Enter the 6-digit code from your authenticator app." });

  const users = await readJSON("users.json") || [];
  const user = users.find((u: any) => u.id === reqUser.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!user.pendingTwoFactorSecret) {
    return res.status(400).json({ error: "No 2FA setup in progress. Start setup again." });
  }

  const { verifyTotpCode, generateRecoveryCodes } = await import("../services/totp.js");
  if (!verifyTotpCode(user.pendingTwoFactorSecret, code)) {
    return res.status(401).json({ error: "That code didn't match. Check your authenticator app and try again." });
  }

  const recoveryCodes = generateRecoveryCodes();
  const { updateJSON } = await import("../services/db.js");
  await updateJSON<any[]>("users.json", (current) => {
    const list = current || [];
    const u = list.find((x: any) => x.id === reqUser.id);
    if (u) {
      u.twoFactorEnabled = true;
      u.twoFactorSecret = u.pendingTwoFactorSecret;
      u.twoFactorRecoveryCodes = recoveryCodes;
      delete u.pendingTwoFactorSecret;
    }
    return list;
  });

  logActivity({ actorId: user.id, actorUsername: user.username, action: "auth.2fa_enable", target: user.username });

  // Recovery codes are shown exactly once, right here — they're not
  // retrievable again later (only re-generatable, which invalidates the
  // old set), same as how GitHub/Google present them.
  res.json({ success: true, recoveryCodes });
};

export const disableTwoFactor = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Enter your password to disable two-factor authentication." });

  const users = await readJSON("users.json") || [];
  const user = users.find((u: any) => u.id === reqUser.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(401).json({ error: "Incorrect password." });

  const { updateJSON } = await import("../services/db.js");
  await updateJSON<any[]>("users.json", (current) => {
    const list = current || [];
    const u = list.find((x: any) => x.id === reqUser.id);
    if (u) {
      u.twoFactorEnabled = false;
      delete u.twoFactorSecret;
      delete u.twoFactorRecoveryCodes;
      delete u.pendingTwoFactorSecret;
    }
    return list;
  });

  logActivity({ actorId: user.id, actorUsername: user.username, action: "auth.2fa_disable", target: user.username });
  res.json({ success: true });
};

export const regenerateRecoveryCodes = async (req: Request, res: Response) => {
  const reqUser = (req as any).user;
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Enter your password to regenerate recovery codes." });

  const users = await readJSON("users.json") || [];
  const user = users.find((u: any) => u.id === reqUser.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!user.twoFactorEnabled) return res.status(400).json({ error: "Two-factor authentication isn't enabled." });

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(401).json({ error: "Incorrect password." });

  const { generateRecoveryCodes } = await import("../services/totp.js");
  const recoveryCodes = generateRecoveryCodes();
  const { updateJSON } = await import("../services/db.js");
  await updateJSON<any[]>("users.json", (current) => {
    const list = current || [];
    const u = list.find((x: any) => x.id === reqUser.id);
    if (u) u.twoFactorRecoveryCodes = recoveryCodes;
    return list;
  });

  logActivity({ actorId: user.id, actorUsername: user.username, action: "auth.2fa_regenerate_codes", target: user.username });
  res.json({ success: true, recoveryCodes });
};
