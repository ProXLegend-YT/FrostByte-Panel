import express from "express";
import { login, register, logout, getMe, getUsers, changePassword, verifyLoginTwoFactor, setupTwoFactor, confirmTwoFactor, disableTwoFactor, regenerateRecoveryCodes } from "../controllers/auth.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.post("/login", login);
router.post("/register", register);
router.post("/logout", logout);
router.get("/me", requireAuth, getMe);
router.get("/users", requireAuth, getUsers);
router.put("/password", requireAuth, changePassword);

router.post("/2fa/verify-login", verifyLoginTwoFactor);
router.post("/2fa/setup", requireAuth, setupTwoFactor);
router.post("/2fa/confirm", requireAuth, confirmTwoFactor);
router.post("/2fa/disable", requireAuth, disableTwoFactor);
router.post("/2fa/recovery-codes/regenerate", requireAuth, regenerateRecoveryCodes);

export default router;
