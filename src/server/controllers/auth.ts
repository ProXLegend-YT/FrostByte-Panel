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
  const user = {
    id: randomUUID(),
    username,
    password: hashedPassword,
    role,
    passwordVersion: 0,
    createdAt: new Date().toISOString(),
  };

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
  const token = jwt.sign({ id: user.id, username: user.username, role, passwordVersion: user.passwordVersion || 0 }, JWT_SECRET, { expiresIn: "7d" });

  res.json({ token, user: { id: user.id, username: user.username, role } });
};

export const logout = (req: Request, res: Response) => {
  res.json({ message: "Logged out" });
};

export const getMe = (req: Request, res: Response) => {
  res.json({ user: (req as any).user });
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
