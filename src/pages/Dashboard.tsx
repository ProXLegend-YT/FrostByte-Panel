import React, { useEffect, useState } from "react";
import axios from "axios";
import { Server, Activity, HardDrive, Cpu, MemoryStick, ChevronRight, History } from "lucide-react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import ActivityFeed from "../components/ActivityFeed";
import Sparkline from "../components/Sparkline";

const HISTORY_CAP = 30; // 30 samples at 5s polling = last 2.5 minutes of trend

export default function Dashboard() {
  const [stats, setStats] = useState<any>(null);
  const [servers, setServers] = useState<any[]>([]);
  const { user, isAdmin } = useAuth();

  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [ramHistory, setRamHistory] = useState<number[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [statsRes, serversRes] = await Promise.all([
          axios.get("/api/system/stats"),
          axios.get("/api/servers")
        ]);
        setStats(statsRes.data);
        setServers(serversRes.data);
        setCpuHistory((h) => [...h, statsRes.data.cpuUsage ?? 0].slice(-HISTORY_CAP));
        setRamHistory((h) => [...h, statsRes.data.ramUsage ?? 0].slice(-HISTORY_CAP));
      } catch(e){}
    };
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  if (!stats) return (
    <div className="h-full flex items-center justify-center p-8">
      <motion.div
        animate={{ scale: [1, 1.2, 1], rotate: [0, 180, 360] }}
        transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
        className="w-12 h-12 border-2 border-cyan-400 border-t-transparent rounded-full"
      />
    </div>
  );

  const runningServers = servers.filter(s => s.status === 'online').length;
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const createdThisWeek = servers.filter(s => s.createdAt && new Date(s.createdAt).getTime() >= oneWeekAgo).length;

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.1 }
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
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white mb-2">System Overview</h1>
          <p className="text-zinc-400">Monitor your infrastructure and activity.</p>
        </div>
        {isAdmin && (
          <Link to="/servers/create" className="px-5 py-2.5 bg-white text-black font-semibold rounded-xl hover:bg-zinc-200 transition-colors shadow-lg shadow-white/10 text-sm whitespace-nowrap inline-flex items-center self-start md:self-auto">
            Deploy New Server
          </Link>
        )}
      </div>
      
      <motion.div variants={container} initial="hidden" animate="show" className={`grid grid-cols-1 md:grid-cols-2 ${isAdmin ? 'lg:grid-cols-5' : 'lg:grid-cols-2 lg:max-w-3xl'} gap-5 mb-12`}>
        <StatCard title="Total Servers" value={servers.length.toString()} icon={<Server size={22} className="text-cyan-300" />} trend={createdThisWeek > 0 ? `+${createdThisWeek} this week` : "No new servers this week"} chartColor="from-cyan-400 to-cyan-400/0" />
        <StatCard title="Running Servers" value={runningServers.toString()} icon={<Activity size={22} className="text-emerald-400" />} trend="Active now" chartColor="from-emerald-500 to-emerald-500/0" />
        {isAdmin && (
          <>
            <StatCard
              title="Dedicated CPU Usage"
              value={`${stats.cpuUsage}%`}
              icon={<Cpu size={22} className="text-sky-400" />}
              chartColor="from-sky-500 to-sky-500/0"
              spark={cpuHistory.length >= 2 && <Sparkline data={cpuHistory} color="#38bdf8" max={100} cap={HISTORY_CAP} w={100} h={30} />}
            />
            <StatCard
              title="Dedicated RAM Usage"
              value={`${stats.ramUsage}%`}
              icon={<MemoryStick size={22} className="text-violet-400" />}
              chartColor="from-violet-500 to-violet-500/0"
              spark={ramHistory.length >= 2 && <Sparkline data={ramHistory} color="#a78bfa" max={100} cap={HISTORY_CAP} w={100} h={30} />}
            />
            <StatCard
              title="Disk Usage"
              value={`${stats.diskUsage}%`}
              icon={<HardDrive size={22} className="text-amber-400" />}
              trend={stats.diskTotal ? `${formatBytes(stats.diskFree)} free of ${formatBytes(stats.diskTotal)}` : undefined}
              chartColor="from-amber-500 to-amber-500/0"
            />
          </>
        )}
      </motion.div>

      <div className="flex items-center justify-between mb-6 mt-14">
        <h2 className="text-xl font-bold tracking-tight text-white">Your Servers</h2>
        <Link to="/servers" className="text-sm font-medium text-cyan-300 hover:text-cyan-200 flex items-center transition-colors">
          View all <ChevronRight size={16} className="ml-1" />
        </Link>
      </div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3, duration: 0.5 }} className="bg-black/40 backdrop-blur-sm rounded-3xl border border-white/10 overflow-hidden shadow-[0_0_50px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5 relative">
        {/* Subtle top glow */}
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent opacity-50" />
        
        {servers.length === 0 ? (
           <div className="p-16 text-center relative overflow-hidden">
             <div className="absolute inset-0 bg-gradient-to-br from-cyan-400/5 to-transparent pointer-events-none" />
             <div className="w-20 h-20 bg-white/5 rounded-3xl flex items-center justify-center mx-auto mb-6 border border-white/10 shadow-inner relative z-10">
                <Server className="text-zinc-400" size={40} />
             </div>
             <h3 className="text-xl font-bold text-white mb-2 relative z-10 tracking-tight">No Servers Yet</h3>
             <p className="text-zinc-400 text-sm font-medium relative z-10">Create a new server to get started.</p>
           </div>
        ) : (
          <div className="divide-y divide-white/5">
            {servers.slice(0, 5).map((server, index) => (
              <motion.div 
                key={server.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.4 + (index * 0.05) }}
              >
                <Link to={`/servers/${server.id}`} className="flex items-center justify-between p-5 md:p-6 hover:bg-white/5 transition-all group relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-r from-cyan-400/0 via-cyan-400/0 to-cyan-400/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                  <div className="flex items-center gap-5 relative z-10">
                    <div className="w-12 h-12 rounded-2xl bg-black/35 border border-white/10 flex items-center justify-center group-hover:border-cyan-400/40 group-hover:bg-cyan-400/20 transition-all shadow-inner relative overflow-hidden">
                      <div className="absolute inset-0 bg-gradient-to-br from-cyan-400/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                      <Server className="w-6 h-6 text-zinc-400 group-hover:text-cyan-300 transition-colors relative z-10" />
                    </div>
                    <div>
                      <h3 className="font-bold text-zinc-100 group-hover:text-white transition-colors text-lg tracking-tight drop-shadow-sm">{server.name}</h3>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className="flex h-2.5 w-2.5 relative">
                          {server.status === 'online' && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>}
                          <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${server.status === 'online' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-zinc-600'}`}></span>
                        </span>
                        <p className="text-xs font-bold text-zinc-400 uppercase tracking-widest">{server.status}</p>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-5 relative z-10">
                    <div className="text-xs font-mono font-medium text-zinc-500 hidden sm:block bg-black/40 px-3 py-1.5 rounded-lg border border-white/5">
                      {new Date(server.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <ChevronRight className="w-6 h-6 text-zinc-500 group-hover:text-white transition-colors group-hover:translate-x-1" />
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
        )}
      </motion.div>

      <div className="flex items-center gap-2 mb-6 mt-14">
        <History size={20} className="text-cyan-300" />
        <h2 className="text-xl font-bold tracking-tight text-white">Recent Activity</h2>
      </div>
      <ActivityFeed limit={10} />
    </motion.div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 GB";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function StatCard({ title, value, icon, trend, chartColor, spark }: { title: string, value: string, icon: React.ReactNode, trend?: string, chartColor?: string, spark?: React.ReactNode }) {
  const itemAnim = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 24 } }
  };
  return (
    <motion.div variants={itemAnim} className="bg-black/40 backdrop-blur-sm p-6 rounded-2xl border border-white/10 relative overflow-hidden group hover:bg-black/35 transition-all shadow-[0_0_40px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5">
      {/* Decorative gradient blur in background */}
      <div className={`absolute inset-0 bg-gradient-to-br ${chartColor} opacity-5 group-hover:opacity-10 transition-opacity`} />
      <div className={`absolute -bottom-10 -right-10 w-40 h-40 bg-gradient-to-br ${chartColor} opacity-20 blur-[50px] group-hover:opacity-40 transition-opacity`} />
      
      <div className="relative z-10 flex justify-between items-start mb-4">
        <div className="p-3 bg-white/5 rounded-xl border border-white/10 shadow-inner">
          {icon}
        </div>
        {spark && (
          <div className="w-[100px] h-[30px] opacity-90">
            {spark}
          </div>
        )}
      </div>
      <div className="relative z-10">
        <h3 className="text-3xl font-black text-white tracking-tight mb-1 drop-shadow-md">{value}</h3>
        <p className="text-sm font-bold text-zinc-300 uppercase tracking-widest opacity-80">{title}</p>
      </div>
      {trend && (
        <div className="relative z-10 mt-4 text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-current"></span>
          {trend}
        </div>
      )}
    </motion.div>
  );
}
