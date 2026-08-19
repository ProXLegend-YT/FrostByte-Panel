import React, { useEffect, useState, useRef } from "react";
import axios from "axios";
import { Globe, Play, Square, Loader2, Link as LinkIcon, RefreshCw, Copy, Check } from "lucide-react";

interface PlayitStatus {
  status: "running" | "stopped";
  claimLink: string | null;
  logs: string;
}

export default function PlayitTunnel({ serverId }: { serverId: string }) {
  const [data, setData] = useState<PlayitStatus>({ status: "stopped", claimLink: null, logs: "" });
  const [loading, setLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const fetchStatus = async () => {
    try {
      const res = await axios.get(`/api/servers/${serverId}/playit`);
      setData(res.data);
    } catch (e) {
      console.error("Failed to fetch Playit status", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [serverId]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [data.logs]);

  const handleStart = async () => {
    setIsProcessing(true);
    try {
      await axios.post(`/api/servers/${serverId}/playit/start`);
      await fetchStatus();
    } catch (e) {
      console.error("Failed to start tunnel", e);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStop = async () => {
    setIsProcessing(true);
    try {
      await axios.post(`/api/servers/${serverId}/playit/stop`);
      await fetchStatus();
    } catch (e) {
      console.error("Failed to stop tunnel", e);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReset = async () => {
    setIsProcessing(true);
    setShowResetConfirm(false);
    try {
      await axios.post(`/api/servers/${serverId}/playit/reset`);
      await fetchStatus();
    } catch (e) {
      console.error("Failed to reset tunnel", e);
    } finally {
      setIsProcessing(false);
    }
  };

  const copyLink = () => {
    if (!data.claimLink) return;
    navigator.clipboard.writeText(data.claimLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 p-10">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading Playit tunnel status...
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar p-4 md:p-6 text-white">
      <div className="max-w-4xl mx-auto space-y-6 md:space-y-8">
        <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
          <div>
            <h2 className="text-xl md:text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60 mb-1">
              Playit.gg Tunnel
            </h2>
            <p className="text-sm text-zinc-400">
              Expose this server to the internet without port forwarding, using playit.gg.
            </p>
          </div>
        </div>

        <div className="bg-white/[0.02] border border-white/5 p-5 md:p-6 rounded-xl flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4 w-full md:w-auto">
            <div className={`p-3 rounded-lg shrink-0 ${data.status === "running" ? "bg-emerald-400/10 text-emerald-300" : "bg-zinc-400/10 text-zinc-400"}`}>
              <Globe className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-white mb-0.5">
                Status: <span className={data.status === "running" ? "text-emerald-400" : "text-zinc-400"}>{data.status === "running" ? "Running" : "Stopped"}</span>
              </h3>
              <p className="text-xs text-zinc-400 leading-relaxed">
                {data.status === "running"
                  ? "Tunnel is active. Traffic to your playit.gg address is being forwarded to this server."
                  : "Start the tunnel to generate a claim link and begin forwarding traffic."}
              </p>
            </div>
          </div>

          {data.status === "running" ? (
            <button
              onClick={handleStop}
              disabled={isProcessing}
              className="w-full md:w-auto px-5 py-2.5 bg-red-500/90 hover:bg-red-600 border border-red-300/50 text-white font-medium rounded-lg transition-all shadow-lg flex items-center justify-center shrink-0 disabled:opacity-50"
            >
              {isProcessing ? <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Stopping...</> : <><Square className="w-4 h-4 mr-2" /> Stop Tunnel</>}
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={isProcessing}
              className="w-full md:w-auto px-5 py-2.5 bg-accent hover:bg-accent-dark border border-cyan-300/50 text-white font-medium rounded-lg transition-all shadow-lg flex items-center justify-center shrink-0 disabled:opacity-50"
            >
              {isProcessing ? <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Starting...</> : <><Play className="w-4 h-4 mr-2" /> Start Tunnel</>}
            </button>
          )}
        </div>

        {data.claimLink && (
          <div className="bg-cyan-400/[0.06] border border-cyan-400/20 p-5 rounded-xl">
            <h3 className="text-sm font-bold text-cyan-300 uppercase tracking-widest mb-3 flex items-center">
              <LinkIcon className="w-4 h-4 mr-2" /> Claim This Tunnel
            </h3>
            <p className="text-xs text-zinc-400 mb-3">
              Open this link and sign in with your playit.gg account to finish setup and get your public address.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-xs text-cyan-200">
                {data.claimLink}
              </code>
              <button
                onClick={copyLink}
                className="shrink-0 p-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-all"
                title="Copy link"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4 text-zinc-300" />}
              </button>
            </div>
          </div>
        )}

        <div>
          <h3 className="text-sm font-bold text-zinc-500 uppercase tracking-widest mb-4">Tunnel Logs</h3>
          <div
            ref={logRef}
            className="bg-black/40 border border-white/5 rounded-xl p-4 h-64 overflow-y-auto custom-scrollbar font-mono text-xs text-zinc-300 whitespace-pre-wrap"
          >
            {data.logs || "No logs yet. Start the tunnel to see output here."}
          </div>
        </div>

        <div className="border-t border-white/5 pt-6">
          {!showResetConfirm ? (
            <button
              onClick={() => setShowResetConfirm(true)}
              disabled={isProcessing}
              className="text-xs text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50"
            >
              Reset tunnel claim (unlinks this server from its current playit.gg account)
            </button>
          ) : (
            <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-4 flex flex-col md:flex-row md:items-center gap-3 justify-between">
              <p className="text-xs text-red-300">
                This will stop the tunnel and clear its claim. You'll need to claim it again with a new link.
              </p>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => setShowResetConfirm(false)}
                  className="px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleReset}
                  className="px-3 py-1.5 text-xs bg-red-500/90 hover:bg-red-600 border border-red-300/50 text-white rounded-lg transition-all"
                >
                  Confirm Reset
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
