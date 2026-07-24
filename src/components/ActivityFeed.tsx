import { useEffect, useState } from "react";
import axios from "axios";
import { motion } from "framer-motion";
import {
  Server, Play, Square, RefreshCw, Trash2, UserPlus, FileX, Archive,
  KeyRound, Settings, Users, Clock, Cpu,
} from "lucide-react";

interface ActivityEntry {
  id: string;
  timestamp: string;
  actorUsername: string;
  action: string;
  target?: string;
  serverId?: string;
  metadata?: Record<string, any>;
}

const ACTION_META: Record<string, { label: (e: ActivityEntry) => string; icon: React.ReactNode; color: string }> = {
  "auth.register": { label: (e) => `${e.actorUsername} created an account`, icon: <UserPlus size={15} />, color: "text-cyan-300" },
  "server.create": { label: (e) => `${e.actorUsername} created server "${e.target}"`, icon: <Server size={15} />, color: "text-cyan-300" },
  "server.delete": { label: (e) => `${e.actorUsername} deleted server "${e.target}"`, icon: <Trash2 size={15} />, color: "text-red-400" },
  "server.start": { label: (e) => `${e.actorUsername} started "${e.target}"`, icon: <Play size={15} />, color: "text-emerald-400" },
  "server.stop": { label: (e) => `${e.actorUsername} stopped "${e.target}"`, icon: <Square size={15} />, color: "text-red-400" },
  "server.restart": { label: (e) => `${e.actorUsername} restarted "${e.target}"`, icon: <RefreshCw size={15} />, color: "text-orange-400" },
  "server.owner_change": { label: (e) => `${e.actorUsername} changed the owner of "${e.target}"`, icon: <Users size={15} />, color: "text-violet-400" },
  "server.version_change": { label: (e) => `${e.actorUsername} changed version on "${e.target}"`, icon: <Settings size={15} />, color: "text-cyan-300" },
  "server.resource_change": { label: (e) => `${e.actorUsername} adjusted resource limits on "${e.target}"`, icon: <Cpu size={15} />, color: "text-violet-400" },
  "file.delete": { label: (e) => `${e.actorUsername} deleted file(s): ${e.target}`, icon: <FileX size={15} />, color: "text-red-400" },
  "backup.create": { label: (e) => `${e.actorUsername} created a backup of "${e.target}"`, icon: <Archive size={15} />, color: "text-emerald-400" },
  "backup.delete": { label: (e) => `${e.actorUsername} deleted a backup: ${e.target}`, icon: <Trash2 size={15} />, color: "text-red-400" },
  "sftp.create": { label: (e) => `${e.actorUsername} created SFTP credentials`, icon: <KeyRound size={15} />, color: "text-cyan-300" },
  "sftp.reset": { label: (e) => `${e.actorUsername} reset SFTP credentials`, icon: <KeyRound size={15} />, color: "text-cyan-300" },
  "subuser.add": { label: (e) => `${e.actorUsername} added a sub-user to "${e.target}"`, icon: <Users size={15} />, color: "text-cyan-300" },
  "subuser.remove": { label: (e) => `${e.actorUsername} removed a sub-user from "${e.target}"`, icon: <Users size={15} />, color: "text-red-400" },
  "user.create": { label: (e) => `${e.actorUsername} created a user account: ${e.target}`, icon: <UserPlus size={15} />, color: "text-cyan-300" },
  "user.delete": { label: (e) => `${e.actorUsername} deleted a user account: ${e.target}`, icon: <Trash2 size={15} />, color: "text-red-400" },
  "settings.update": { label: (e) => `${e.actorUsername} updated panel settings`, icon: <Settings size={15} />, color: "text-cyan-300" },
};

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ActivityFeed({ limit = 10, serverId }: { limit?: number; serverId?: string }) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchActivity = async () => {
      try {
        const params: any = { limit };
        if (serverId) params.serverId = serverId;
        const res = await axios.get("/api/system/activity", { params });
        if (!cancelled) setEntries(res.data);
      } catch {
        if (!cancelled) setEntries([]);
      }
    };
    fetchActivity();
    const interval = setInterval(fetchActivity, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [limit, serverId]);

  if (entries === null) {
    return (
      <div className="bg-black/40 backdrop-blur-xl rounded-3xl border border-white/10 p-8 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="bg-black/40 backdrop-blur-xl rounded-3xl border border-white/10 p-10 text-center">
        <Clock className="mx-auto mb-3 text-zinc-600" size={28} />
        <p className="text-zinc-400 text-sm font-medium">No activity recorded yet.</p>
      </div>
    );
  }

  return (
    <div className="bg-black/40 backdrop-blur-xl rounded-3xl border border-white/10 overflow-hidden shadow-[0_0_50px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5 relative">
      <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent opacity-50" />
      <div className="divide-y divide-white/5">
        {entries.map((entry, index) => {
          const meta = ACTION_META[entry.action] || {
            label: (e: ActivityEntry) => `${e.actorUsername} performed ${e.action}`,
            icon: <Clock size={15} />,
            color: "text-zinc-400",
          };
          return (
            <motion.div
              key={entry.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.03 }}
              className="flex items-center gap-4 px-5 py-4 hover:bg-white/5 transition-colors"
            >
              <div className={`w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center shrink-0 ${meta.color}`}>
                {meta.icon}
              </div>
              <p className="text-sm text-zinc-200 flex-1 truncate">{meta.label(entry)}</p>
              <span className="text-xs text-zinc-500 font-mono shrink-0">{timeAgo(entry.timestamp)}</span>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
