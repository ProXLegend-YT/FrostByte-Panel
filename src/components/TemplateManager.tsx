import React, { useEffect, useState } from "react";
import axios from "axios";
import { Layout, Plus, Trash2, X } from "lucide-react";

interface GameDef {
  id: string;
  name: string;
  category: string;
  subtypes?: { id: string; name: string }[];
  defaultRam: number;
  defaultCpu: number;
  defaultDisk: number;
}

interface Template {
  id: string;
  name: string;
  description: string;
  game: string;
  type: string;
  version: string;
  ram?: number;
  cpu?: number;
  disk?: number;
  startCommand: string;
  createdAt: string;
  createdBy: string;
}

export default function TemplateManager() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [games, setGames] = useState<GameDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [game, setGame] = useState("");
  const [type, setType] = useState("");
  const [version, setVersion] = useState("");
  const [ram, setRam] = useState("");
  const [cpu, setCpu] = useState("");
  const [disk, setDisk] = useState("");
  const [startCommand, setStartCommand] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const [tRes, gRes] = await Promise.all([
        axios.get("/api/system/templates"),
        axios.get("/api/system/games"),
      ]);
      setTemplates(tRes.data);
      setGames(gRes.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const resetForm = () => {
    setName(""); setDescription(""); setGame(""); setType(""); setVersion("");
    setRam(""); setCpu(""); setDisk(""); setStartCommand("");
    setError(null);
  };

  const selectedGameDef = games.find((g) => g.id === game);

  const handleCreate = async () => {
    setError(null);
    if (!name.trim() || !game) {
      setError("Name and game type are required.");
      return;
    }
    setSaving(true);
    try {
      await axios.post("/api/system/templates", {
        name: name.trim(),
        description: description.trim(),
        game,
        type,
        version,
        ram: ram ? Number(ram) : undefined,
        cpu: cpu ? Number(cpu) : undefined,
        disk: disk ? Number(disk) : undefined,
        startCommand,
      });
      resetForm();
      setShowForm(false);
      load();
    } catch (e: any) {
      setError(e.response?.data?.error || "Failed to create template.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this template? This won't affect servers already created from it.")) return;
    try {
      await axios.delete(`/api/system/templates/${id}`);
      load();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-sm uppercase tracking-wider text-zinc-500">
            Server Templates ({templates.length})
          </h3>
          <p className="text-xs text-zinc-500 mt-1">
            Presets users can pick from when creating a server, instead of configuring everything manually.
          </p>
        </div>
        <button
          onClick={() => { setShowForm((s) => !s); if (showForm) resetForm(); }}
          className="px-3 py-2 text-xs font-medium bg-accent hover:bg-accent-dark text-white rounded-lg transition-colors flex items-center gap-1.5 shrink-0"
        >
          {showForm ? <><X size={14} /> Cancel</> : <><Plus size={14} /> New Template</>}
        </button>
      </div>

      {showForm && (
        <div className="p-4 bg-white/[0.02] border border-white/5 rounded-xl space-y-4">
          {error && (
            <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Template Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Survival SMP"
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Game</label>
              <select
                value={game}
                onChange={(e) => { setGame(e.target.value); setType(""); }}
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-accent"
              >
                <option value="">Select a game...</option>
                {games.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Shown to users when picking this template"
              className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-accent"
            />
          </div>

          {selectedGameDef?.subtypes && selectedGameDef.subtypes.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-accent"
              >
                <option value="">Select...</option>
                {selectedGameDef.subtypes.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">Version (optional — leave blank for latest)</label>
            <input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="e.g. 1.21.11"
              className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-accent"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">
                RAM (GB){selectedGameDef && <span className="text-zinc-600"> — default {selectedGameDef.defaultRam}</span>}
              </label>
              <input
                type="number"
                value={ram}
                onChange={(e) => setRam(e.target.value)}
                placeholder={selectedGameDef ? String(selectedGameDef.defaultRam) : ""}
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">
                CPU (%){selectedGameDef && <span className="text-zinc-600"> — default {selectedGameDef.defaultCpu}</span>}
              </label>
              <input
                type="number"
                value={cpu}
                onChange={(e) => setCpu(e.target.value)}
                placeholder={selectedGameDef ? String(selectedGameDef.defaultCpu) : ""}
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">
                Disk (GB){selectedGameDef && <span className="text-zinc-600"> — default {selectedGameDef.defaultDisk}</span>}
              </label>
              <input
                type="number"
                value={disk}
                onChange={(e) => setDisk(e.target.value)}
                placeholder={selectedGameDef ? String(selectedGameDef.defaultDisk) : ""}
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          {game === "discord-bot" && (
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Start Command</label>
              <input
                value={startCommand}
                onChange={(e) => setStartCommand(e.target.value)}
                placeholder="e.g. node index.js"
                className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-accent font-mono"
              />
            </div>
          )}

          <button
            onClick={handleCreate}
            disabled={saving}
            className="w-full py-2.5 text-sm font-medium bg-accent hover:bg-accent-dark text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? "Creating..." : "Create Template"}
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-zinc-500">Loading templates...</p>
      ) : templates.length === 0 ? (
        <div className="text-center py-8 text-zinc-500 text-sm">
          <Layout className="w-8 h-8 mx-auto mb-2 text-zinc-600" />
          No templates yet. Create one so users can deploy servers faster.
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => {
            const gameDef = games.find((g) => g.id === t.game);
            return (
              <div key={t.id} className="flex items-center justify-between p-3.5 bg-white/[0.02] border border-white/5 rounded-xl hover:bg-white/[0.04] transition-colors">
                <div className="min-w-0">
                  <p className="font-medium text-white text-sm truncate">{t.name}</p>
                  <p className="text-xs text-zinc-500 truncate mt-0.5">
                    {gameDef?.name || t.game}{t.version ? ` · ${t.version}` : ""}{t.description ? ` — ${t.description}` : ""}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(t.id)}
                  className="p-1.5 text-zinc-500 bg-white/[0.03] border border-transparent hover:border-red-500/30 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all shrink-0 ml-3"
                  title="Delete template"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
