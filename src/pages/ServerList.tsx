import React, { useEffect, useState } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import { Server, Plus, Play, Square, RefreshCw } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "../context/AuthContext";
import ServerLiveStats from "../components/ServerLiveStats";

export default function ServerList() {
  const [servers, setServers] = useState<any[]>([]);
  const [pendingAction, setPendingAction] = useState<Record<string, "start" | "stop" | "restart">>({});
  const { user, isAdmin, canCreateServers } = useAuth();

  const fetchServers = async () => {
    try {
      const res = await axios.get("/api/servers");
      setServers(res.data);
    } catch(e) {}
  };

  const handleQuickAction = async (e: React.MouseEvent, serverId: string, action: "start" | "stop" | "restart") => {
    // Prevent the click from bubbling up to the wrapping <Link> and
    // navigating into the server detail page — this button should act in
    // place, right from the list.
    e.preventDefault();
    e.stopPropagation();
    if (pendingAction[serverId]) return;

    setPendingAction((p) => ({ ...p, [serverId]: action }));
    try {
      await axios.post(`/api/servers/${serverId}/${action}`);
      // Give the container a moment to actually transition state before
      // refetching — otherwise the immediate refetch below can still show
      // the pre-action status and make the click look like it did nothing.
      setTimeout(fetchServers, 1500);
    } catch (err) {
      console.error(`Failed to ${action} server`, err);
    } finally {
      setTimeout(() => {
        setPendingAction((p) => {
          const next = { ...p };
          delete next[serverId];
          return next;
        });
      }, 1500);
    }
  };

  useEffect(() => {
    fetchServers();
    const interval = setInterval(fetchServers, 5000);
    return () => clearInterval(interval);
  }, []);

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.05 }
    }
  };

  const itemAnim = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 24 } }
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -15 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="p-5 md:p-10 max-w-7xl mx-auto"
    >
      <div className="flex flex-col md:flex-row md:items-end justify-between mb-10 gap-4">
        <div>
          <h1 className="text-4xl md:text-5xl font-black tracking-tight text-white mb-2 drop-shadow-lg">Instances</h1>
          <p className="text-cyan-300/80 font-bold uppercase tracking-widest text-sm mt-2">Manage and monitor your server fleet.</p>
        </div>
        {canCreateServers && (
          <Link to="/servers/create" className="px-5 py-2.5 bg-white text-black font-semibold rounded-xl hover:bg-zinc-200 transition-colors shadow-lg shadow-white/10 text-sm whitespace-nowrap inline-flex items-center self-start md:self-auto">
            <Plus size={18} className="mr-2" />
            New Instance
          </Link>
        )}
      </div>

      <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-1 gap-4 md:gap-6">
        {servers.map(server => (
          <motion.div variants={itemAnim} key={server.id} className="bg-black/40 backdrop-blur-sm rounded-3xl border border-white/10 p-5 md:p-6 flex flex-col group hover:bg-black/35 transition-all shadow-[0_0_40px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5 relative overflow-hidden">
            {/* Subtle top glow based on status */}
            <div className={`absolute top-0 left-0 right-0 h-[2px] opacity-70 ${server.status === 'online' ? 'bg-gradient-to-r from-transparent via-emerald-500 to-transparent shadow-[0_0_15px_rgba(16,185,129,0.5)]' : 'bg-gradient-to-r from-transparent via-zinc-500 to-transparent'}`} />
            <div className="absolute inset-0 bg-gradient-to-br from-cyan-400/0 to-transparent opacity-0 group-hover:opacity-10 transition-opacity" />
            
            <Link to={`/servers/${server.id}`} className="block flex-1 z-10 relative">
              <div className="flex justify-between items-start mb-6">
                <div className="flex items-center space-x-4">
                  <div className="w-14 h-14 rounded-2xl bg-black/35 border border-white/10 flex items-center justify-center group-hover:border-cyan-400/40 group-hover:bg-cyan-400/20 transition-all shadow-inner relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-cyan-400/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                    <Server className="w-7 h-7 text-zinc-400 group-hover:text-cyan-300 transition-colors relative z-10" />
                  </div>
                  <div>
                    <h2 className="font-bold tracking-tight text-white text-xl group-hover:text-cyan-300 transition-colors drop-shadow-sm">{server.name}</h2>
                    <div className="flex items-center mt-1.5 space-x-2">
                       <span className="flex h-2.5 w-2.5 relative">
                          {server.status === 'online' && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>}
                          <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${server.status === 'online' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-zinc-600'}`}></span>
                        </span>
                      <span className="text-xs font-bold text-zinc-400 uppercase tracking-widest">{server.status}</span>
                    </div>
                  </div>
                </div>
                {/* Quick actions — act in place without navigating into the
                   server. z-20 keeps them clickable above the card's own
                   Link overlay. */}
                <div className="flex items-center gap-1.5 relative z-20 shrink-0">
                  {server.status !== 'online' ? (
                    <button
                      onClick={(e) => handleQuickAction(e, server.id, 'start')}
                      disabled={!!pendingAction[server.id]}
                      title="Start"
                      className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-40"
                    >
                      {pendingAction[server.id] === 'start' ? <RefreshCw size={16} className="animate-spin" /> : <Play size={16} />}
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={(e) => handleQuickAction(e, server.id, 'restart')}
                        disabled={!!pendingAction[server.id]}
                        title="Restart"
                        className="p-2 rounded-lg bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 transition-colors disabled:opacity-40"
                      >
                        <RefreshCw size={16} className={pendingAction[server.id] === 'restart' ? 'animate-spin' : ''} />
                      </button>
                      <button
                        onClick={(e) => handleQuickAction(e, server.id, 'stop')}
                        disabled={!!pendingAction[server.id]}
                        title="Stop"
                        className="p-2 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-40"
                      >
                        {pendingAction[server.id] === 'stop' ? <RefreshCw size={16} className="animate-spin" /> : <Square size={16} />}
                      </button>
                    </>
                  )}
                </div>
              </div>
              
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4 py-4 border-y border-white/10 my-4 text-sm mt-auto bg-black/20 rounded-xl px-4">
                <div>
                  <p className="text-cyan-300/80 text-[10px] md:text-[11px] mb-1 font-bold uppercase tracking-[0.15em] drop-shadow-sm">CPU Limit</p>
                  <p className="font-mono text-white font-bold text-xs md:text-sm">{server.cpu || 100} <span className="text-zinc-500 opacity-70">%</span></p>
                </div>
                <div>
                  <p className="text-emerald-400/80 text-[10px] md:text-[11px] mb-1 font-bold uppercase tracking-[0.15em] drop-shadow-sm">RAM Usage</p>
                  <div className="font-mono text-white font-bold text-xs md:text-sm">
                    <ServerLiveStats serverId={server.id} limitRam={server.ram} status={server.status} />
                  </div>
                </div>
                <div>
                  <p className="text-orange-400/80 text-[10px] md:text-[11px] mb-1 font-bold uppercase tracking-[0.15em] drop-shadow-sm">Disk Limit</p>
                  <p className="font-mono text-white font-bold text-xs md:text-sm">{server.disk || 10} <span className="text-zinc-500 opacity-70">GB</span></p>
                </div>
                <div>
                  <p className="text-violet-400/80 text-[10px] md:text-[11px] mb-1 font-bold uppercase tracking-[0.15em] drop-shadow-sm">Version</p>
                  <p className="text-white font-bold text-xs md:text-sm truncate font-mono" title={server.version}>
                    {server.version}
                  </p>
                </div>
              </div>
            </Link>
          </motion.div>
        ))}
        {servers.length === 0 && (
          <motion.div variants={itemAnim} className="col-span-full py-32 flex flex-col items-center justify-center text-zinc-500 border border-dashed border-white/10 rounded-3xl bg-white/[0.01]">
            <div className="w-16 h-16 bg-white/5 rounded-2xl flex items-center justify-center mb-6">
                <Server className="w-8 h-8 opacity-50" />
            </div>
            <h3 className="text-xl font-bold text-white mb-2">No Instances Running</h3>
            <p className="max-w-sm text-center mb-6 text-sm">You haven't deployed any servers yet. Create one to start managing your game instances.</p>
            {canCreateServers && (
                <Link to="/servers/create" className="px-5 py-2.5 bg-white text-black font-semibold rounded-xl hover:bg-zinc-200 transition-colors shadow-lg shadow-white/10 text-sm">
                    Deploy your first server
                </Link>
            )}
          </motion.div>
        )}
      </motion.div>
    </motion.div>
  );
}
