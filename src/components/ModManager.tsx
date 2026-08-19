import React, { useEffect, useState } from "react"; 
import { LoadingOverlay } from "../components/LoadingOverlay";
import axios from "axios";
import { Search, Download, RefreshCw, AlertCircle, Box, Package, ChevronDown, X } from "lucide-react";

interface Mod {
  id: string;
  name: string;
  tag: string;
  downloads: number;
  icon: string | null;
}

interface Modpack {
  id: string;
  name: string;
  tag: string;
  downloads: number;
  icon: string | null;
  loaders: string[];
  gameVersions: string[];
}

interface ModpackVersion {
  versionId: string;
  versionNumber: string;
  name: string;
  gameVersions: string[];
  loaders: string[];
  datePublished: string;
}

export default function ModManager({ serverId }: { serverId: string }) {
  const [tab, setTab] = useState<"mods" | "modpacks">("mods");

  const [mods, setMods] = useState<Mod[]>([]);
  const [loading, setLoading] = useState(false);
  const [isInstalling, setIsInstalling] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const searchMods = async (searchQuery: string = "jei") => {
    try {
      setLoading(true);
      const q = searchQuery.trim() || 'jei';
      const res = await axios.get('/api/system/marketplace/mods', { params: { q } });
      setMods(res.data || []);
    } catch (e) {
      console.error(e);
      setMods([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "mods") searchMods();
  }, [tab]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    searchMods(query);
  };

  const handleInstall = async (mod: Mod) => {
    if (!confirm(`Are you sure you want to install ${mod.name}?`)) return;
    try {
      setIsInstalling(mod.id);
      
      const res = await axios.post(`/api/servers/${serverId}/mods/install`, {
        pluginId: mod.id,
        pluginName: mod.name
      });
      
      alert(res.data.message || `${mod.name} installed successfully! Restart the server to apply changes.`);
    } catch (e: any) {
      alert(e.response?.data?.error || "Failed to install mod.");
    } finally {
      setIsInstalling(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar p-4 md:p-8 text-white bg-transparent">
      <div className="max-w-4xl mx-auto space-y-6 md:space-y-8">
        
        <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
          <div>
            <h2 className="text-xl md:text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60 mb-1 flex items-center">
               <Box className="w-6 h-6 mr-2 text-emerald-400" /> Mod Manager
            </h2>
            <p className="text-[11px] font-bold text-accent-80 uppercase tracking-widest mt-1">
              {tab === "mods" ? "Search and install mods from Modrinth in one click." : "Install a full curated modpack in one click."}
            </p>
          </div>

          <div className="flex bg-white/[0.03] border border-white/10 rounded-xl p-1 shrink-0">
            <button
              onClick={() => setTab("mods")}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${tab === "mods" ? "bg-emerald-500 text-black" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              <Box className="w-3.5 h-3.5" /> Mods
            </button>
            <button
              onClick={() => setTab("modpacks")}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${tab === "modpacks" ? "bg-emerald-500 text-black" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              <Package className="w-3.5 h-3.5" /> Modpacks
            </button>
          </div>
        </div>

        {tab === "mods" ? (
          <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-3xl overflow-hidden shadow-[0_0_40px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5">
            <div className="p-4 border-b border-white/5 space-y-4">
              <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                  <input
                    type="text"
                    placeholder="Search for mods..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-full bg-white/[0.02] border border-white/10 rounded-lg py-2 pl-9 pr-4 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
                <button 
                  type="submit"
                  className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0"
                >
                  Search
                </button>
              </form>
            </div>
            
            <div className="divide-y divide-white/5">
              {loading ? (
                <div className="p-8 text-center text-zinc-500 flex flex-col items-center">
                  <RefreshCw className="w-6 h-6 animate-spin mb-3 text-emerald-500/50" />
                  Searching repositories...
                </div>
              ) : mods.length === 0 ? (
                <div className="p-8 text-center text-zinc-500 flex flex-col items-center">
                  <AlertCircle className="w-8 h-8 mb-3 text-zinc-600" />
                  No mods found.
                </div>
              ) : (
                mods.map((mod) => (
                  <div key={mod.id} className="p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 hover:bg-white/[0.01] transition-colors">
                    <div className="flex items-start gap-4 flex-1 min-w-0">
                      <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center shrink-0 overflow-hidden border border-white/5">
                        {mod.icon ? (
                           <img src={mod.icon} alt={mod.name} className="w-full h-full object-cover" />
                        ) : (
                           <Box className="w-5 h-5 text-zinc-500" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                           <h4 className="font-medium text-zinc-200 truncate">{mod.name}</h4>
                           <span className="px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider bg-white/5 text-zinc-400 flex items-center gap-1">
                              Modrinth
                           </span>
                        </div>
                        <p className="text-xs text-zinc-500 line-clamp-2 mt-1">{mod.tag}</p>
                        <div className="flex items-center gap-4 mt-2 text-[11px] text-zinc-500">
                          {mod.downloads > 0 && (
                            <span className="flex items-center gap-1" title="Downloads">
                              <Download className="w-3.5 h-3.5 text-zinc-600" />
                              {mod.downloads.toLocaleString()}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    <button
                      onClick={() => handleInstall(mod)}
                      disabled={isInstalling !== null}
                      className="w-full md:w-auto px-4 py-2 bg-white/5 hover:bg-emerald-500/10 border border-white/10 hover:border-emerald-500/30 text-zinc-300 hover:text-emerald-400 rounded-lg text-sm font-medium transition-all flex items-center justify-center shrink-0 disabled:opacity-50"
                    >
                      {isInstalling === mod.id ? (
                        <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Installing...</>
                      ) : (
                        <><Download className="w-4 h-4 mr-2" /> Install</>
                      )}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <ModpackBrowser serverId={serverId} />
        )}
      </div>
      
      {isInstalling !== null && <LoadingOverlay message="Installing mod..." />}
    </div>
  );
}

// --- Modpack browsing + install flow ---------------------------------
// A modpack install isn't a single-click download like an individual mod
// — a pack targets a specific Minecraft version + mod loader, and
// installing the wrong combination onto a running server just breaks it.
// So this is a two-step flow: pick a pack, then pick which published
// version of it to install (each version pins its own MC version +
// loader), then confirm. That matches how the Modrinth site itself
// presents packs, which people installing modpacks are already used to.
function ModpackBrowser({ serverId }: { serverId: string }) {
  const [packs, setPacks] = useState<Modpack[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedPack, setSelectedPack] = useState<Modpack | null>(null);
  const [versions, setVersions] = useState<ModpackVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<string | null>(null);

  const searchPacks = async (searchQuery: string = "") => {
    try {
      setLoading(true);
      const res = await axios.get('/api/system/marketplace/modpacks', { params: { q: searchQuery } });
      setPacks(res.data || []);
    } catch (e) {
      console.error(e);
      setPacks([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    searchPacks();
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    searchPacks(query);
  };

  const openPack = async (pack: Modpack) => {
    setSelectedPack(pack);
    setVersions([]);
    setInstallResult(null);
    try {
      setVersionsLoading(true);
      const res = await axios.get(`/api/system/marketplace/modpacks/${pack.id}/versions`);
      setVersions(res.data || []);
    } catch {
      setVersions([]);
    } finally {
      setVersionsLoading(false);
    }
  };

  const installVersion = async (version: ModpackVersion) => {
    if (!selectedPack) return;
    const loaderLabel = version.loaders?.[0] ? version.loaders[0][0].toUpperCase() + version.loaders[0].slice(1) : "";
    if (!confirm(
      `Install "${selectedPack.name}" (${version.versionNumber})?\n\n` +
      `Minecraft ${version.gameVersions?.[version.gameVersions.length - 1] || "?"} · ${loaderLabel}\n\n` +
      `This replaces your current mods folder (a backup is made automatically first) and requires the server to be stopped.`
    )) return;

    try {
      setInstalling(true);
      setInstallResult(null);
      const res = await axios.post(`/api/servers/${serverId}/modpack/install`, {
        projectId: selectedPack.id,
        versionId: version.versionId,
      });
      setInstallResult(res.data.message || "Modpack installed successfully.");
    } catch (e: any) {
      const msg = e.response?.data?.error || "Failed to install modpack.";
      setInstallResult(msg);
      alert(msg);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-3xl overflow-hidden shadow-[0_0_40px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5">
        <div className="p-4 border-b border-white/5 space-y-4">
          <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
              <input
                type="text"
                placeholder="Search modpacks (e.g. All the Mods, Better MC)..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full bg-white/[0.02] border border-white/10 rounded-lg py-2 pl-9 pr-4 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-accent transition-colors"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0"
            >
              Search
            </button>
          </form>
          <p className="text-[11px] text-zinc-500 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            Installing a pack replaces your mods folder. Your current mods are backed up automatically first.
          </p>
        </div>

        <div className="divide-y divide-white/5">
          {loading ? (
            <div className="p-8 text-center text-zinc-500 flex flex-col items-center">
              <RefreshCw className="w-6 h-6 animate-spin mb-3 text-emerald-500/50" />
              Searching modpacks...
            </div>
          ) : packs.length === 0 ? (
            <div className="p-8 text-center text-zinc-500 flex flex-col items-center">
              <AlertCircle className="w-8 h-8 mb-3 text-zinc-600" />
              No modpacks found.
            </div>
          ) : (
            packs.map((pack) => (
              <button
                key={pack.id}
                onClick={() => openPack(pack)}
                className="w-full text-left p-4 flex items-center justify-between gap-4 hover:bg-white/[0.01] transition-colors"
              >
                <div className="flex items-center gap-4 flex-1 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center shrink-0 overflow-hidden border border-white/5">
                    {pack.icon ? (
                      <img src={pack.icon} alt={pack.name} className="w-full h-full object-cover" />
                    ) : (
                      <Package className="w-5 h-5 text-zinc-500" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="font-medium text-zinc-200 truncate">{pack.name}</h4>
                      {pack.loaders?.map((l) => (
                        <span key={l} className="px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider bg-emerald-500/10 text-emerald-400">
                          {l}
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-zinc-500 line-clamp-2 mt-1">{pack.tag}</p>
                    <div className="flex items-center gap-4 mt-2 text-[11px] text-zinc-500">
                      {pack.downloads > 0 && (
                        <span className="flex items-center gap-1">
                          <Download className="w-3.5 h-3.5 text-zinc-600" />
                          {pack.downloads.toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <ChevronDown className="w-4 h-4 text-zinc-600 -rotate-90 shrink-0" />
              </button>
            ))
          )}
        </div>
      </div>

      {selectedPack && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4" onClick={() => !installing && setSelectedPack(null)}>
          <div
            className="w-full sm:max-w-lg max-h-[85vh] overflow-y-auto custom-scrollbar bg-[#0a0e18] border border-white/10 rounded-t-3xl sm:rounded-3xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-white/5 flex items-center justify-between sticky top-0 bg-[#0a0e18] z-10">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-white/5 flex items-center justify-center shrink-0 overflow-hidden border border-white/5">
                  {selectedPack.icon ? (
                    <img src={selectedPack.icon} alt={selectedPack.name} className="w-full h-full object-cover" />
                  ) : (
                    <Package className="w-4 h-4 text-zinc-500" />
                  )}
                </div>
                <h3 className="font-semibold text-zinc-100 truncate">{selectedPack.name}</h3>
              </div>
              <button
                onClick={() => !installing && setSelectedPack(null)}
                className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4">
              <p className="text-xs text-zinc-500 mb-4">Pick a version to install. Each version targets a specific Minecraft version and mod loader.</p>

              {versionsLoading ? (
                <div className="p-8 text-center text-zinc-500 flex flex-col items-center">
                  <RefreshCw className="w-6 h-6 animate-spin mb-3 text-emerald-500/50" />
                  Loading versions...
                </div>
              ) : versions.length === 0 ? (
                <div className="p-8 text-center text-zinc-500 flex flex-col items-center">
                  <AlertCircle className="w-8 h-8 mb-3 text-zinc-600" />
                  No installable versions found for this pack.
                </div>
              ) : (
                <div className="space-y-2">
                  {versions.map((v) => {
                    const loaderLabel = v.loaders?.[0] ? v.loaders[0][0].toUpperCase() + v.loaders[0].slice(1) : "Unknown loader";
                    const mcVersion = v.gameVersions?.[v.gameVersions.length - 1] || "?";
                    return (
                      <div key={v.versionId} className="p-3 rounded-xl bg-white/[0.02] border border-white/10 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-zinc-200 truncate">{v.name || v.versionNumber}</p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-accent-10 text-accent">MC {mcVersion}</span>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400">{loaderLabel}</span>
                          </div>
                        </div>
                        <button
                          onClick={() => installVersion(v)}
                          disabled={installing}
                          className="px-3 py-1.5 bg-white/5 hover:bg-emerald-500/10 border border-white/10 hover:border-emerald-500/30 text-zinc-300 hover:text-emerald-400 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 shrink-0 disabled:opacity-50"
                        >
                          {installing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                          Install
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {installResult && (
                <div className="mt-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-300">
                  {installResult}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {installing && <LoadingOverlay message="Installing modpack — this can take a few minutes for large packs..." />}
    </div>
  );
}
