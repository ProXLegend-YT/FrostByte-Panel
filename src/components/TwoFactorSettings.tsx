import React, { useState } from "react";
import axios from "axios";
import { ShieldCheck, ShieldOff, Copy, Check, AlertTriangle, RefreshCw } from "lucide-react";

// Self-contained enable/disable flow for TOTP two-factor auth. Enrollment
// is three steps, not instant-on: request a secret -> scan/enter it in an
// authenticator app -> confirm with a real generated code. Only the last
// step actually flips twoFactorEnabled on the account, so a botched setup
// (wrong secret copied, app not installed yet) never locks anyone out —
// the account just stays on password-only until confirm succeeds.
export default function TwoFactorSettings({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
  const [stage, setStage] = useState<"idle" | "setup" | "disable">("idle");
  const [secret, setSecret] = useState("");
  const [otpauthUri, setOtpauthUri] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const startSetup = async () => {
    setError("");
    setLoading(true);
    try {
      const res = await axios.post("/api/auth/2fa/setup");
      setSecret(res.data.secret);
      setOtpauthUri(res.data.otpauthUri);
      setStage("setup");
    } catch (e: any) {
      setError(e.response?.data?.error || "Failed to start setup.");
    } finally {
      setLoading(false);
    }
  };

  const confirmSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await axios.post("/api/auth/2fa/confirm", { code: confirmCode });
      setRecoveryCodes(res.data.recoveryCodes);
      setConfirmCode("");
    } catch (e: any) {
      setError(e.response?.data?.error || "Verification failed.");
    } finally {
      setLoading(false);
    }
  };

  const finishAfterRecoveryCodes = () => {
    setStage("idle");
    setRecoveryCodes(null);
    setSecret("");
    setOtpauthUri("");
    onChanged();
  };

  const handleDisable = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await axios.post("/api/auth/2fa/disable", { password: disablePassword });
      setDisablePassword("");
      setStage("idle");
      onChanged();
    } catch (e: any) {
      setError(e.response?.data?.error || "Failed to disable 2FA.");
    } finally {
      setLoading(false);
    }
  };

  const copySecret = () => {
    navigator.clipboard.writeText(secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // Recovery codes shown once, right after enabling — same pattern as
  // GitHub/Google. This screen takes over regardless of `stage` since it
  // matters more than any other state at this moment.
  if (recoveryCodes) {
    return (
      <div className="relative z-10 border-t border-white/5 pt-6">
        <h3 className="text-lg font-semibold text-white mb-2 flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-emerald-400" /> Two-factor authentication enabled
        </h3>
        <p className="text-sm text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 mb-4 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          Save these recovery codes somewhere safe. Each one can be used once to sign in if you lose access to your authenticator app. They won't be shown again.
        </p>
        <div className="grid grid-cols-2 gap-2 font-mono text-sm bg-black/40 border border-white/10 rounded-xl p-4 mb-4">
          {recoveryCodes.map((c) => (
            <div key={c} className="text-zinc-300">{c}</div>
          ))}
        </div>
        <button
          onClick={finishAfterRecoveryCodes}
          className="bg-accent hover:bg-accent-dark text-white font-semibold px-6 py-2.5 rounded-xl transition-all shadow-[0_0_15px_rgba(56,189,248,0.3)] active:scale-[0.98]"
        >
          I've saved these codes
        </button>
      </div>
    );
  }

  if (stage === "setup") {
    return (
      <div className="relative z-10 border-t border-white/5 pt-6">
        <h3 className="text-lg font-semibold text-white mb-4">Set up two-factor authentication</h3>
        <p className="text-sm text-zinc-400 mb-3">
          Add this key to an authenticator app (Google Authenticator, Authy, 1Password, etc.), then enter the 6-digit code it generates.
        </p>
        <div className="flex items-center gap-2 bg-black/40 border border-white/10 rounded-xl px-4 py-3 mb-4 max-w-md">
          <code className="text-cyan-300 font-mono text-sm break-all flex-1">{secret}</code>
          <button onClick={copySecret} className="shrink-0 p-1.5 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-zinc-200 transition-colors">
            {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>

        <form onSubmit={confirmSetup} className="max-w-md">
          {error && <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-3">{error}</div>}
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              required
              value={confirmCode}
              onChange={(e) => setConfirmCode(e.target.value)}
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="123456"
              autoFocus
              className="flex-1 min-w-0 bg-white/[0.03] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-2.5 text-white font-mono transition-all shadow-inner outline-none"
            />
            <button
              type="submit"
              disabled={loading || confirmCode.length !== 6}
              className="w-full sm:w-auto bg-accent hover:bg-accent-dark disabled:opacity-50 text-white font-semibold px-6 py-2.5 rounded-xl transition-all shadow-[0_0_15px_rgba(56,189,248,0.3)] active:scale-[0.98] whitespace-nowrap"
            >
              {loading ? "Verifying..." : "Verify & Enable"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => { setStage("idle"); setError(""); }}
            className="text-xs text-zinc-500 hover:text-zinc-300 mt-3 transition-colors"
          >
            Cancel
          </button>
        </form>
      </div>
    );
  }

  if (stage === "disable") {
    return (
      <div className="relative z-10 border-t border-white/5 pt-6">
        <h3 className="text-lg font-semibold text-white mb-4">Disable two-factor authentication</h3>
        <form onSubmit={handleDisable} className="max-w-md">
          {error && <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-3">{error}</div>}
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              required
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
              type="password"
              placeholder="Confirm your password"
              autoFocus
              className="flex-1 min-w-0 bg-white/[0.03] border border-white/10 focus:border-red-500 focus:ring-1 focus:ring-red-400/50 rounded-xl px-4 py-2.5 text-white transition-all shadow-inner outline-none"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full sm:w-auto bg-red-500/20 hover:bg-red-500/30 disabled:opacity-50 text-red-300 font-semibold px-6 py-2.5 rounded-xl border border-red-500/30 transition-all active:scale-[0.98] whitespace-nowrap"
            >
              {loading ? "Disabling..." : "Disable"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => { setStage("idle"); setError(""); setDisablePassword(""); }}
            className="text-xs text-zinc-500 hover:text-zinc-300 mt-3 transition-colors"
          >
            Cancel
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="relative z-10 border-t border-white/5 pt-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-semibold text-white mb-1 flex items-center gap-2">
            {enabled ? <ShieldCheck className="w-5 h-5 text-emerald-400" /> : <ShieldOff className="w-5 h-5 text-zinc-500" />}
            Two-Factor Authentication
          </h3>
          <p className="text-sm text-zinc-400">
            {enabled
              ? "Your account requires a code from your authenticator app to sign in."
              : "Add an extra layer of security — a code from an authenticator app is required at sign in."}
          </p>
        </div>
        {enabled ? (
          <button
            onClick={() => setStage("disable")}
            className="bg-white/5 hover:bg-red-500/10 text-zinc-300 hover:text-red-300 font-medium px-5 py-2 rounded-xl border border-white/10 hover:border-red-500/30 transition-all whitespace-nowrap"
          >
            Disable
          </button>
        ) : (
          <button
            onClick={startSetup}
            disabled={loading}
            className="bg-accent hover:bg-accent-dark disabled:opacity-50 text-white font-semibold px-5 py-2 rounded-xl transition-all shadow-[0_0_15px_rgba(56,189,248,0.3)] active:scale-[0.98] whitespace-nowrap flex items-center gap-2"
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
            {loading ? "Starting..." : "Enable"}
          </button>
        )}
      </div>
      {error && <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mt-3 max-w-md">{error}</div>}
    </div>
  );
}
