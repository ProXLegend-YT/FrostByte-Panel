import React, { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, CheckCheck, X, Info, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";

interface Notification {
  id: string;
  type: "info" | "success" | "warning" | "error";
  title: string;
  message: string;
  serverId?: string;
  link?: string;
  read: boolean;
  createdAt: string;
}

const TYPE_ICON: Record<Notification["type"], React.ReactNode> = {
  info: <Info size={16} className="text-cyan-300" />,
  success: <CheckCircle2 size={16} className="text-emerald-400" />,
  warning: <AlertTriangle size={16} className="text-orange-400" />,
  error: <XCircle size={16} className="text-red-400" />,
};

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<Notification | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const unreadCount = notifications.filter((n) => !n.read).length;

  const fetchNotifications = async () => {
    try {
      const res = await axios.get("/api/system/notifications", { params: { limit: 30 } });
      setNotifications(res.data);
    } catch {}
  };

  useEffect(() => {
    const token = localStorage.getItem("frostbyte_token");
    if (!token) return;

    fetchNotifications();

    const socket = io({ auth: { token } });
    socketRef.current = socket;

    socket.on("notification", (entry: Notification) => {
      setNotifications((prev) => [entry, ...prev].slice(0, 50));
      setToast(entry);
      setTimeout(() => setToast((current) => (current?.id === entry.id ? null : current)), 3000);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const markAllRead = async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    try {
      await axios.put("/api/system/notifications/read-all");
    } catch {}
  };

  const handleNotificationClick = async (n: Notification) => {
    if (!n.read) {
      setNotifications((prev) => prev.map((item) => (item.id === n.id ? { ...item, read: true } : item)));
      axios.put(`/api/system/notifications/${n.id}/read`).catch(() => {});
    }
    if (n.link) {
      navigate(n.link);
      setOpen(false);
    }
  };

  return (
    <>
      <div className="relative" ref={wrapperRef}>
        <button
          onClick={() => setOpen((o) => !o)}
          className="relative p-2 text-zinc-400 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
          aria-label="Notifications"
        >
          <Bell size={18} />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 bg-cyan-400 text-[#030308] text-[10px] font-bold rounded-full flex items-center justify-center shadow-[0_0_8px_rgba(56,189,248,0.6)]">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 mt-2 w-80 max-h-[70vh] overflow-y-auto custom-scrollbar bg-[#0a0c14]/95 backdrop-blur-sm border border-white/10 rounded-2xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.8)] z-50"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 sticky top-0 bg-[#0a0c14]/95 backdrop-blur-sm">
                <h3 className="font-bold text-sm text-white">Notifications</h3>
                {unreadCount > 0 && (
                  <button onClick={markAllRead} className="text-xs text-cyan-300 hover:text-cyan-200 flex items-center gap-1 font-medium">
                    <CheckCheck size={13} /> Mark all read
                  </button>
                )}
              </div>

              {notifications.length === 0 ? (
                <div className="p-8 text-center text-sm text-zinc-500">No notifications yet.</div>
              ) : (
                <div className="divide-y divide-white/5">
                  {notifications.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => handleNotificationClick(n)}
                      className={`w-full text-left px-4 py-3 hover:bg-white/5 transition-colors flex gap-3 ${!n.read ? "bg-cyan-400/5" : ""}`}
                    >
                      <div className="mt-0.5 shrink-0">{TYPE_ICON[n.type]}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-zinc-100 truncate">{n.title}</p>
                          {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shrink-0" />}
                        </div>
                        <p className="text-xs text-zinc-400 mt-0.5 line-clamp-2">{n.message}</p>
                        <p className="text-[10px] text-zinc-500 mt-1 font-mono">{timeAgo(n.createdAt)}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Toast for newly arrived notifications */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -16, x: "-50%" }}
            animate={{ opacity: 1, y: 0, x: "-50%" }}
            exit={{ opacity: 0, y: -16, x: "-50%" }}
            className="fixed top-4 left-1/2 z-[9999] w-[calc(100%-2rem)] max-w-sm bg-[#0a0c14]/95 backdrop-blur-sm border border-cyan-400/20 rounded-2xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.8)] p-4 flex gap-3"
          >
            <div className="mt-0.5 shrink-0">{TYPE_ICON[toast.type]}</div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white">{toast.title}</p>
              <p className="text-xs text-zinc-400 mt-0.5">{toast.message}</p>
            </div>
            <button onClick={() => setToast(null)} className="text-zinc-500 hover:text-white shrink-0">
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
