import React, { useEffect, useState } from "react";
import axios from "axios";
import { Server, Plus, Trash2, X, Copy, Check, Cpu, MemoryStick, HardDrive } from "lucide-react";

interface FrostByteNode {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
  status: "online" | "offline";
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
  telemetry: {
    cpuPercent: number;
    ramUsedMb: number;
    ramTotalMb: number;
    diskUsedGb: number;
    diskTotalGb: number;
  } | null;
}

export default function NodeManager() {
  const [nodes, setNodes] = useState<FrostByteNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newNodeCredentials, setNewNodeCredentials] = useState<{ nodeId: string; secret: string; panelUrl: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await axios.get("/api/system/nodes");
      setNodes(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Nodes report a heartbeat every 15s; poll a bit slower than that so
    // the list stays reasonably fresh without hammering the API.
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleCreate = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Node name is required.");
      return;
    }
    setSaving(true);
    try {
      const res = await axios.post("/api/system/nodes", { name: name.trim() });
      setNewNodeCredentials({
        nodeId: res.data.node.id,
        secret: res.data.secret,
        panelUrl: window.location.origin,
      });
      setName("");
      setShowForm(false);
      load();
    } catch (e: any) {
      setError(e.response?.data?.error || "Failed to create node.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, nodeName: string) => {
    if (!confirm(`Remove node "${nodeName}"? The agent running there will lose its connection to this panel.`)) return;
    try {
      await axios.delete(`/api/system/nodes/${id}`);
      load();
    } catch (e) {
      console.error(e);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  const installCommand = newNodeCredentials
    ? `PANEL_URL=${newNodeCredentials.panelUrl} NODE_ID=${newNodeCredentials.nodeId} NODE_SECRET=${newNodeCredentials.secret} node agent.js`
    : "";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-sm uppercase tracking-wider text-zinc-500">
            Nodes ({nodes.length})
          </h3>
          <p className="text-xs text-zinc-500 mt-1">
            Remote machines connected to this panel via the FrostByte Agent. Nodes report live telemetry but can't yet host servers directly — that's a future step.
          </p>
        </div>
        <button
          onClick={() => { setShowForm((s) => !s); setError(null); }}
          className="px-3 py-2 text-xs font-medium bg-accent hover:bg-accent-dark text-white rounded-lg transition-colors flex items-center gap-1.5 shrink-0"
        >
          {showForm ? <><X size={14} /> Cancel</> : <><Plus size={14} /> New Node</>}
        </button>
      </div>

      {newNodeCredentials && (
        <div className="p-4 bg-accent-10 border border-accent-30 rounded-xl space-y-3">
          <div className="flex items-start justify-between">
            <h4 className="text-sm font-semibold text-white">Node created — set up the agent now</h4>
            <button onClick={() => setNewNodeCredentials(null)} className="text-zinc-500 hover:text-white shrink-0 ml-2">
              <X size={16} />
            </button>
          </div>
          <p className="text-xs text-zinc-400">
            This secret is shown <strong className="text-zinc-300">only once</strong>. Copy the command below and run it on the node's VPS (inside the <code className="text-accent-light">agent/</code> folder from the panel repo, after <code className="text-accent-light">npm install</code>).
          </p>
          <div className="flex items-start gap-2">
            <code className="flex-1 min-w-0 break-all bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-accent-light font-mono">
              {installCommand}
            </code>
            <button
              onClick={() => copyToClipboard(installCommand, "install")}
              className="shrink-0 p-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-all"
            >
              {copied === "install" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4 text-zinc-300" />}
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <div className="p-4 bg-white/[0.02] border border-white/5 rounded-xl space-y-3">
          {error && (
            <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">Node Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Frankfurt VPS"
              className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-accent"
            />
          </div>
          <button
            onClick={handleCreate}
            disabled={saving}
            className="w-full py-2.5 text-sm font-medium bg-accent hover:bg-accent-dark text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? "Creating..." : "Create Node"}
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-zinc-500">Loading nodes...</p>
      ) : nodes.length === 0 ? (
        <div className="text-center py-8 text-zinc-500 text-sm">
          <Server className="w-8 h-8 mx-auto mb-2 text-zinc-600" />
          No nodes registered yet.
        </div>
      ) : (
        <div className="space-y-2">
          {nodes.map((n) => (
            <div key={n.id} className="p-3.5 bg-white/[0.02] border border-white/5 rounded-xl">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`relative inline-flex rounded-full h-2 w-2 shrink-0 ${n.status === "online" ? "bg-emerald-500" : "bg-zinc-600"}`} />
                  <p className="font-medium text-white text-sm truncate">{n.name}</p>
                  <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 ${n.status === "online" ? "bg-emerald-500/10 text-emerald-400" : "bg-zinc-500/10 text-zinc-500"}`}>
                    {n.status}
                  </span>
                </div>
                <button
                  onClick={() => handleDelete(n.id, n.name)}
                  className="p-1.5 text-zinc-500 bg-white/[0.03] border border-transparent hover:border-red-500/30 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all shrink-0 ml-3"
                  title="Remove node"
                >
                  <Trash2 size={16} />
                </button>
              </div>
              {n.telemetry ? (
                <div className="grid grid-cols-3 gap-2 mt-2">
                  <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                    <Cpu size={12} className="text-accent-light shrink-0" />
                    {n.telemetry.cpuPercent}%
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                    <MemoryStick size={12} className="text-accent-light shrink-0" />
                    {(n.telemetry.ramUsedMb / 1024).toFixed(1)}/{(n.telemetry.ramTotalMb / 1024).toFixed(1)}GB
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                    <HardDrive size={12} className="text-accent-light shrink-0" />
                    {n.telemetry.diskUsedGb}/{n.telemetry.diskTotalGb}GB
                  </div>
                </div>
              ) : (
                <p className="text-xs text-zinc-600 mt-1">Waiting for agent to connect...</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
