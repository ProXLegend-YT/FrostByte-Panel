import React, { useEffect, useState } from "react";
import { LoadingOverlay } from "../components/LoadingOverlay";
import axios from "axios";
import { useNavigate, Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Server, ArrowLeft, ArrowRight, Cpu, HardDrive, MemoryStick, Globe, User,
  AlertTriangle, Sparkles, Check, Zap, Box, FastForward, Network, Wrench,
  Feather, CheckCircle2, Bot, Gamepad2, Blocks, KeyRound, Terminal,
  Swords, Pickaxe, Skull, PawPrint, Crosshair,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import SearchableDropdown from "../components/SearchableDropdown";

interface GameDef {
  id: string;
  name: string;
  category: string;
  description: string;
  subtypes?: { id: string; name: string; description: string; isProxy?: boolean }[];
  defaultRam: number;
  defaultCpu: number;
  defaultDisk: number;
  supportsRcon: boolean;
}

const GAME_ICONS: Record<string, React.ElementType> = {
  minecraft: Blocks,
  "discord-bot": Bot,
  rust: Wrench,
  valheim: Swords,
  terraria: Pickaxe,
  ark: Skull,
  palworld: PawPrint,
  cs2: Crosshair,
};

const MINECRAFT_SUBTYPE_META: Record<string, { icon: React.ElementType; color: string; bg: string; border: string; ring: string; glow: string }> = {
  PAPER: { icon: Zap, color: "text-amber-400", bg: "bg-amber-400/10", border: "border-amber-400/20", ring: "ring-amber-500/50", glow: "to-amber-500/10" },
  FORGE: { icon: Wrench, color: "text-stone-400", bg: "bg-stone-400/10", border: "border-stone-400/20", ring: "ring-stone-500/50", glow: "to-stone-500/10" },
  FABRIC: { icon: Feather, color: "text-amber-200", bg: "bg-amber-200/10", border: "border-amber-200/20", ring: "ring-amber-300/50", glow: "to-amber-300/10" },
  VANILLA: { icon: Box, color: "text-emerald-400", bg: "bg-emerald-400/10", border: "border-emerald-400/20", ring: "ring-emerald-500/50", glow: "to-emerald-500/10" },
  VELOCITY: { icon: FastForward, color: "text-cyan-400", bg: "bg-cyan-400/10", border: "border-cyan-400/20", ring: "ring-cyan-500/50", glow: "to-cyan-500/10" },
  BUNGEECORD: { icon: Network, color: "text-orange-400", bg: "bg-orange-400/10", border: "border-orange-400/20", ring: "ring-orange-500/50", glow: "to-orange-500/10" },
};

export default function CreateServer() {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [templates, setTemplates] = useState<any[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [games, setGames] = useState<GameDef[]>([]);
  const [loadingGames, setLoadingGames] = useState(true);
  const [selectedGame, setSelectedGame] = useState<GameDef | null>(null);

  const [name, setName] = useState("");
  const [ram, setRam] = useState<string>("4");
  const [cpu, setCpu] = useState<string>("150");
  const [disk, setDisk] = useState<string>("10");
  const [port, setPort] = useState<string>("25565");
  const [ipAlias, setIpAlias] = useState<string>("");
  const [type, setType] = useState<string>("");
  const [version, setVersion] = useState("");
  const [owner, setOwner] = useState("");
  const [discordToken, setDiscordToken] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [serverPassword, setServerPassword] = useState("");
  const [srcdsToken, setSrcdsToken] = useState("");
  const [versions, setVersions] = useState<string[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [createProgress, setCreateProgress] = useState(0);
  const [totalSystemRam, setTotalSystemRam] = useState<number>(0);
  const [showRamWarning, setShowRamWarning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useNavigate();
  const { user, isAdmin } = useAuth();

  const ramPresets = [2, 4, 8, 16, 24, 32, 48, 64];
  // Non-admins are capped to whatever an admin granted them — filter presets
  // down and clamp free entry so they can't even attempt an over-cap value
  // client-side (the backend enforces this regardless, but this avoids a
  // confusing rejection after filling out the whole form).
  const userRamCap = isAdmin ? Infinity : (user?.maxRamGb ?? 4);
  const visibleRamPresets = ramPresets.filter(v => v <= userRamCap);

  useEffect(() => {
    axios.get("/api/system/games").then((res) => {
      setGames(res.data);
      setLoadingGames(false);
    }).catch(() => setLoadingGames(false));

    axios.get("/api/system/templates").then((res) => {
      setTemplates(res.data);
      setLoadingTemplates(false);
    }).catch(() => setLoadingTemplates(false));

    axios.get("/api/system/stats").then((res) => {
      setTotalSystemRam(res.data.totalMemory / (1024 * 1024 * 1024));
    }).catch(() => {});

    if (isAdmin) {
      axios.get("/api/auth/users").then((res) => {
        setUsers(res.data);
        if (res.data.length > 0) {
          const defaultOwner = res.data.find((u: any) => u.id === user?.id)?.id || res.data[0].id;
          setOwner(defaultOwner);
        }
      }).catch(() => {});
    } else if (user?.id) {
      // Normal users always own what they create — no picker needed.
      setOwner(user.id);
    }
  }, [user, isAdmin]);

  const selectGame = (game: GameDef, template?: any) => {
    setSelectedGame(game);
    const ramCap = isAdmin ? Infinity : (user?.maxRamGb ?? 4);
    const cpuCap = isAdmin ? Infinity : (user?.maxCpuPercent ?? 200);
    const diskCap = isAdmin ? Infinity : (user?.maxDiskGb ?? 10);
    setRam(Math.min(template?.ram ?? game.defaultRam, ramCap).toString());
    setCpu(Math.min(template?.cpu ?? game.defaultCpu, cpuCap).toString());
    setDisk(Math.min(template?.disk ?? game.defaultDisk, diskCap).toString());
    setPort(game.id === "minecraft" ? "25565" : "");
    if (template?.type) {
      setType(template.type);
    } else if (game.subtypes && game.subtypes.length > 0) {
      setType(game.subtypes[0].id);
    } else {
      setType("");
    }
    if (template?.version) setVersion(template.version);
    if (template?.startCommand) setStartCommand(template.startCommand);
    setError(null);
    setStep(2);
  };

  const selectTemplate = (template: any) => {
    const game = games.find((g) => g.id === template.game);
    if (!game) return;
    selectGame(game, template);
  };

  useEffect(() => {
    if (!selectedGame) return;
    axios.get(`/api/system/versions?game=${selectedGame.id}&type=${type}`).then((res) => {
      setVersions(res.data);
      if (res.data.length > 0) setVersion(res.data[0]);
    });
  }, [selectedGame, type]);

  const handleRamSelect = (val: number) => {
    setRam(val.toString());
    if (selectedGame?.id !== "minecraft") return;
    let autoCpu = 100;
    if (val <= 2) autoCpu = 100;
    else if (val <= 4) autoCpu = 150;
    else if (val <= 8) autoCpu = 200;
    else if (val <= 16) autoCpu = 300;
    else if (val <= 24) autoCpu = 400;
    else if (val <= 32) autoCpu = 500;
    else if (val <= 48) autoCpu = 600;
    else if (val <= 64) autoCpu = 800;
    setCpu(autoCpu.toString());
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (totalSystemRam > 0 && Number(ram) > totalSystemRam && !showRamWarning) {
      setShowRamWarning(true);
      return;
    }
    executeSubmit();
  };

  const executeSubmit = async () => {
    setShowRamWarning(false);
    setLoading(true);
    setCreateProgress(0);
    setError(null);

    const interval = setInterval(() => {
      setCreateProgress((prev) => {
        if (prev >= 90) { clearInterval(interval); return 90; }
        return prev + (Math.random() * 8 + 2);
      });
    }, 300);

    try {
      const payload: any = {
        name,
        ram: Number(ram),
        cpu: Number(cpu),
        disk: Number(disk),
        port: Number(port),
        ipAlias,
        game: selectedGame?.id,
        type,
        version,
      };
      if (owner) payload.owner = owner;
      if (selectedGame?.id === "discord-bot") {
        payload.discordToken = discordToken;
        payload.startCommand = startCommand;
      }
      if (["rust", "valheim", "ark", "palworld"].includes(selectedGame?.id || "")) {
        payload.serverPassword = serverPassword;
      }
      if (selectedGame?.id === "cs2") {
        payload.srcdsToken = srcdsToken;
      }

      await axios.post("/api/servers", payload);
      clearInterval(interval);
      setCreateProgress(100);
      setTimeout(() => navigate("/servers"), 800);
    } catch (e: any) {
      clearInterval(interval);
      setCreateProgress(0);
      setError(e.response?.data?.error || "Failed to create server instance");
      setLoading(false);
    }
  };

  const isProxySubtype = selectedGame?.subtypes?.find(s => s.id === type)?.isProxy;

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -15 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="p-5 md:p-10 max-w-3xl mx-auto"
    >
      <div className="mb-8">
        <Link to="/servers" className="inline-flex items-center text-sm font-medium text-zinc-400 hover:text-white transition-colors mb-4">
          <ArrowLeft size={16} className="mr-2" /> Back to Instances
        </Link>
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white mb-2">Deploy New Server</h1>
        <p className="text-zinc-400">
          {step === 0 ? "Start from a template, or configure a server from scratch." : step === 1 ? "Choose what you'd like to deploy." : `Configure your ${selectedGame?.name} server.`}
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-3 mb-8">
        <div className={`flex items-center gap-2 ${step >= 0 ? "text-cyan-300" : "text-zinc-600"}`}>
          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border ${step >= 0 ? "bg-cyan-400/20 border-cyan-400/40" : "border-white/10"}`}>
            {step > 0 ? <Check size={14} /> : "1"}
          </div>
          <span className="text-sm font-semibold hidden sm:inline">Template</span>
        </div>
        <div className={`flex-1 h-px ${step >= 1 ? "bg-cyan-400/40" : "bg-white/10"}`} />
        <div className={`flex items-center gap-2 ${step >= 1 ? "text-cyan-300" : "text-zinc-600"}`}>
          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border ${step >= 1 ? "bg-cyan-400/20 border-cyan-400/40" : "border-white/10"}`}>
            {step > 1 ? <Check size={14} /> : "2"}
          </div>
          <span className="text-sm font-semibold hidden sm:inline">Choose Game</span>
        </div>
        <div className={`flex-1 h-px ${step >= 2 ? "bg-cyan-400/40" : "bg-white/10"}`} />
        <div className={`flex items-center gap-2 ${step >= 2 ? "text-cyan-300" : "text-zinc-600"}`}>
          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border ${step >= 2 ? "bg-cyan-400/20 border-cyan-400/40" : "border-white/10"}`}>
            2
          </div>
          <span className="text-sm font-semibold hidden sm:inline">Configure</span>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {step === 0 && (
          <motion.div
            key="step0"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.25 }}
          >
            {loadingTemplates ? (
              <div className="flex justify-center py-20">
                <div className="w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : templates.length === 0 ? (
              <div className="text-center py-4">
                <p className="text-zinc-400 mb-6">No templates have been set up yet.</p>
                <button
                  onClick={() => setStep(1)}
                  className="px-6 py-3 bg-accent hover:bg-accent-dark text-white font-semibold rounded-xl transition-colors"
                >
                  Configure a Server from Scratch
                </button>
              </div>
            ) : (
              <div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                  {templates.map((t) => {
                    const gameDef = games.find((g) => g.id === t.game);
                    const Icon = GAME_ICONS[t.game] || Gamepad2;
                    return (
                      <button
                        key={t.id}
                        onClick={() => selectTemplate(t)}
                        className="text-left bg-black/40 glass-panel border border-white/10 hover:border-cyan-400/40 rounded-2xl p-6 transition-all group relative overflow-hidden"
                      >
                        <div className="w-12 h-12 rounded-xl bg-black/60 border border-white/10 flex items-center justify-center mb-4 group-hover:border-cyan-400/40 group-hover:bg-cyan-400/10 transition-all relative z-10">
                          <Icon className="w-6 h-6 text-zinc-400 group-hover:text-cyan-300 transition-colors" />
                        </div>
                        <h3 className="text-lg font-bold text-white group-hover:text-cyan-300 transition-colors relative z-10">{t.name}</h3>
                        <p className="text-sm text-zinc-500 mt-1 relative z-10">
                          {t.description || `${gameDef?.name || t.game}${t.version ? ` · ${t.version}` : ""}`}
                        </p>
                        <div className="mt-4 flex items-center text-xs font-semibold text-cyan-400/80 relative z-10">
                          Use Template <ArrowRight size={13} className="ml-1 group-hover:translate-x-1 transition-transform" />
                        </div>
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={() => setStep(1)}
                  className="w-full text-center py-3 text-sm text-zinc-400 hover:text-white border border-white/10 hover:border-white/20 rounded-xl transition-colors"
                >
                  Or configure a server from scratch
                </button>
              </div>
            )}
          </motion.div>
        )}

        {step === 1 && (
          <motion.div
            key="step1"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.25 }}
          >
            {loadingGames ? (
              <div className="flex justify-center py-20">
                <div className="w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {games.map((game) => {
                  const Icon = GAME_ICONS[game.id] || Gamepad2;
                  return (
                    <button
                      key={game.id}
                      onClick={() => selectGame(game)}
                      className="text-left bg-black/40 glass-panel border border-white/10 hover:border-cyan-400/40 rounded-2xl p-6 transition-all group relative overflow-hidden"
                    >
                      <div className="absolute inset-0 bg-gradient-to-br from-cyan-400/0 to-transparent opacity-0 group-hover:opacity-10 transition-opacity" />
                      <div className="w-12 h-12 rounded-xl bg-black/60 border border-white/10 flex items-center justify-center mb-4 group-hover:border-cyan-400/40 group-hover:bg-cyan-400/10 transition-all relative z-10">
                        <Icon className="w-6 h-6 text-zinc-400 group-hover:text-cyan-300 transition-colors" />
                      </div>
                      <h3 className="text-lg font-bold text-white group-hover:text-cyan-300 transition-colors relative z-10">{game.name}</h3>
                      <p className="text-sm text-zinc-500 mt-1 relative z-10">{game.description}</p>
                      <div className="mt-4 flex items-center text-xs font-semibold text-cyan-400/80 relative z-10">
                        Select <ArrowRight size={13} className="ml-1 group-hover:translate-x-1 transition-transform" />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}

        {step === 2 && selectedGame && (
          <motion.div
            key="step2"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.25 }}
          >
            <button
              onClick={() => setStep(1)}
              className="inline-flex items-center text-xs font-medium text-zinc-500 hover:text-cyan-300 transition-colors mb-4"
            >
              <ArrowLeft size={13} className="mr-1.5" /> Change game ({selectedGame.name})
            </button>

            <form onSubmit={handleSubmit} className="bg-[#0a0a0c] glass-panel p-6 md:p-8 rounded-2xl border border-white/5 shadow-2xl relative">
              <div className="absolute inset-0 overflow-hidden rounded-2xl pointer-events-none">
                <div className="absolute top-0 right-0 w-64 h-64 bg-cyan-400/5 blur-[60px] rounded-full" />
              </div>

              <div className="space-y-8 relative z-10">
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                    <Server className="w-4 h-4 mr-2 text-cyan-300" /> Instance Name
                  </label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="My awesome server"
                    className="w-full bg-white/[0.02] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-3 text-white transition-all shadow-inner outline-none"
                  />
                </div>

                {/* Software / subtype picker */}
                {selectedGame.subtypes && selectedGame.subtypes.length > 0 && (
                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-3 flex items-center">
                      <Box className="w-4 h-4 mr-2 text-cyan-300" /> {selectedGame.id === "minecraft" ? "Server Software" : "Runtime"}
                    </label>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {selectedGame.subtypes.map((sub) => {
                        const meta = MINECRAFT_SUBTYPE_META[sub.id] || { icon: Box, color: "text-cyan-300", bg: "bg-cyan-400/10", border: "border-cyan-400/20", ring: "ring-cyan-500/50", glow: "to-cyan-500/10" };
                        const Icon = meta.icon;
                        const isSelected = type === sub.id;
                        return (
                          <button
                            key={sub.id}
                            type="button"
                            onClick={() => setType(sub.id)}
                            className={`flex flex-col items-center justify-center p-4 rounded-2xl border transition-all duration-200 relative overflow-hidden group ${
                              isSelected ? `${meta.bg} ${meta.border} ring-1 ${meta.ring} shadow-lg` : "bg-white/[0.02] border-white/5 hover:border-white/20 hover:bg-white/[0.04]"
                            }`}
                          >
                            {isSelected && <div className={`absolute inset-0 bg-gradient-to-br from-transparent ${meta.glow}`} />}
                            <Icon className={`w-7 h-7 mb-2 ${isSelected ? meta.color : "text-zinc-500 group-hover:text-zinc-300"} transition-colors relative z-10`} />
                            <span className={`text-sm font-bold relative z-10 ${isSelected ? "text-white" : "text-zinc-300"}`}>{sub.name}</span>
                            <span className={`text-[10px] text-center mt-1 relative z-10 ${isSelected ? "text-white/70" : "text-zinc-500"}`}>{sub.description}</span>
                            {isSelected && <div className={`absolute top-2 right-2 ${meta.color}`}><CheckCircle2 className="w-4 h-4" /></div>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Version picker (skip for discord bots which just use "latest") */}
                {selectedGame.id !== "discord-bot" && versions.length > 0 && (
                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                      <Box className="w-4 h-4 mr-2 text-cyan-400" /> Version
                    </label>
                    <SearchableDropdown
                      value={version}
                      onChange={setVersion}
                      options={versions.map(v => ({ value: v, label: v }))}
                      placeholder="Select a version..."
                      searchPlaceholder="Search versions..."
                      className="font-mono"
                    />
                  </div>
                )}

                {/* Discord bot specific fields */}
                {selectedGame.id === "discord-bot" && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                        <KeyRound className="w-4 h-4 mr-2 text-cyan-300" /> Discord Bot Token
                      </label>
                      <input
                        type="password"
                        value={discordToken}
                        onChange={e => setDiscordToken(e.target.value)}
                        placeholder="Paste your bot token"
                        className="w-full bg-white/[0.02] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-3 text-white transition-all shadow-inner outline-none font-mono"
                      />
                      <p className="text-xs text-zinc-500 mt-2">Stored as an environment variable inside your container. Never shared with other users.</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                        <Terminal className="w-4 h-4 mr-2 text-cyan-300" /> Start Command
                      </label>
                      <input
                        type="text"
                        value={startCommand}
                        onChange={e => setStartCommand(e.target.value)}
                        placeholder={type === "PYTHON" ? "pip install -r requirements.txt && python bot.py" : "npm install && node index.js"}
                        className="w-full bg-white/[0.02] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-3 text-white transition-all shadow-inner outline-none font-mono text-sm"
                      />
                      <p className="text-xs text-zinc-500 mt-2">Upload your bot's code via the file manager after creation, then start the server.</p>
                    </div>
                  </>
                )}

                {/* Server password — Rust, Valheim, ARK, Palworld */}
                {["rust", "valheim", "ark", "palworld"].includes(selectedGame.id) && (
                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                      <KeyRound className="w-4 h-4 mr-2 text-cyan-300" /> Server Password
                    </label>
                    <input
                      type="password"
                      value={serverPassword}
                      onChange={e => setServerPassword(e.target.value)}
                      placeholder={selectedGame.id === "valheim" ? "At least 5 characters (required)" : "Leave blank for no password"}
                      className="w-full bg-white/[0.02] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-3 text-white transition-all shadow-inner outline-none font-mono"
                    />
                    {selectedGame.id === "valheim" && (
                      <p className="text-xs text-zinc-500 mt-2">Valheim requires a password of at least 5 characters — the server won't start without one.</p>
                    )}
                  </div>
                )}

                {/* Steam Game Server Login Token — CS2 */}
                {selectedGame.id === "cs2" && (
                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                      <KeyRound className="w-4 h-4 mr-2 text-cyan-300" /> Steam Game Server Token
                    </label>
                    <input
                      type="password"
                      value={srcdsToken}
                      onChange={e => setSrcdsToken(e.target.value)}
                      placeholder="Get one from steamcommunity.com/dev/managegameservers"
                      className="w-full bg-white/[0.02] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-3 text-white transition-all shadow-inner outline-none font-mono"
                    />
                    <p className="text-xs text-zinc-500 mt-2">Required for the server to appear in the public server browser. Leave blank for a LAN-only/private server.</p>
                  </div>
                )}

                {/* Resources */}
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-3 flex items-center">
                    <MemoryStick className="w-4 h-4 mr-2 text-cyan-300" /> Memory (RAM)
                  </label>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {visibleRamPresets.map(val => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => handleRamSelect(val)}
                        className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${
                          Number(ram) === val ? "bg-cyan-400/20 border border-cyan-400/40 text-cyan-300" : "bg-white/[0.02] border border-white/10 text-zinc-400 hover:border-white/20"
                        }`}
                      >
                        {val}GB
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    min={0.5}
                    max={isAdmin ? undefined : userRamCap}
                    step={0.5}
                    value={ram}
                    onChange={e => {
                      const next = e.target.value;
                      if (!isAdmin && next !== "" && Number(next) > userRamCap) {
                        setRam(userRamCap.toString());
                      } else {
                        setRam(next);
                      }
                    }}
                    className="w-full bg-white/[0.02] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-3 text-white transition-all shadow-inner outline-none font-mono"
                  />
                  {!isAdmin && (
                    <p className="text-xs text-zinc-500 mt-2">Your account is limited to {userRamCap}GB RAM per server.</p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-5">
                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                      <Cpu className="w-4 h-4 mr-2 text-cyan-300" /> CPU Limit (%)
                    </label>
                    <input
                      type="number"
                      min={10}
                      max={isAdmin ? undefined : (user?.maxCpuPercent ?? 200)}
                      value={cpu}
                      onChange={e => {
                        const next = e.target.value;
                        const cap = user?.maxCpuPercent ?? 200;
                        if (!isAdmin && next !== "" && Number(next) > cap) {
                          setCpu(cap.toString());
                        } else {
                          setCpu(next);
                        }
                      }}
                      className="w-full bg-white/[0.02] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-3 text-white transition-all shadow-inner outline-none font-mono"
                    />
                    {!isAdmin && (
                      <p className="text-xs text-zinc-500 mt-2">Capped at {user?.maxCpuPercent ?? 200}%.</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                      <HardDrive className="w-4 h-4 mr-2 text-cyan-300" /> Disk (GB)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={isAdmin ? undefined : (user?.maxDiskGb ?? 10)}
                      value={disk}
                      onChange={e => {
                        const next = e.target.value;
                        const cap = user?.maxDiskGb ?? 10;
                        if (!isAdmin && next !== "" && Number(next) > cap) {
                          setDisk(cap.toString());
                        } else {
                          setDisk(next);
                        }
                      }}
                      className="w-full bg-white/[0.02] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-3 text-white transition-all shadow-inner outline-none font-mono"
                    />
                    {!isAdmin && (
                      <p className="text-xs text-zinc-500 mt-2">Capped at {user?.maxDiskGb ?? 10}GB.</p>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-5">
                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                      <Network className="w-4 h-4 mr-2 text-cyan-300" /> Port
                    </label>
                    <input
                      type="number"
                      required
                      value={port}
                      onChange={e => { setPort(e.target.value); setError(null); }}
                      className={`w-full bg-white/[0.02] border focus:ring-1 rounded-xl px-4 py-3 text-white transition-all shadow-inner outline-none font-mono ${error?.includes("Port") ? "border-red-500 focus:border-red-500 focus:ring-red-500/50" : "border-white/10 focus:border-cyan-500 focus:ring-cyan-400/50"}`}
                    />
                    {error?.includes("Port") && (
                      <p className="mt-2 text-sm text-red-400 flex items-center">
                        <AlertTriangle className="w-4 h-4 mr-1.5" /> {error}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                      <Globe className="w-4 h-4 mr-2 text-cyan-300" /> IP Alias
                    </label>
                    <input
                      type="text"
                      value={ipAlias}
                      onChange={e => setIpAlias(e.target.value)}
                      placeholder="e.g. play.example.com"
                      className="w-full bg-white/[0.02] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-3 text-white transition-all shadow-inner outline-none font-mono"
                    />
                  </div>
                </div>

                {isAdmin && (
                  <div className="relative z-20">
                    <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                      <User className="w-4 h-4 mr-2 text-cyan-300" /> Assign Server Owner
                    </label>
                    <SearchableDropdown
                      value={owner}
                      onChange={setOwner}
                      options={users.map(u => ({ value: u.id, label: `${u.username} ${u.id === user?.id ? "(You)" : `(${u.role})`}` }))}
                      placeholder="Select a user..."
                      searchPlaceholder="Search users..."
                    />
                    <p className="text-xs text-zinc-500 mt-2">Select which user owns and has access to this server.</p>
                  </div>
                )}

                <div className="pt-4 border-t border-white/5">
                  {loading && (
                    <div className="mb-6 p-4 border border-zinc-800 bg-black/20 rounded-xl">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-sm font-medium text-cyan-300">
                          {selectedGame.id === "discord-bot" ? "Provisioning bot container..." : `Downloading ${version} and creating container...`}
                        </span>
                        <span className="text-sm font-mono text-cyan-300/80">{Math.round(createProgress)}%</span>
                      </div>
                      <div className="w-full bg-zinc-800/50 rounded-full h-2.5 overflow-hidden">
                        <div className="bg-cyan-500 h-2.5 rounded-full transition-all duration-300 ease-out" style={{ width: `${createProgress}%` }}></div>
                      </div>
                    </div>
                  )}
                  {error && !error.includes("Port") && (
                    <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start text-red-400 mb-6">
                      <AlertTriangle className="w-5 h-5 mr-3 shrink-0 mt-0.5" />
                      <p className="text-sm font-medium">{error}</p>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full px-4 py-3.5 bg-white text-zinc-900 hover:bg-zinc-200 font-bold rounded-xl transition-all shadow-lg active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 flex justify-center items-center gap-2"
                  >
                    {loading ? (
                      <>
                        <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }} className="w-5 h-5 border-2 border-zinc-900 border-t-transparent rounded-full mr-2" />
                        Deploying Instance...
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-5 h-5" /> Launch Instance
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showRamWarning && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/35 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-[#121214] border border-red-500/30 shadow-2xl shadow-red-500/10 rounded-2xl p-6 max-w-md w-full relative overflow-hidden"
            >
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-red-500 to-amber-500" />
              <div className="flex items-start mb-4">
                <div className="bg-red-500/10 p-3 rounded-full mr-4">
                  <AlertTriangle className="w-6 h-6 text-red-500" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white mb-1">High RAM Allocation</h3>
                  <p className="text-zinc-400 text-sm leading-relaxed">
                    You are attempting to allocate <strong className="text-white">{ram}GB</strong> of RAM, but this system only has <strong className="text-white">{totalSystemRam.toFixed(1)}GB</strong> physically available.
                  </p>
                  <p className="text-zinc-400 text-sm leading-relaxed mt-2">
                    The server has been configured to use memory on-demand, but if it actually consumes more than the available physical RAM during runtime, the host operating system may forcibly terminate (crash) it to prevent system instability.
                  </p>
                </div>
              </div>
              <div className="flex justify-end space-x-3 mt-6">
                <button type="button" onClick={() => setShowRamWarning(false)} className="px-4 py-2 bg-white/5 hover:bg-white/10 text-white font-medium rounded-xl transition-colors">
                  Cancel
                </button>
                <button type="button" onClick={executeSubmit} className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 font-bold rounded-xl transition-colors border border-red-500/30">
                  Yes, Proceed Anyway
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {loading && <LoadingOverlay message="Provisioning server resources..." />}
    </motion.div>
  );
}
