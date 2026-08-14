import React, { useEffect, useState } from "react";
import axios from "axios";
import { Coins, Plus, Trash2, Pencil, X, Save, Power, Server, Cpu, MemoryStick, HardDrive } from "lucide-react";

interface CoinSettings {
  enabled: boolean;
  currencyName: string;
  currencySymbol: string;
  startingBalance: number;
}

interface StoreItem {
  id: string;
  name: string;
  description: string;
  cost: number;
  grant: { type: "maxServers" | "maxRamGb" | "maxCpuPercent" | "maxDiskGb"; amount: number };
  enabled: boolean;
}

const GRANT_TYPES: { value: StoreItem["grant"]["type"]; label: string; icon: React.ReactNode; unit: string }[] = [
  { value: "maxServers", label: "Extra server slots", icon: <Server className="w-3.5 h-3.5" />, unit: "server(s)" },
  { value: "maxRamGb", label: "Extra RAM", icon: <MemoryStick className="w-3.5 h-3.5" />, unit: "GB" },
  { value: "maxCpuPercent", label: "Extra CPU", icon: <Cpu className="w-3.5 h-3.5" />, unit: "%" },
  { value: "maxDiskGb", label: "Extra disk", icon: <HardDrive className="w-3.5 h-3.5" />, unit: "GB" },
];

const emptyItemDraft = { name: "", description: "", cost: 100, grantType: "maxRamGb" as StoreItem["grant"]["type"], grantAmount: 1, enabled: true };

// Admin-only configuration for the whole coin economy — this is the
// on/off switch and currency naming (settings), plus full CRUD on what
// coins can actually be spent on (the store). Everything here maps
// directly onto src/server/services/coins.ts, which already existed with
// a complete backend before this component was written; this is purely
// the missing frontend for it.
export default function CoinEconomySettings() {
  const [settings, setSettings] = useState<CoinSettings | null>(null);
  const [items, setItems] = useState<StoreItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);

  const [draft, setDraft] = useState({ currencyName: "", currencySymbol: "", startingBalance: 0 });

  const [showItemForm, setShowItemForm] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemDraft, setItemDraft] = useState(emptyItemDraft);
  const [savingItem, setSavingItem] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const [settingsRes, itemsRes] = await Promise.all([
        axios.get("/api/system/coins/settings"),
        axios.get("/api/system/store/items", { params: { all: "true" } }),
      ]);
      setSettings(settingsRes.data);
      setDraft({
        currencyName: settingsRes.data.currencyName,
        currencySymbol: settingsRes.data.currencySymbol,
        startingBalance: settingsRes.data.startingBalance,
      });
      setItems(itemsRes.data || []);
    } catch {
      /* leave settings null — render shows a light error state below */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggleEnabled = async () => {
    if (!settings) return;
    const next = !settings.enabled;
    setSettings({ ...settings, enabled: next });
    try {
      await axios.put("/api/system/coins/settings", { enabled: next });
    } catch {
      setSettings({ ...settings, enabled: !next }); // revert on failure
      alert("Failed to update — please try again.");
    }
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    try {
      const res = await axios.put("/api/system/coins/settings", draft);
      setSettings(res.data);
    } catch (e: any) {
      alert(e.response?.data?.error || "Failed to save settings.");
    } finally {
      setSavingSettings(false);
    }
  };

  const openNewItemForm = () => {
    setEditingItemId(null);
    setItemDraft(emptyItemDraft);
    setShowItemForm(true);
  };

  const openEditItemForm = (item: StoreItem) => {
    setEditingItemId(item.id);
    setItemDraft({
      name: item.name,
      description: item.description,
      cost: item.cost,
      grantType: item.grant.type,
      grantAmount: item.grant.amount,
      enabled: item.enabled,
    });
    setShowItemForm(true);
  };

  const saveItem = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingItem(true);
    const payload = {
      name: itemDraft.name.trim(),
      description: itemDraft.description.trim(),
      cost: itemDraft.cost,
      grant: { type: itemDraft.grantType, amount: itemDraft.grantAmount },
      enabled: itemDraft.enabled,
    };
    try {
      if (editingItemId) {
        const res = await axios.put(`/api/system/store/items/${editingItemId}`, payload);
        setItems((prev) => prev.map((i) => (i.id === editingItemId ? res.data : i)));
      } else {
        const res = await axios.post("/api/system/store/items", payload);
        setItems((prev) => [...prev, res.data]);
      }
      setShowItemForm(false);
    } catch (e: any) {
      alert(e.response?.data?.error || "Failed to save item.");
    } finally {
      setSavingItem(false);
    }
  };

  const deleteItem = async (item: StoreItem) => {
    if (!confirm(`Delete "${item.name}" from the store? This can't be undone.`)) return;
    try {
      await axios.delete(`/api/system/store/items/${item.id}`);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (e: any) {
      alert(e.response?.data?.error || "Failed to delete item.");
    }
  };

  if (loading) {
    return (
      <div className="bg-black/40 backdrop-blur-md border border-white/10 rounded-3xl p-6 md:p-10 mb-8 shadow-[0_0_50px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5">
        <div className="animate-pulse h-6 w-48 bg-white/10 rounded mb-4" />
        <div className="animate-pulse h-4 w-full max-w-md bg-white/5 rounded" />
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="bg-black/40 backdrop-blur-md border border-white/10 rounded-3xl p-6 md:p-10 mb-8 shadow-[0_0_50px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5">
        <p className="text-sm text-red-300">Couldn't load coin economy settings. <button onClick={load} className="underline">Retry</button></p>
      </div>
    );
  }

  return (
    <div className="bg-black/40 backdrop-blur-md border border-white/10 rounded-3xl p-6 md:p-10 mb-8 shadow-[0_0_50px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5 relative overflow-hidden">
      <div className="flex items-start justify-between flex-wrap gap-4 mb-6">
        <h2 className="text-xl font-bold flex items-center text-white">
          <Coins className="w-5 h-5 mr-3 text-amber-400" /> Coin Economy
        </h2>
        <button
          onClick={toggleEnabled}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
            settings.enabled
              ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20"
              : "bg-white/5 text-zinc-400 border border-white/10 hover:bg-white/10"
          }`}
        >
          <Power className="w-4 h-4" />
          {settings.enabled ? "Enabled" : "Disabled"}
        </button>
      </div>

      <p className="text-sm text-zinc-400 mb-6 max-w-2xl">
        Give users a spendable currency they earn or you grant manually, and let them redeem it for extra server slots, RAM, CPU, or disk — like a Pterodactyl-style credits/eco add-on, built in. Users only see coins and the store anywhere in the panel once this is turned on.
      </p>

      <form onSubmit={saveSettings} className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8 max-w-2xl">
        <div>
          <label className="block text-xs font-medium text-zinc-500 mb-1.5">Currency name</label>
          <input
            value={draft.currencyName}
            onChange={(e) => setDraft((d) => ({ ...d, currencyName: e.target.value }))}
            maxLength={30}
            className="w-full bg-white/[0.03] border border-white/10 focus:border-amber-500 focus:ring-1 focus:ring-amber-400/50 rounded-xl px-3 py-2 text-white text-sm outline-none"
            placeholder="Coins"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-500 mb-1.5">Symbol / short label</label>
          <input
            value={draft.currencySymbol}
            onChange={(e) => setDraft((d) => ({ ...d, currencySymbol: e.target.value }))}
            maxLength={10}
            className="w-full bg-white/[0.03] border border-white/10 focus:border-amber-500 focus:ring-1 focus:ring-amber-400/50 rounded-xl px-3 py-2 text-white text-sm outline-none"
            placeholder="coin"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-500 mb-1.5">Starting balance</label>
          <input
            type="number"
            min={0}
            max={1000000}
            value={draft.startingBalance}
            onChange={(e) => setDraft((d) => ({ ...d, startingBalance: Number(e.target.value) }))}
            className="w-full bg-white/[0.03] border border-white/10 focus:border-amber-500 focus:ring-1 focus:ring-amber-400/50 rounded-xl px-3 py-2 text-white text-sm outline-none"
          />
        </div>
        <div className="sm:col-span-3">
          <button
            type="submit"
            disabled={savingSettings}
            className="bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-semibold px-5 py-2 rounded-xl transition-all shadow-[0_0_15px_rgba(251,191,36,0.3)] active:scale-[0.98] text-sm"
          >
            {savingSettings ? "Saving..." : "Save Currency Settings"}
          </button>
        </div>
      </form>

      <div className="border-t border-white/5 pt-6">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-500">Store Items</h3>
          <button
            onClick={openNewItemForm}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/20 rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" /> Add Item
          </button>
        </div>

        {items.length === 0 ? (
          <p className="text-sm text-zinc-500 italic">No store items yet. Add one so users have something to spend {draft.currencyName.toLowerCase() || "coins"} on.</p>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const grantMeta = GRANT_TYPES.find((g) => g.value === item.grant.type);
              return (
                <div key={item.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-white/[0.02] border border-white/5 rounded-xl">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-white">{item.name}</p>
                      {!item.enabled && (
                        <span className="text-[10px] uppercase font-bold tracking-wider bg-white/5 text-zinc-500 px-2 py-0.5 rounded border border-white/10">Hidden</span>
                      )}
                    </div>
                    {item.description && <p className="text-xs text-zinc-500 mt-0.5">{item.description}</p>}
                    <div className="flex items-center gap-3 mt-1.5 text-xs text-zinc-400">
                      <span className="flex items-center gap-1 text-amber-300 font-semibold">{item.cost} {draft.currencySymbol || "coins"}</span>
                      <span className="flex items-center gap-1">{grantMeta?.icon} +{item.grant.amount} {grantMeta?.unit}</span>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => openEditItemForm(item)} className="p-2 text-zinc-400 hover:text-amber-300 bg-white/[0.03] hover:bg-amber-500/10 rounded-lg transition-colors">
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button onClick={() => deleteItem(item)} className="p-2 text-zinc-400 hover:text-red-400 bg-white/[0.03] hover:bg-red-500/10 rounded-lg transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showItemForm && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4" onClick={() => setShowItemForm(false)}>
          <div
            className="w-full sm:max-w-md max-h-[85vh] overflow-y-auto custom-scrollbar bg-[#0a0e18] border border-white/10 rounded-t-3xl sm:rounded-3xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-white/5 flex items-center justify-between sticky top-0 bg-[#0a0e18] z-10">
              <h3 className="font-semibold text-zinc-100">{editingItemId ? "Edit Store Item" : "New Store Item"}</h3>
              <button onClick={() => setShowItemForm(false)} className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-zinc-300">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={saveItem} className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-500 mb-1.5">Name</label>
                <input
                  required
                  value={itemDraft.name}
                  onChange={(e) => setItemDraft((d) => ({ ...d, name: e.target.value }))}
                  className="w-full bg-white/[0.03] border border-white/10 focus:border-amber-500 rounded-xl px-3 py-2 text-white text-sm outline-none"
                  placeholder="e.g. +1 Server Slot"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-500 mb-1.5">Description (optional)</label>
                <input
                  value={itemDraft.description}
                  onChange={(e) => setItemDraft((d) => ({ ...d, description: e.target.value }))}
                  className="w-full bg-white/[0.03] border border-white/10 focus:border-amber-500 rounded-xl px-3 py-2 text-white text-sm outline-none"
                  placeholder="Shown under the item name in the store"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-500 mb-1.5">Cost</label>
                  <input
                    required
                    type="number"
                    min={1}
                    value={itemDraft.cost}
                    onChange={(e) => setItemDraft((d) => ({ ...d, cost: Number(e.target.value) }))}
                    className="w-full bg-white/[0.03] border border-white/10 focus:border-amber-500 rounded-xl px-3 py-2 text-white text-sm outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-500 mb-1.5">Grant amount</label>
                  <input
                    required
                    type="number"
                    min={0.5}
                    step={0.5}
                    value={itemDraft.grantAmount}
                    onChange={(e) => setItemDraft((d) => ({ ...d, grantAmount: Number(e.target.value) }))}
                    className="w-full bg-white/[0.03] border border-white/10 focus:border-amber-500 rounded-xl px-3 py-2 text-white text-sm outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-500 mb-1.5">Grants</label>
                <div className="grid grid-cols-2 gap-2">
                  {GRANT_TYPES.map((g) => (
                    <button
                      key={g.value}
                      type="button"
                      onClick={() => setItemDraft((d) => ({ ...d, grantType: g.value }))}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
                        itemDraft.grantType === g.value
                          ? "bg-amber-500/15 border-amber-500/40 text-amber-300"
                          : "bg-white/[0.02] border-white/10 text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {g.icon} {g.label}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={itemDraft.enabled}
                  onChange={(e) => setItemDraft((d) => ({ ...d, enabled: e.target.checked }))}
                  className="w-4 h-4 rounded accent-amber-500"
                />
                <span className="text-sm text-zinc-300">Visible in the store</span>
              </label>

              <button
                type="submit"
                disabled={savingItem}
                className="w-full flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-semibold px-5 py-2.5 rounded-xl transition-all active:scale-[0.98]"
              >
                <Save className="w-4 h-4" /> {savingItem ? "Saving..." : editingItemId ? "Save Changes" : "Create Item"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
