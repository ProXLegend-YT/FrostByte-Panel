import "dotenv/config";
import bcrypt from "bcryptjs";
import readline from "readline";
import path from "path";
import fs from "fs-extra";
import { randomUUID } from "crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

fs.ensureDirSync(DATA_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]");

console.log("=== FrostByte Panel Admin User Creation ===");
console.log("Use this to create an admin account directly, or to promote/reset an existing account to admin.");

rl.question("Username: ", async (username) => {
  rl.question("Password: ", async (password) => {
    if (!username || !password) {
      console.error("Username and password are required.");
      process.exit(1);
    }
    if (password.length < 8) {
      console.error("Password must be at least 8 characters.");
      process.exit(1);
    }
    const users = await fs.readJson(USERS_FILE);
    const existingIndex = users.findIndex((u: any) => u.username === username);
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    if (existingIndex !== -1) {
      // Update to admin, and bump passwordVersion so any existing sessions
      // for this account (including any stale ones) are invalidated.
      users[existingIndex].password = hashedPassword;
      users[existingIndex].role = "admin";
      users[existingIndex].passwordVersion = (users[existingIndex].passwordVersion || 0) + 1;
      await fs.writeJson(USERS_FILE, users, { spaces: 2 });
      console.log("Admin user updated successfully.");
      process.exit(0);
    } else {
      users.push({
        id: randomUUID(),
        username,
        password: hashedPassword,
        role: "admin",
        passwordVersion: 0,
        createdAt: new Date().toISOString()
      });

      await fs.writeJson(USERS_FILE, users, { spaces: 2 });
      console.log("Admin user created successfully.");
      process.exit(0);
    }
  });
});
