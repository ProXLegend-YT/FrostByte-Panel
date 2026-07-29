import express from "express";
import { getVersions } from "../services/docker.js";
import { requireAuth } from "../middleware/auth.js";
import os from "os";
import { readJSON, writeJSON } from "../services/db.js";
import { getActivityForUser } from "../services/activityLog.js";
import { getNotifications, markRead, deleteNotification } from "../services/notifications.js";
import bcrypt from "bcryptjs";

const router = express.Router();

router.use(requireAuth);

router.get("/notifications", async (req, res) => {
  const user = (req as any).user;
  const unreadOnly = req.query.unreadOnly === "true";
  const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string, 10) || 30, 100) : undefined;
  try {
    const notifications = await getNotifications(user.id, { unreadOnly, limit });
    res.json(notifications);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to load notifications" });
  }
});

router.put("/notifications/:id/read", async (req, res) => {
  const user = (req as any).user;
  try {
    await markRead(user.id, req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/notifications/read-all", async (req, res) => {
  const user = (req as any).user;
  try {
    await markRead(user.id, "all");
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/notifications/:id", async (req, res) => {
  const user = (req as any).user;
  try {
    await deleteNotification(user.id, req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/activity", async (req, res) => {
  const user = (req as any).user;
  const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string, 10) || 50, 200) : 50;
  const serverId = req.query.serverId as string | undefined;
  try {
    const entries = await getActivityForUser(user, { limit, serverId });
    res.json(entries);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to load activity log" });
  }
});

// Proxies for plugin/mod marketplace search. Modrinth allows browser CORS,
// but Spigot (api.spiget.org) and Hangar do not — calling them directly from
// the client silently fails (the request never even reaches the server, so
// there's nothing to catch), which is why plugin search looked "broken".
// Routing every source through the backend fixes that uniformly and also
// means one User-Agent/rate-limit policy for all three going forward.
router.get("/marketplace/plugins", async (req, res) => {
  const q = ((req.query.q as string) || "essentials").trim() || "essentials";
  const source = (req.query.source as string) || "all";
  const axios = (await import("axios")).default;
  const results: any[] = [];

  const tasks: Promise<void>[] = [];

  if (source === "all" || source === "modrinth") {
    tasks.push(
      axios
        .get(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}&facets=[["project_type:plugin"]]&limit=15`, {
          headers: { "User-Agent": "FrostByte-Panel/1.0" },
        })
        .then((r) => {
          for (const hit of r.data.hits || []) {
            results.push({
              id: hit.project_id,
              source: "modrinth",
              name: hit.title,
              tag: hit.description,
              downloads: hit.downloads,
              rating: 0,
              icon: hit.icon_url,
            });
          }
        })
        .catch(() => {})
    );
  }

  if (source === "all" || source === "spigot") {
    tasks.push(
      axios
        .get(`https://api.spiget.org/v2/search/resources/${encodeURIComponent(q)}?field=name&size=15&page=1`, {
          headers: { "User-Agent": "FrostByte-Panel/1.0" },
        })
        .then((r) => {
          if (Array.isArray(r.data)) {
            for (const hit of r.data) {
              results.push({
                id: hit.id.toString(),
                source: "spigot",
                name: hit.name,
                tag: hit.tag,
                downloads: hit.downloads,
                rating: hit.rating ? hit.rating.average : 0,
                icon: hit.icon?.url ? `https://spigotmc.org/${hit.icon.url}` : null,
              });
            }
          }
        })
        .catch(() => {})
    );
  }

  if (source === "all" || source === "hangar") {
    tasks.push(
      axios
        .get(`https://hangar.papermc.io/api/v1/projects?q=${encodeURIComponent(q)}&limit=15`, {
          headers: { "User-Agent": "FrostByte-Panel/1.0" },
        })
        .then((r) => {
          if (r.data?.result) {
            for (const hit of r.data.result) {
              results.push({
                id: `${hit.namespace.owner}/${hit.namespace.slug}`,
                source: "hangar",
                name: hit.name,
                tag: hit.description,
                downloads: hit.stats?.downloads || 0,
                rating: 0,
                icon: null,
              });
            }
          }
        })
        .catch(() => {})
    );
  }

  await Promise.all(tasks);
  results.sort((a, b) => b.downloads - a.downloads);
  res.json(results);
});

router.get("/marketplace/mods", async (req, res) => {
  const q = ((req.query.q as string) || "jei").trim() || "jei";
  const axios = (await import("axios")).default;
  const results: any[] = [];

  try {
    const r = await axios.get(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}&facets=[["project_type:mod"]]&limit=15`, {
      headers: { "User-Agent": "FrostByte-Panel/1.0" },
    });
    for (const hit of r.data.hits || []) {
      results.push({
        id: hit.project_id,
        name: hit.title,
        tag: hit.description,
        downloads: hit.downloads,
        icon: hit.icon_url,
      });
    }
  } catch { /* return whatever we have — empty is still a valid, honest result */ }

  results.sort((a, b) => b.downloads - a.downloads);
  res.json(results);
});

router.get("/versions", async (req, res) => {
  const type = (req.query.type as string) || "PAPER";
  const game = (req.query.game as string) || "minecraft";
  const versions = await getVersions(type, game);
  res.json(versions);
});

router.get("/games", async (req, res) => {
  const { listGameDefinitions } = await import("../gameDefinitions.js");
  const games = listGameDefinitions().map(g => ({
    id: g.id,
    name: g.name,
    category: g.category,
    description: g.description,
    subtypes: g.subtypes,
    defaultRam: g.defaultRam,
    defaultCpu: g.defaultCpu,
    defaultDisk: g.defaultDisk,
    supportsRcon: g.supportsRcon,
  }));
  res.json(games);
});

// Deprecated endpoint for backward compatibility
router.get("/paper-versions", async (req, res) => {
  const versions = await getVersions("PAPER");
  res.json(versions);
});

router.get("/stats", (req, res) => {
  const cpus = os.cpus();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();

  // os.loadavg()[0] is a 1-minute load average, not a percentage — on an
  // N-core machine a load of N means "fully busy", not "100%". Normalize
  // against core count so the dashboard shows a genuine utilization
  // percentage rather than a raw load figure that can exceed 100 and
  // mislead anyone reading it as CPU%.
  const coreCount = cpus.length || 1;
  const normalizedCpuUsage = Math.min(100, Math.round((os.loadavg()[0] / coreCount) * 100));

  res.json({
    cpuUsage: normalizedCpuUsage,
    totalMemory,
    freeMemory,
    ramUsage: Math.round(((totalMemory - freeMemory) / totalMemory) * 100),
    diskUsage: 0, // Not yet implemented — intentionally not surfaced in the UI
  });
});

router.get("/users", async (req, res) => {
  const user = (req as any).user;
  if(user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden"});
  const users = await readJSON("users.json") || [];
  // never return passwords
  res.json(users.map((u: any) => ({ id: u.id, username: u.username, role: u.role || 'admin', createdAt: u.createdAt })));
});

router.post("/users", async (req, res) => {
  const user = (req as any).user;
  if(user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden"});
  const { username, password, role } = req.body;
  if (!username || !password || !role) return res.status(400).json({ error: "Missing fields" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const users = await readJSON("users.json") || [];
  if (users.find((u: any) => u.username.toLowerCase() === username.toLowerCase())) return res.status(400).json({ error: "Username taken" });

  const { randomUUID } = await import("crypto");
  const hashedPassword = await bcrypt.hash(password, 10);
  const newUserId = randomUUID();
  users.push({
    id: newUserId,
    username,
    password: hashedPassword,
    role,
    passwordVersion: 0,
    createdAt: new Date().toISOString()
  });

  await writeJSON("users.json", users);
  res.json({ success: true, id: newUserId, username, role });
});

router.delete("/users/:id", async (req, res) => {
  const user = (req as any).user;
  if(user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden"});
  
  let users = await readJSON("users.json") || [];
  users = users.filter((u: any) => u.id !== req.params.id);
  await writeJSON("users.json", users);
  res.json({ success: true });
});


router.put("/users/:id/password", async (req, res) => {
  const user = (req as any).user;
  if(user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden"});
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  
  const users = await readJSON("users.json") || [];
  const targetIndex = users.findIndex((u: any) => u.id === req.params.id);
  if (targetIndex === -1) return res.status(404).json({ error: "User not found" });
  
  const bcrypt = await import("bcryptjs");
  const hashedPassword = await bcrypt.default.hash(newPassword, 10);
  users[targetIndex].password = hashedPassword;
  users[targetIndex].passwordVersion = (users[targetIndex].passwordVersion || 0) + 1;
  await writeJSON("users.json", users);
  res.json({ success: true });
});

router.put("/settings", async (req, res) => {
  const user = (req as any).user;
  if(user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden"});
  const { panelName, panelLogo, panelBackgroundImage, panelBackgroundBlur, enableLoginAnimation, allowRegistration } = req.body;
  const settings = await readJSON("settings.json") || {};
  if (panelName !== undefined) settings.panelName = panelName || "FrostByte Panel";
  if (panelLogo !== undefined) settings.panelLogo = panelLogo;
  if (panelBackgroundImage !== undefined) settings.panelBackgroundImage = panelBackgroundImage;
  if (panelBackgroundBlur !== undefined) settings.panelBackgroundBlur = panelBackgroundBlur;
  if (enableLoginAnimation !== undefined) settings.enableLoginAnimation = enableLoginAnimation;
  if (allowRegistration !== undefined) settings.allowRegistration = allowRegistration;
  await writeJSON("settings.json", settings);
  res.json({ success: true });
});

router.post("/update", async (req, res) => {
  const user = (req as any).user;
  if(user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden"});

  // Broadcast to all clients to refresh in a few seconds
  const io = req.app.get("io");
  if (io) {
    io.emit("system_update_started");
  }

  res.json({ success: true, message: "Update process started" });

  const { exec } = await import("child_process");
  setTimeout(() => {
    exec("bash update.sh", (error, stdout, stderr) => {
      console.log(`Update stdout: ${stdout}`);
      console.error(`Update stderr: ${stderr}`);
    });
  }, 1000);
});





export default router;
