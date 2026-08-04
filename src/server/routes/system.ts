import express from "express";
import { getVersions } from "../services/docker.js";
import { requireAuth } from "../middleware/auth.js";
import os from "os";
import { readJSON, writeJSON } from "../services/db.js";
import { getActivityForUser, logActivity } from "../services/activityLog.js";
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

// Modpacks are a distinct Modrinth project_type from mods — this searches
// that facet and additionally surfaces each pack's Minecraft version +
// mod loader (fabric/forge/quilt/neoforge) from the search index's
// `categories`/`versions` fields, so the picker can show that up front
// instead of needing a follow-up request per result.
router.get("/marketplace/modpacks", async (req, res) => {
  const q = ((req.query.q as string) || "").trim();
  const axios = (await import("axios")).default;
  const results: any[] = [];
  const LOADER_TAGS = ["fabric", "forge", "quilt", "neoforge"];

  try {
    const r = await axios.get(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}&facets=[["project_type:modpack"]]&limit=20`, {
      headers: { "User-Agent": "FrostByte-Panel/1.0" },
    });
    for (const hit of r.data.hits || []) {
      results.push({
        id: hit.project_id,
        name: hit.title,
        tag: hit.description,
        downloads: hit.downloads,
        icon: hit.icon_url,
        loaders: (hit.categories || []).filter((c: string) => LOADER_TAGS.includes(c)),
        gameVersions: hit.versions || [],
      });
    }
  } catch { /* honest empty result on failure, same as marketplace/mods */ }

  results.sort((a, b) => b.downloads - a.downloads);
  res.json(results);
});

// A pack's install button needs a concrete version to install, not just
// the project — this lists installable versions (newest first) with the
// exact game version + loader + the versionId installModpack expects.
router.get("/marketplace/modpacks/:projectId/versions", async (req, res) => {
  const { projectId } = req.params;
  const axios = (await import("axios")).default;
  try {
    const r = await axios.get(`https://api.modrinth.com/v2/project/${projectId}/version`, {
      headers: { "User-Agent": "FrostByte-Panel/1.0" },
    });
    const versions = (r.data || []).map((v: any) => ({
      versionId: v.id,
      versionNumber: v.version_number,
      name: v.name,
      gameVersions: v.game_versions,
      loaders: v.loaders,
      datePublished: v.date_published,
    }));
    res.json(versions);
  } catch (e: any) {
    res.status(502).json({ error: "Could not load versions for this pack." });
  }
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

router.get("/stats", async (req, res) => {
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

  // Node has no built-in cross-platform disk-usage API. `df` is available
  // on essentially every environment this panel targets (standard Linux,
  // Termux included) — shell out to it rather than adding a dependency for
  // something this simple. Falls back to 0 (previous permanent behavior)
  // if df isn't available or parsing fails, rather than erroring the whole
  // stats endpoint over a non-critical metric.
  let diskUsage = 0;
  let diskTotal = 0;
  let diskFree = 0;
  try {
    const { exec } = await import("child_process");
    const dfOutput = await new Promise<string>((resolve, reject) => {
      exec(`df -k "${process.cwd()}"`, { timeout: 3000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    // Second line of `df -k` output: Filesystem 1K-blocks Used Available Use% Mounted
    const dataLine = dfOutput.trim().split("\n")[1];
    const parts = dataLine?.trim().split(/\s+/);
    if (parts && parts.length >= 5) {
      diskTotal = parseInt(parts[1], 10) * 1024;
      diskFree = parseInt(parts[3], 10) * 1024;
      const usePercent = parseInt(parts[4].replace("%", ""), 10);
      if (!isNaN(usePercent)) diskUsage = usePercent;
    }
  } catch {
    // df unavailable or parsing failed — leave diskUsage at 0 rather than
    // failing the whole endpoint over a non-critical metric.
  }

  res.json({
    cpuUsage: normalizedCpuUsage,
    totalMemory,
    freeMemory,
    ramUsage: Math.round(((totalMemory - freeMemory) / totalMemory) * 100),
    diskUsage,
    diskTotal,
    diskFree,
  });
});

router.get("/users", async (req, res) => {
  const user = (req as any).user;
  if(user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden"});
  const users = await readJSON("users.json") || [];
  // never return passwords
  res.json(users.map((u: any) => ({
    id: u.id,
    username: u.username,
    role: u.role || 'admin',
    createdAt: u.createdAt,
    hasServerPermissionOverride: u.canCreateServers !== undefined,
    canCreateServers: !!u.canCreateServers,
    maxServers: typeof u.maxServers === "number" ? u.maxServers : 1,
    maxRamGb: typeof u.maxRamGb === "number" ? u.maxRamGb : 4,
    maxCpuPercent: typeof u.maxCpuPercent === "number" ? u.maxCpuPercent : 200,
    maxDiskGb: typeof u.maxDiskGb === "number" ? u.maxDiskGb : 10,
  })));
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

router.put("/users/:id/server-permissions", async (req, res) => {
  const admin = (req as any).user;
  if (admin.role !== "admin" && admin.role !== "owner") return res.status(403).json({ error: "Forbidden" });

  const { canCreateServers, maxServers, maxRamGb, maxCpuPercent, maxDiskGb, clearOverride } = req.body;

  // Bounds mirror the ones enforced in createServer, so an admin can never
  // configure a grant that createServer would reject anyway.
  if (maxServers !== undefined && (typeof maxServers !== "number" || maxServers < 0 || maxServers > 50)) {
    return res.status(400).json({ error: "maxServers must be between 0 and 50" });
  }
  if (maxRamGb !== undefined && (typeof maxRamGb !== "number" || maxRamGb < 0.5 || maxRamGb > 128)) {
    return res.status(400).json({ error: "maxRamGb must be between 0.5 and 128" });
  }
  if (maxCpuPercent !== undefined && (typeof maxCpuPercent !== "number" || maxCpuPercent < 10 || maxCpuPercent > 1600)) {
    return res.status(400).json({ error: "maxCpuPercent must be between 10 and 1600" });
  }
  if (maxDiskGb !== undefined && (typeof maxDiskGb !== "number" || maxDiskGb < 1 || maxDiskGb > 1000)) {
    return res.status(400).json({ error: "maxDiskGb must be between 1 and 1000" });
  }

  const users = await readJSON("users.json") || [];
  const target = users.find((u: any) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.role === "admin" || target.role === "owner") {
    return res.status(400).json({ error: "Admins already have full server-creation access." });
  }

  if (clearOverride) {
    // Revert this user to following the panel-wide global default instead
    // of a fixed per-user setting.
    delete target.canCreateServers;
    delete target.maxServers;
    delete target.maxRamGb;
    delete target.maxCpuPercent;
    delete target.maxDiskGb;
    await writeJSON("users.json", users);
    return res.json({ success: true, cleared: true });
  }

  if (canCreateServers !== undefined) target.canCreateServers = !!canCreateServers;
  if (maxServers !== undefined) target.maxServers = maxServers;
  if (maxRamGb !== undefined) target.maxRamGb = maxRamGb;
  if (maxCpuPercent !== undefined) target.maxCpuPercent = maxCpuPercent;
  if (maxDiskGb !== undefined) target.maxDiskGb = maxDiskGb;

  await writeJSON("users.json", users);
  res.json({
    success: true,
    canCreateServers: !!target.canCreateServers,
    maxServers: target.maxServers ?? 1,
    maxRamGb: target.maxRamGb ?? 4,
    maxCpuPercent: target.maxCpuPercent ?? 200,
    maxDiskGb: target.maxDiskGb ?? 10,
  });
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

// Authenticated (unlike the public /api/settings) since this includes the
// actual RAM/CPU/disk numbers, not just the on/off flag.
router.get("/settings/server-defaults", async (req, res) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden" });
  const settings = await readJSON("settings.json") || {};
  res.json({
    allowUserServerCreation: settings.allowUserServerCreation === true,
    defaultMaxServers: settings.defaultMaxServers ?? 1,
    defaultMaxRamGb: settings.defaultMaxRamGb ?? 4,
    defaultMaxCpuPercent: settings.defaultMaxCpuPercent ?? 200,
    defaultMaxDiskGb: settings.defaultMaxDiskGb ?? 10,
  });
});

router.put("/settings", async (req, res) => {
  const user = (req as any).user;
  if(user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden"});
  const {
    panelName, panelLogo, panelBackgroundImage, panelBackgroundBlur, allowRegistration,
    allowUserServerCreation, defaultMaxServers, defaultMaxRamGb, defaultMaxCpuPercent, defaultMaxDiskGb,
  } = req.body;
  const settings = await readJSON("settings.json") || {};
  if (panelName !== undefined) settings.panelName = panelName || "FrostByte Panel";
  if (panelLogo !== undefined) settings.panelLogo = panelLogo;
  if (panelBackgroundImage !== undefined) settings.panelBackgroundImage = panelBackgroundImage;
  if (panelBackgroundBlur !== undefined) settings.panelBackgroundBlur = panelBackgroundBlur;
  if (allowRegistration !== undefined) settings.allowRegistration = allowRegistration;

  // Panel-wide default for whether normal users can create servers, plus the
  // shared quota applied to anyone who hasn't been individually configured
  // via Settings → per-user "Server Access". A per-user override (set
  // explicitly true or false for a specific account) always wins over this
  // default — this only controls the fallback for everyone else.
  if (allowUserServerCreation !== undefined) settings.allowUserServerCreation = !!allowUserServerCreation;
  if (defaultMaxServers !== undefined) {
    if (typeof defaultMaxServers !== "number" || defaultMaxServers < 0 || defaultMaxServers > 50) {
      return res.status(400).json({ error: "defaultMaxServers must be between 0 and 50" });
    }
    settings.defaultMaxServers = defaultMaxServers;
  }
  if (defaultMaxRamGb !== undefined) {
    if (typeof defaultMaxRamGb !== "number" || defaultMaxRamGb < 0.5 || defaultMaxRamGb > 128) {
      return res.status(400).json({ error: "defaultMaxRamGb must be between 0.5 and 128" });
    }
    settings.defaultMaxRamGb = defaultMaxRamGb;
  }
  if (defaultMaxCpuPercent !== undefined) {
    if (typeof defaultMaxCpuPercent !== "number" || defaultMaxCpuPercent < 10 || defaultMaxCpuPercent > 1600) {
      return res.status(400).json({ error: "defaultMaxCpuPercent must be between 10 and 1600" });
    }
    settings.defaultMaxCpuPercent = defaultMaxCpuPercent;
  }
  if (defaultMaxDiskGb !== undefined) {
    if (typeof defaultMaxDiskGb !== "number" || defaultMaxDiskGb < 1 || defaultMaxDiskGb > 1000) {
      return res.status(400).json({ error: "defaultMaxDiskGb must be between 1 and 1000" });
    }
    settings.defaultMaxDiskGb = defaultMaxDiskGb;
  }

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





// --- Coin economy & store ----------------------------------------------
// See src/server/services/coins.ts for the actual balance/ledger/store
// logic — these routes are a thin HTTP layer with permission checks and
// input validation on top of it.

router.get("/coins/settings", async (req, res) => {
  const { getCoinSettings } = await import("../services/coins.js");
  res.json(await getCoinSettings());
});

router.put("/coins/settings", async (req, res) => {
  const user = (req as any).user;
  if (user.role !== "admin" && user.role !== "owner") return res.status(403).json({ error: "Forbidden" });

  const { enabled, currencyName, currencySymbol, startingBalance } = req.body;
  if (currencyName !== undefined && (typeof currencyName !== "string" || !currencyName.trim() || currencyName.length > 30)) {
    return res.status(400).json({ error: "currencyName must be 1-30 characters." });
  }
  if (currencySymbol !== undefined && (typeof currencySymbol !== "string" || currencySymbol.length > 10)) {
    return res.status(400).json({ error: "currencySymbol must be at most 10 characters." });
  }
  if (startingBalance !== undefined && (typeof startingBalance !== "number" || startingBalance < 0 || startingBalance > 1000000)) {
    return res.status(400).json({ error: "startingBalance must be between 0 and 1,000,000." });
  }

  const { updateCoinSettings } = await import("../services/coins.js");
  const updated = await updateCoinSettings({ enabled, currencyName, currencySymbol, startingBalance });
  logActivity({ actorId: user.id, actorUsername: user.username, action: "settings.update", target: "Coin economy settings" });
  res.json(updated);
});

router.get("/coins/balance", async (req, res) => {
  const user = (req as any).user;
  const { getBalance, getCoinSettings } = await import("../services/coins.js");
  const settings = await getCoinSettings();
  if (!settings.enabled) return res.json({ balance: 0, enabled: false });
  const balance = await getBalance(user.id);
  res.json({ balance, enabled: true });
});

router.get("/coins/transactions", async (req, res) => {
  const user = (req as any).user;
  const { getTransactions } = await import("../services/coins.js");
  // Admins can view any user's ledger (for support/audit); everyone else
  // only their own.
  const targetUserId = (user.role === "admin" || user.role === "owner") && req.query.userId ? (req.query.userId as string) : user.id;
  const transactions = await getTransactions(targetUserId, 200);
  res.json(transactions);
});

router.post("/coins/grant", async (req, res) => {
  const admin = (req as any).user;
  if (admin.role !== "admin" && admin.role !== "owner") return res.status(403).json({ error: "Forbidden" });

  const { userId, amount, reason } = req.body;
  if (!userId || typeof amount !== "number" || amount <= 0 || amount > 1000000) {
    return res.status(400).json({ error: "Provide userId and a positive amount (max 1,000,000)." });
  }

  const { grantCoins } = await import("../services/coins.js");
  const result = await grantCoins(userId, amount, reason || "Admin grant", admin.id);
  if (!result.ok) return res.status(400).json({ error: result.error });

  logActivity({ actorId: admin.id, actorUsername: admin.username, action: "coins.grant", target: `+${amount} to user ${userId}` });

  try {
    const { notifyUser } = await import("../services/notifications.js");
    const settings = await (await import("../services/coins.js")).getCoinSettings();
    await notifyUser(userId, {
      type: "success",
      title: `${settings.currencyName} received`,
      message: `You received ${amount} ${settings.currencyName.toLowerCase()}${reason ? `: ${reason}` : "."}`,
    });
  } catch { /* best-effort */ }

  res.json(result);
});

router.post("/coins/deduct", async (req, res) => {
  const admin = (req as any).user;
  if (admin.role !== "admin" && admin.role !== "owner") return res.status(403).json({ error: "Forbidden" });

  const { userId, amount, reason } = req.body;
  if (!userId || typeof amount !== "number" || amount <= 0 || amount > 1000000) {
    return res.status(400).json({ error: "Provide userId and a positive amount (max 1,000,000)." });
  }

  const { deductCoins } = await import("../services/coins.js");
  const result = await deductCoins(userId, amount, reason || "Admin deduction", admin.id);
  if (!result.ok) return res.status(400).json({ error: result.error });

  logActivity({ actorId: admin.id, actorUsername: admin.username, action: "coins.deduct", target: `-${amount} from user ${userId}` });
  res.json(result);
});

router.get("/store/items", async (req, res) => {
  const user = (req as any).user;
  const isAdmin = user.role === "admin" || user.role === "owner";
  const { getStoreItems } = await import("../services/coins.js");
  res.json(await getStoreItems(isAdmin && req.query.all === "true"));
});

const VALID_GRANT_TYPES = ["maxServers", "maxRamGb", "maxCpuPercent", "maxDiskGb"];

router.post("/store/items", async (req, res) => {
  const admin = (req as any).user;
  if (admin.role !== "admin" && admin.role !== "owner") return res.status(403).json({ error: "Forbidden" });

  const { name, description, cost, grant, enabled } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "Name is required." });
  if (typeof cost !== "number" || cost <= 0) return res.status(400).json({ error: "Cost must be a positive number." });
  if (!grant || !VALID_GRANT_TYPES.includes(grant.type) || typeof grant.amount !== "number" || grant.amount <= 0) {
    return res.status(400).json({ error: `grant.type must be one of: ${VALID_GRANT_TYPES.join(", ")}, with a positive grant.amount.` });
  }

  const { createStoreItem } = await import("../services/coins.js");
  const item = await createStoreItem({
    name: name.trim(),
    description: (description || "").trim(),
    cost,
    grant,
    enabled: enabled !== false,
  });
  logActivity({ actorId: admin.id, actorUsername: admin.username, action: "store.item_create", target: item.name });
  res.json(item);
});

router.put("/store/items/:itemId", async (req, res) => {
  const admin = (req as any).user;
  if (admin.role !== "admin" && admin.role !== "owner") return res.status(403).json({ error: "Forbidden" });

  const { name, description, cost, grant, enabled } = req.body;
  if (cost !== undefined && (typeof cost !== "number" || cost <= 0)) return res.status(400).json({ error: "Cost must be a positive number." });
  if (grant !== undefined && (!VALID_GRANT_TYPES.includes(grant.type) || typeof grant.amount !== "number" || grant.amount <= 0)) {
    return res.status(400).json({ error: `grant.type must be one of: ${VALID_GRANT_TYPES.join(", ")}, with a positive grant.amount.` });
  }

  const { updateStoreItem } = await import("../services/coins.js");
  const updated = await updateStoreItem(req.params.itemId, { name, description, cost, grant, enabled });
  if (!updated) return res.status(404).json({ error: "Store item not found." });

  logActivity({ actorId: admin.id, actorUsername: admin.username, action: "store.item_update", target: updated.name });
  res.json(updated);
});

router.delete("/store/items/:itemId", async (req, res) => {
  const admin = (req as any).user;
  if (admin.role !== "admin" && admin.role !== "owner") return res.status(403).json({ error: "Forbidden" });

  const { getStoreItems, deleteStoreItem } = await import("../services/coins.js");
  const items = await getStoreItems(true);
  const existing = items.find((i) => i.id === req.params.itemId);
  if (!existing) return res.status(404).json({ error: "Store item not found." });

  await deleteStoreItem(req.params.itemId);
  logActivity({ actorId: admin.id, actorUsername: admin.username, action: "store.item_delete", target: existing.name });
  res.json({ success: true });
});

router.post("/store/purchase", async (req, res) => {
  const user = (req as any).user;
  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: "itemId is required." });

  const { getCoinSettings, purchaseStoreItem } = await import("../services/coins.js");
  const settings = await getCoinSettings();
  if (!settings.enabled) return res.status(403).json({ error: "The store isn't currently enabled." });

  const result = await purchaseStoreItem(user.id, itemId);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

export default router;
