import express from "express";
import jwt from "jsonwebtoken";
import { readJSON } from "../services/db.js";

const router = express.Router();
import authRoutes from "./auth.js";
import serverRoutes from "./servers.js";
import systemRoutes from "./system.js";
import apiKeyRoutes from "./api-keys.js";

router.use("/auth", authRoutes);
router.use("/servers", serverRoutes);
router.use("/system", systemRoutes);
router.use("/admin/api-keys", apiKeyRoutes);

router.get("/settings", async (req, res) => {
  const settings = await readJSON("settings.json") || {};
  res.json({ 
    panelName: settings.panelName || "FrostByte Panel",
    panelLogo: settings.panelLogo || "",
    panelBackgroundImage: settings.panelBackgroundImage || "",
    panelBackgroundBlur: settings.panelBackgroundBlur !== undefined ? settings.panelBackgroundBlur : 10,
    allowRegistration: settings.allowRegistration !== undefined ? settings.allowRegistration : true,
    // Only the boolean is public — the actual quota numbers (RAM/CPU/disk
    // caps) stay behind auth below, no reason to expose host capacity
    // details to an unauthenticated visitor.
    allowUserServerCreation: settings.allowUserServerCreation === true,
    enablePlayit: settings.enablePlayit === true,
    accentColor: settings.accentColor || "#0EA5E9",
  });
});

export default router;
