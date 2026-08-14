import { Link, useLocation } from "react-router-dom";
import { Server, LayoutDashboard, Plus, LogOut, X, Settings, Globe, Key, Coins } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useSettings } from "../context/SettingsContext";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import axios from "axios";

export function Sidebar({ onClose }: { onClose?: () => void }) {
  const location = useLocation();
  const { user, logout, isAdmin } = useAuth();
  const { panelName, panelLogo } = useSettings();

  // Store link only shows once the coin economy is actually turned on —
  // a link to an empty/disabled store would just be confusing chrome for
  // panels that don't use this feature. Fetched once on mount; toggling
  // the setting takes effect for a user on their next page load, which is
  // an acceptable tradeoff against adding this to the global settings
  // context and re-rendering every consumer of it for a rarely-toggled flag.
  const [coinsEnabled, setCoinsEnabled] = useState(false);
  useEffect(() => {
    axios.get("/api/system/coins/settings").then((res) => setCoinsEnabled(!!res.data.enabled)).catch(() => {});
  }, []);
  
  const links = [
    { name: "Dashboard", path: "/", icon: <LayoutDashboard size={18} /> },
    { name: "Servers", path: "/servers", icon: <Server size={18} /> },
  ];

  if (coinsEnabled) {
    links.push({ name: "Store", path: "/store", icon: <Coins size={18} /> });
  }

  if (isAdmin) {
    links.push({ name: "Create Server", path: "/servers/create", icon: <Plus size={18} /> });
    links.push({ name: "API Keys", path: "/api-keys", icon: <Key size={18} /> });
  }

  links.push({ name: "Settings", path: "/settings", icon: <Settings size={18} /> });

  return (
    <div className="w-64 h-full bg-black/40 backdrop-blur-md flex flex-col py-6 border-r border-white/10 relative shadow-[20px_0_40px_-20px_rgba(0,0,0,0.5)] z-20">
      {onClose && (
        <button onClick={onClose} className="md:hidden flex items-center justify-center absolute top-5 right-4 p-2 text-zinc-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
          <X size={20} />
        </button>
      )}
      
      <div className="px-6 mb-10 mt-2 flex items-center gap-3">
        {panelLogo ? (
          <img src={panelLogo} alt="Logo" className="w-8 h-8 rounded-lg object-cover shadow-[0_0_15px_rgba(94,234,212,0.15)] flex-shrink-0" />
        ) : (
          <div className="relative flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-sky-500 shadow-[0_0_15px_rgba(56,189,248,0.5)] flex-shrink-0">
            <Server className="w-4 h-4 text-[#030308]" />
          </div>
        )}
        <h1 className="text-xl font-bold text-white tracking-tight truncate">
          {panelName}
        </h1>
      </div>

      <nav className="flex-1 w-full px-3 space-y-1">
        {links.map(link => {
          const isActive = location.pathname === link.path || (link.path !== '/' && location.pathname.startsWith(link.path));
          return (
            <Link 
              key={link.path} 
              to={link.path} 
              onClick={onClose}
              className="relative flex items-center space-x-3 w-full px-3 py-2.5 rounded-xl transition-all group overflow-hidden"
            >
              {isActive && (
                <motion.div 
                  layoutId="activeTab" 
                  className="absolute inset-0 bg-gradient-to-r from-cyan-400/20 to-sky-500/10 border border-cyan-400/20 rounded-xl shadow-[0_0_15px_rgba(56,189,248,0.1)]" 
                  initial={false} 
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                />
              )}
              <div className={`relative z-10 transition-colors duration-200 ${isActive ? 'text-white' : 'text-zinc-300 group-hover:text-white'}`}>
                {link.icon}
              </div>
              <span className={`relative z-10 font-medium text-sm transition-colors duration-200 ${isActive ? 'text-white' : 'text-zinc-300 group-hover:text-white'}`}>
                {link.name}
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="w-full px-4 mt-auto space-y-3">
        <div className="bg-black/35 rounded-xl p-3 flex items-center gap-3 border border-white/10 hover:border-cyan-400/30 transition-all cursor-default shadow-inner relative overflow-hidden group">
          <div className="absolute inset-0 bg-gradient-to-br from-cyan-400/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-cyan-400 to-sky-500 border border-white/20 flex items-center justify-center font-black text-sm text-[#030308] shadow-[0_0_10px_rgba(56,189,248,0.5)] relative z-10">
            {user?.username?.[0]?.toUpperCase()}
          </div>
          <div className="overflow-hidden flex-1 relative z-10">
            <p className="font-bold text-white truncate text-sm tracking-tight drop-shadow-sm">{user?.username}</p>
            <p className="text-[10px] text-cyan-300/80 capitalize truncate font-bold uppercase tracking-widest">{user?.role || "User"}</p>
          </div>
        </div>
        <button onClick={logout} className="flex items-center space-x-3 w-full px-3 py-2.5 rounded-xl text-zinc-400 hover:bg-red-500/10 hover:text-red-400 transition-all group">
          <LogOut size={18} className="group-hover:scale-110 transition-transform" />
          <span className="font-medium text-sm">Logout</span>
        </button>
      </div>
    </div>
  );
}
