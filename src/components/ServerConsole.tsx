import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Terminal as XTerm,
  Cpu,
  MemoryStick,
  HardDrive,
  Layers,
  Copy,
  Check,
  Trash2,
  ChevronDown,
} from "lucide-react";
import { io, Socket } from "socket.io-client";
import { useAuth } from "../context/AuthContext";
import axios from "axios";
import Sparkline from "./Sparkline";
import PlayerManager from "./PlayerManager";

/* ═══════════════════════════════════════════════════════
   TYPES
═══════════════════════════════════════════════════════ */

interface ServerStats {
  cpu: number;
  ram: number;
  disk: number;
  limitRam: number;
  limitCpu: number;
  limitDisk: number;
}

interface Player {
  name: string;
}

interface ServerConsoleProps {
  serverId: string;
  server?: {
    version?: string;
    [key: string]: unknown;
  };
  // Optional: lets a parent (ServerView) mirror the live online-players
  // list this component already tracks internally, so a separate Players
  // tab can reuse it without opening a second socket connection.
  onPlayersChange?: (players: { name: string }[]) => void;
}

type LogLevel = "info" | "warn" | "error";
type LogFilter = "all" | LogLevel;

/* ═══════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════ */

const MAX_LOG_LINES = 200;
const STATS_POLL_MS = 5000;
const LIST_DELAY_MS = 2000;
const SPARK_CAP = 40;
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const DEFAULT_STATS: ServerStats = {
  cpu: 0,
  ram: 0,
  disk: 0,
  limitRam: 1024,
  limitCpu: 100,
  limitDisk: 10,
};

const QUICK_COMMANDS = [
  { cmd: "list", label: "list" },
  { cmd: "seed", label: "seed" },
  { cmd: "save-all", label: "save-all" },
  { cmd: "whitelist list", label: "whitelist" },
  { cmd: "stop", label: "stop", danger: true },
];

const FILTERS: { key: LogFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "info", label: "Info" },
  { key: "warn", label: "Warn" },
  { key: "error", label: "Err" },
];

/* ═══════════════════════════════════════════════════════
   STYLES — typography, keyframes, ambient layers
═══════════════════════════════════════════════════════ */

const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap');

::selection { background: rgba(52,211,153,0.25); }

.qx-display { font-family: 'Chakra Petch', system-ui, sans-serif; }
.qx-mono    { font-family: 'JetBrains Mono', ui-monospace, 'SF Mono', monospace; }

@keyframes qx-fade-up    { from { opacity:0; transform:translateY(14px) scale(.985); } to { opacity:1; transform:none; } }
@keyframes qx-slide-left { from { opacity:0; transform:translateX(-26px); }            to { opacity:1; transform:none; } }
@keyframes qx-slide-right{ from { opacity:0; transform:translateX(26px); }             to { opacity:1; transform:none; } }
@keyframes qx-log-in     { from { opacity:0; transform:translateX(-7px); }             to { opacity:1; transform:none; } }
@keyframes qx-ping       { 0% { transform:scale(1); opacity:.7; } 75%,100% { transform:scale(2.4); opacity:0; } }
@keyframes qx-blink      { 0%,49% { opacity:1; } 50%,100% { opacity:0; } }
@keyframes qx-spin       { to { transform:rotate(360deg); } }
@keyframes qx-scan       { 0% { top:-2px; } 100% { top:100%; } }
@keyframes qx-drift      { 0% { transform:translate3d(0,0,0); } 100% { transform:translate3d(-48px,-48px,0); } }
@keyframes qx-dot-bounce { 0%,80%,100% { transform:scale(.5); opacity:.3; } 40% { transform:scale(1); opacity:1; } }
@keyframes qx-tail-in    { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
@keyframes qx-shimmer    { 0% { transform:translate3d(-100%,0,0); } 100% { transform:translate3d(100%,0,0); } }
@keyframes qx-rec        { 0%,100% { opacity:1; } 50% { opacity:.35; } }

.qx-enter        { animation: qx-fade-up .55s cubic-bezier(.22,1,.36,1) both; }
.qx-enter-left   { animation: qx-slide-left .6s cubic-bezier(.22,1,.36,1) both; }
.qx-enter-right  { animation: qx-slide-right .6s cubic-bezier(.22,1,.36,1) both; }
.qx-log-line     { animation: qx-log-in .22s cubic-bezier(.22,1,.36,1) both; }
.qx-tail-in      { animation: qx-tail-in .25s cubic-bezier(.22,1,.36,1) both; }

.qx-panel {
  background: rgba(0, 0, 0, 0.4); backdrop-filter: blur(24px); box-shadow: 0 0 40px -15px rgba(0,0,0,0.5);
  border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 24px;
}

/* This grid used to animate background-position, which forces the browser
   to repaint the entire panel every frame, forever — the same underlying
   issue fixed elsewhere in the app (Login card, etc.). It isn't currently
   applied anywhere in this file's JSX, but kept fixed here as a
   compositor-only transform so it stays safe if it's used again later. */
.qx-grid-bg {
  background-image:
    linear-gradient(rgba(52,211,153,.028) 1px, transparent 1px),
    linear-gradient(90deg, rgba(52,211,153,.028) 1px, transparent 1px);
  background-size: 48px 48px;
  animation: qx-drift 16s linear infinite;
  will-change: transform;
}

.qx-spin-slow {
  transform-box: view-box;
  transform-origin: center;
  animation: qx-spin 26s linear infinite;
}

.qx-arc { transition: stroke-dashoffset 1.1s cubic-bezier(.22,1,.36,1); }

.qx-scroll::-webkit-scrollbar { width: 5px; height: 5px; }
.qx-scroll::-webkit-scrollbar-track { background: transparent; }
.qx-scroll::-webkit-scrollbar-thumb { background: rgba(52,211,153,.18); border-radius: 99px; }
.qx-scroll::-webkit-scrollbar-thumb:hover { background: rgba(52,211,153,.38); }

.qx-run {
  position: relative;
  overflow: hidden;
  clip-path: polygon(9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%, 0 9px);
  transition: all .25s cubic-bezier(.22,1,.36,1);
}
.qx-run::before {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, rgba(52,211,153,.14), transparent);
  opacity: 0;
  transition: opacity .3s;
}
/* Was animating background-position continuously (via qx-shimmer)
   whenever hovered — same repaint-per-frame cost as the grid above, just
   scoped to hover state instead of always-on. Now a translate3d sweep on
   the same element, compositor-only. Only runs while :hover is active
   (the animation is declared on the hover rule itself), so it's not even
   ticking at all the rest of the time. */
.qx-run:hover::before {
  opacity: 1;
  animation: qx-shimmer 2.8s linear infinite;
  will-change: transform;
}
.qx-run:hover { box-shadow: 0 4px 22px -4px rgba(52,211,153,.4); }
.qx-run:active { transform: scale(.96); }

.qx-chamfer { clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px); }

.qx-input-shell:focus-within {
  border-color: rgba(52,211,153,.45);
  box-shadow: 0 0 0 1px rgba(52,211,153,.12), 0 0 26px -6px rgba(52,211,153,.28), inset 0 0 14px -8px rgba(52,211,153,.15);
}

.qx-telemetry-row { transition: background .25s ease; }
.qx-telemetry-row:hover { background: rgba(255,255,255,.02); }

@media (prefers-reduced-motion: reduce) {
  .qx-grid-bg { animation: none; }
  .qx-run:hover::before { animation: none; opacity: 0; }
}
`;

/* ═══════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════ */

const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

const levelOf = (raw: string): LogLevel => {
  const l = stripAnsi(raw);
  // Case-insensitive "error"/"exception"/"fatal" catches both game-server
  // log conventions (usually ALL CAPS, e.g. "[ERROR]") and our own
  // panel-injected system messages (e.g. "[System Error]"), which use
  // normal title case and were previously falling through to "info".
  if (/error|exception|fatal/i.test(l)) return "error";
  if (/warn/i.test(l)) return "warn";
  return "info";
};

/* ═══════════════════════════════════════════════════════
   CORNER BRACKETS — rack-mount hardware detail
═══════════════════════════════════════════════════════ */

function Corners({ tone = "border-emerald-400/25" }: { tone?: string }) {
  const base = "pointer-events-none absolute w-3.5 h-3.5 z-10";
  return (
    <>
      <span className={`${base} -top-px -left-px border-t-2 border-l-2 ${tone}`} />
      <span className={`${base} -top-px -right-px border-t-2 border-r-2 ${tone}`} />
      <span className={`${base} -bottom-px -left-px border-b-2 border-l-2 ${tone}`} />
      <span className={`${base} -bottom-px -right-px border-b-2 border-r-2 ${tone}`} />
    </>
  );
}

/* ═══════════════════════════════════════════════════════
   RADIAL DIAL — ticks, sweep arc, idle activity ring
═══════════════════════════════════════════════════════ */

function Dial({
  pct,
  color,
  glow,
  icon,
  armed,
}: {
  pct: number;
  color: string;
  glow: string;
  icon: React.ReactNode;
  armed: boolean;
}) {
  const R = 30;
  const C = 2 * Math.PI * R;
  const off = armed ? C - (Math.min(pct, 100) / 100) * C : C;

  return (
    <div className="relative w-[76px] h-[76px] shrink-0">
      <svg viewBox="0 0 84 84" className="w-full h-full">
        {/* tick ring */}
        {Array.from({ length: 20 }).map((_, i) => {
          const a = (i / 20) * Math.PI * 2 - Math.PI / 2;
          const major = i % 5 === 0;
          const r1 = 37.5;
          const r2 = major ? 41 : 39.5;
          return (
            <line
              key={i}
              x1={42 + Math.cos(a) * r1}
              y1={42 + Math.sin(a) * r1}
              x2={42 + Math.cos(a) * r2}
              y2={42 + Math.sin(a) * r2}
              stroke={major ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.07)"}
              strokeWidth={major ? 1.2 : 1}
            />
          );
        })}

        {/* idle activity ring */}
        <circle
          cx="42" cy="42" r="22"
          fill="none"
          stroke={color}
          strokeOpacity="0.14"
          strokeWidth="1"
          strokeDasharray="2 5"
          className="qx-spin-slow"
        />

        {/* track + value arc */}
        <g transform="rotate(-90 42 42)">
          <circle cx="42" cy="42" r={R} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" />
          <circle
            cx="42" cy="42" r={R}
            fill="none"
            stroke={color}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={off}
            className="qx-arc"
            style={{ filter: `drop-shadow(0 0 5px ${glow})` }}
          />
        </g>
      </svg>

      <div className="absolute inset-0 flex items-center justify-center">
        <span style={{ color, filter: `drop-shadow(0 0 4px ${glow})` }}>{icon}</span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   ANIMATED NUMBER — eased rAF counter
═══════════════════════════════════════════════════════ */

function AnimNum({ value, decimals = 1 }: { value: number; decimals?: number }) {
  const [disp, setDisp] = useState(value);
  const prev = useRef(value);
  const raf = useRef(0);

  useEffect(() => {
    const from = prev.current;
    const to = value;
    const dur = 700;
    const t0 = performance.now();

    const tick = (now: number) => {
      const p = Math.min((now - t0) / dur, 1);
      const e = 1 - Math.pow(1 - p, 4);
      setDisp(from + (to - from) * e);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else prev.current = to;
    };

    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);

  return <span className="tabular-nums">{disp.toFixed(decimals)}</span>;
}

/* ═══════════════════════════════════════════════════════
   SPARKLINE — now shared via components/Sparkline.tsx, imported at the
   top of this file. See that component for implementation.
═══════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════
   SEGMENTED DRIVE BAR — storage bay indicator
═══════════════════════════════════════════════════════ */

function DriveBar({ pct }: { pct: number }) {
  const SEGS = 14;
  const filled = Math.round((Math.min(pct, 100) / 100) * SEGS);
  return (
    <div className="flex gap-[3px] w-[118px]">
      {Array.from({ length: SEGS }).map((_, i) => (
        <span
          key={i}
          className={`h-3.5 flex-1 rounded-[2px] transition-all duration-500 ${
            i < filled
              ? "bg-amber-400/85 shadow-[0_0_6px_rgba(251,191,36,0.45)]"
              : "bg-white/[0.06]"
          }`}
          style={{ transitionDelay: `${i * 35}ms` }}
        />
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   CONNECTION PILL + CLOCK
═══════════════════════════════════════════════════════ */

function ConnPill({ live }: { live: boolean }) {
  return (
    <span className="flex items-center gap-2 px-3 py-1 rounded-sm border border-white/[0.07] bg-white/[0.03]">
      <span className="relative flex h-2 w-2">
        {live && (
          <span
            className="absolute inset-0 rounded-full bg-emerald-400"
            style={{ animation: "qx-ping 1.6s cubic-bezier(0,0,0.2,1) infinite" }}
          />
        )}
        <span
          className={`relative rounded-full h-2 w-2 transition-colors duration-500 ${
            live
              ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]"
              : "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.9)]"
          }`}
        />
      </span>
      <span
        className={`qx-display text-[9px] font-bold uppercase tracking-[0.18em] transition-colors duration-500 ${
          live ? "text-emerald-400" : "text-red-400"
        }`}
      >
        {live ? "Live" : "Offline"}
      </span>
    </span>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const iv = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(iv);
  }, []);
  return (
    <span className="qx-mono text-[11px] text-slate-400 tabular-nums tracking-tight">
      {now.toLocaleTimeString("en-GB", { hour12: false })}
    </span>
  );
}

/* ═══════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════ */

export default function ServerConsole({ serverId, server, onPlayersChange }: ServerConsoleProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [players, setPlayers] = useState<Player[]>([]);
  const [stats, setStats] = useState<ServerStats>(DEFAULT_STATS);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [ramHist, setRamHist] = useState<number[]>([]);
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [filter, setFilter] = useState<LogFilter>("all");
  const [atBottom, setAtBottom] = useState(true);
  const [copied, setCopied] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sockRef = useRef<Socket | null>(null);
  const { token } = useAuth();

  useEffect(() => {
    const t = setTimeout(() => setReady(true), 60);
    return () => clearTimeout(t);
  }, []);

  /* ── Socket stream ── */
  useEffect(() => {
    if (!token || !serverId) return;

    const socket: Socket = io({
      auth: { token },
      transports: ["websocket", "polling"],
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });
    sockRef.current = socket;

    let hasConnectedBefore = false;
    const expectSnapshotRef = { current: false };

    socket.on("connect", () => {
      socket.emit("joinServer", serverId);
      setConnected(true);
      if (hasConnectedBefore) {
        // This is a reconnect (network blip, phone lock, etc.), not the
        // initial connection. The server will re-send up to its last 100
        // lines as a fresh snapshot via "log" right after joinServer — mark
        // that the next log event should replace the buffer rather than
        // append to it, otherwise every reconnect duplicates up to 100
        // lines on top of what's already shown (and can evict genuinely
        // new lines once the MAX_LOG_LINES cap is hit).
        expectSnapshotRef.current = true;
        setLogs((p) => [...p, "[System] Reconnected — refreshing log buffer."]);
      } else {
        hasConnectedBefore = true;
        setLogs((p) => [...p, "[System] Connected to console stream."]);
      }
    });

    socket.on("log", (data: string) => {
      if (typeof data !== "string") return;
      const lines = data.split(/\r?\n/).filter((l) => l.trim());

      setPlayers((prev) => {
        let u = [...prev];
        let ch = false;
        for (const raw of lines) {
          const c = stripAnsi(raw);

          const jm = c.match(/:\s+([a-zA-Z0-9_]{3,16})\s+joined the game/);
          if (jm && !u.some((p) => p.name === jm[1])) {
            u.push({ name: jm[1] });
            ch = true;
          }

          const lm = c.match(/:\s+([a-zA-Z0-9_]{3,16})\s+left the game/);
          if (lm) {
            const f = u.filter((p) => p.name !== lm[1]);
            if (f.length !== u.length) { u = f; ch = true; }
          }

          const pm = c.match(/players online:\s*(.*)/i);
          if (pm) {
            const s = pm[1].trim();
            u = s
              ? s.split(",").map((n) => n.trim()).filter(Boolean).map((name) => ({ name }))
              : [];
            ch = true;
          }
        }
        if (ch) onPlayersChange?.(u);
        return ch ? u : prev;
      });

      setLogs((prev) => {
        const base = expectSnapshotRef.current ? [] : prev;
        expectSnapshotRef.current = false;
        const next = [...base, ...lines];
        return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
      });
    });

    socket.on("disconnect", (r: string) => {
      setConnected(false);
      setLogs((p) => [...p, `[System] Disconnected. (${r})`]);
    });

    socket.on("connect_error", (e: Error) => {
      setConnected(false);
      setLogs((p) => [...p, `[System Error] ${e.message}`]);
    });

    return () => {
      socket.emit("leaveServer", serverId);
      socket.removeAllListeners();
      socket.disconnect();
      sockRef.current = null;
    };
  }, [serverId, token]);

  /* ── Initial player list ── */
  useEffect(() => {
    if (!serverId) return;
    const t = setTimeout(() => {
      axios.post(`/api/servers/${serverId}/command`, { command: "list" }).catch(() => {});
    }, LIST_DELAY_MS);
    return () => clearTimeout(t);
  }, [serverId]);

  /* ── Stats polling + history ── */
  useEffect(() => {
    if (!serverId) return;
    let alive = true;

    const pull = async () => {
      try {
        const { data } = await axios.get<ServerStats>(`/api/servers/${serverId}/stats`);
        if (alive && data) {
          setStats((p) => ({
            cpu: data.cpu ?? p.cpu,
            ram: data.ram ?? p.ram,
            disk: data.disk ?? p.disk,
            limitRam: data.limitRam ?? p.limitRam,
            limitCpu: data.limitCpu ?? p.limitCpu,
            limitDisk: data.limitDisk ?? p.limitDisk,
          }));
          setCpuHist((h) => [...h, data.cpu ?? 0].slice(-SPARK_CAP));
          setRamHist((h) => [...h, data.ram ?? 0].slice(-SPARK_CAP));
        }
      } catch { /* retry next tick */ }
    };

    pull();
    const iv = setInterval(pull, STATS_POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [serverId]);

  /* ── Auto-scroll (respects user scroll position) ── */
  useEffect(() => {
    if (atBottom && bodyRef.current) {
      bodyRef.current.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [logs, atBottom]);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const d = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = d < 48;
    setAtBottom((prev) => (prev === near ? prev : near));
  }, []);

  const jumpToBottom = useCallback(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  }, []);

  /* ── "/" focuses the command line ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && (e.target as HTMLElement).tagName !== "INPUT") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ── Command submit ── */
  const send = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const cmd = command.trim();
      if (!cmd) return;
      setCommand("");
      setCmdHistory((h) => [cmd, ...h].slice(0, 50));
      setHistIdx(-1);
      try {
        await axios.post(`/api/servers/${serverId}/command`, { command: cmd });
      } catch {
        setLogs((p) => [...p, "[System Error] Failed to send command."]);
      }
    },
    [command, serverId]
  );

  /* ── Command history: ↑ / ↓ ── */
  const onInputKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHistIdx((i) => {
          const next = Math.min(i + 1, cmdHistory.length - 1);
          if (cmdHistory[next]) setCommand(cmdHistory[next]);
          return next;
        });
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHistIdx((i) => {
          const next = i - 1;
          if (next < 0) { setCommand(""); return -1; }
          setCommand(cmdHistory[next]);
          return next;
        });
      }
    },
    [cmdHistory]
  );

  /* ── Copy + clear ── */
  const copyLogs = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(logs.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }, [logs]);

  /* ── Log line renderer ── */
  const renderLine = useCallback((raw: string): React.ReactNode => {
    const log = stripAnsi(raw);
    const ts = log.match(/^(\[\d{2}:\d{2}:\d{2}\s[^\]]+\]|\d{2}:\d{2}:\d{2})/);
    const level = levelOf(raw);

    let text = "text-slate-400";
    let rail = "bg-slate-600/40";

    if (level === "error") { text = "text-rose-400 font-medium"; rail = "bg-rose-500/70"; }
    else if (level === "warn") { text = "text-amber-300/90"; rail = "bg-amber-400/70"; }
    else if (log.startsWith(">")) { text = "text-emerald-300 font-semibold"; rail = "bg-emerald-400/70"; }
    else if (log.startsWith("[System")) { text = "text-emerald-300/75 italic"; rail = "bg-emerald-400/60"; }
    else if (log.includes("INFO")) { text = "text-sky-200/85"; rail = "bg-sky-500/50"; }

    return (
      <span className={`flex-1 flex items-stretch min-w-0`}>
        <span className={`w-[3px] shrink-0 rounded-full mr-3 self-stretch ${rail}`} />
        <span className={`break-words whitespace-pre-wrap min-w-0 ${text}`}>
          {ts && <span className="text-white/20 mr-2 select-none">{ts[0]}</span>}
          {ts ? log.substring(ts[0].length) : log}
        </span>
      </span>
    );
  }, []);

  /* ── Derived ── */
  const cpuPct = useMemo(() => (stats.cpu / (stats.limitCpu || 1)) * 100, [stats.cpu, stats.limitCpu]);
  const ramPct = useMemo(() => (stats.ram / (stats.limitRam || 1)) * 100, [stats.ram, stats.limitRam]);
  const diskPct = useMemo(() => (stats.disk / (stats.limitDisk || 1)) * 100, [stats.disk, stats.limitDisk]);

  const counts = useMemo(() => {
    const c = { all: logs.length, info: 0, warn: 0, error: 0 };
    for (const l of logs) c[levelOf(l)]++;
    return c;
  }, [logs]);

  const visible = useMemo(
    () =>
      logs
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => filter === "all" || levelOf(l) === filter),
    [logs, filter]
  );

  /* ═══════════════════════ RENDER ═══════════════════════ */
  return (
    <>
      <style>{STYLES}</style>
      <div className="absolute inset-0 overflow-y-auto text-white touch-auto overscroll-y-auto qx-scroll bg-transparent">
        <div className="relative flex flex-col xl:flex-row w-full max-w-[1440px] mx-auto min-h-full gap-5 p-4 md:p-6 pb-24 md:pb-10">
          {/* ═══════════ LEFT RAIL — TELEMETRY ═══════════ */}
          <aside
            className={`flex flex-col gap-5 xl:w-[380px] shrink-0 order-2 xl:order-1 ${
              ready ? "qx-enter-left" : "opacity-0"
            }`}
          >
            {/* Telemetry panel */}
            <section className="qx-panel rounded-[24px] relative overflow-hidden">
              
              {/* header */}
              <div className="flex items-center justify-between px-4 pt-3.5 pb-1">
                <h2 className="qx-display text-[10px] font-bold uppercase tracking-[0.3em] text-slate-300">
                  Telemetry
                </h2>
                <span className="flex items-center gap-1.5 qx-mono text-[9px] text-slate-500">
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block"
                    style={{ animation: "qx-rec 2s ease-in-out infinite" }}
                  />
                  poll {STATS_POLL_MS / 1000}s
                </span>
              </div>

              {/* CPU */}
              <div className="qx-telemetry-row flex items-center gap-4 px-4 py-3.5">
                <Dial pct={cpuPct} color="#34d399" glow="rgba(52,211,153,0.55)" icon={<Cpu size={15} />} armed={ready} />
                <div className="flex-1 min-w-0">
                  <p className="qx-display text-[9px] font-semibold uppercase tracking-[0.24em] text-slate-500 mb-1">
                    CPU Load
                  </p>
                  <p className="qx-mono text-[22px] font-bold leading-none text-emerald-300">
                    <AnimNum value={stats.cpu} />
                    <span className="text-[11px] text-emerald-300/50 ml-0.5">%</span>
                  </p>
                  <p className="qx-mono text-[9px] text-slate-600 mt-1">cap {stats.limitCpu}%</p>
                </div>
                <Sparkline data={cpuHist} color="#34d399" max={stats.limitCpu || 100} w={118} h={28} cap={SPARK_CAP} />
              </div>

              <div className="mx-4 border-t border-white/[0.05]" />

              {/* RAM */}
              <div className="qx-telemetry-row flex items-center gap-4 px-4 py-3.5">
                <Dial pct={ramPct} color="#4ade80" glow="rgba(74,222,128,0.55)" icon={<MemoryStick size={15} />} armed={ready} />
                <div className="flex-1 min-w-0">
                  <p className="qx-display text-[9px] font-semibold uppercase tracking-[0.24em] text-slate-500 mb-1">
                    Memory
                  </p>
                  <p className="qx-mono text-[22px] font-bold leading-none text-emerald-300">
                    <AnimNum value={Math.floor(stats.ram)} decimals={0} />
                    <span className="text-[11px] text-emerald-300/50 ml-1">MB</span>
                  </p>
                  <p className="qx-mono text-[9px] text-slate-600 mt-1">cap {stats.limitRam} MB</p>
                </div>
                <Sparkline data={ramHist} color="#4ade80" max={stats.limitRam || 1024} w={118} h={28} cap={SPARK_CAP} />
              </div>

              <div className="mx-4 border-t border-white/[0.05]" />

              {/* DISK */}
              <div className="qx-telemetry-row flex items-center gap-4 px-4 py-3.5">
                <Dial pct={diskPct} color="#fbbf24" glow="rgba(251,191,36,0.55)" icon={<HardDrive size={15} />} armed={ready} />
                <div className="flex-1 min-w-0">
                  <p className="qx-display text-[9px] font-semibold uppercase tracking-[0.24em] text-slate-500 mb-1">
                    Storage
                  </p>
                  <p className="qx-mono text-[22px] font-bold leading-none text-amber-300">
                    <AnimNum value={stats.disk} />
                    <span className="text-[11px] text-amber-300/50 ml-1">GB</span>
                  </p>
                  <p className="qx-mono text-[9px] text-slate-600 mt-1">cap {stats.limitDisk} GB</p>
                </div>
                <DriveBar pct={diskPct} />
              </div>
            </section>



            {/* Players — Discord bots don't have "players", so this panel
                (which polls console output for a "players online:" line
                that will never appear for a bot process) is hidden rather
                than shown empty, which would just look broken. */}
            {server?.game !== "discord-bot" && (
              <section
                className={`flex-1 xl:min-h-0 qx-panel rounded-[24px] relative overflow-hidden flex flex-col ${
                  ready ? "qx-enter" : "opacity-0"
                }`}
                style={{ animationDelay: "300ms" }}
              >
                
                <div className="absolute top-0 inset-x-0 h-[1px] bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />
                <span className="absolute top-2.5 right-3 z-10 qx-mono text-[9px] px-2 py-0.5 rounded-sm bg-emerald-400/10 text-emerald-300 border border-emerald-400/20 tabular-nums">
                  {players.length} online
                </span>
                <PlayerManager serverId={serverId} players={players} />
              </section>
            )}
          </aside>

          {/* ═══════════ RIGHT — CONSOLE ═══════════ */}
          <section
            className={`flex flex-col flex-1 h-[64vh] xl:h-[calc(100vh-120px)] qx-panel rounded-[24px] overflow-hidden relative order-1 xl:order-2 ${
              ready ? "qx-enter-right" : "opacity-0"
            }`}
            style={{
              animationDelay: "80ms",
              boxShadow:
                "0 0 40px -15px rgba(0,0,0,0.5)",
            }}
          >
            

            {/* ── Header ── */}
            <header className="px-4 md:px-5 py-3 flex items-center justify-between gap-3 border-b border-white/[0.05] relative z-10">
              <div className="flex items-center gap-[7px] shrink-0">
                {["bg-[#ff5f57]", "bg-[#febc2e]", "bg-[#28c840]"].map((c, i) => (
                  <span
                    key={i}
                    className={`w-[11px] h-[11px] rounded-full ${c} opacity-80 hover:opacity-100 hover:scale-125 transition-all duration-200 cursor-default`}
                  />
                ))}
              </div>

              <div className="flex items-center gap-2.5 min-w-0">
                <XTerm size={13} className="text-emerald-400/80 shrink-0" />
                <div className="min-w-0 text-center">
                  <h1 className="qx-display text-[11px] font-bold tracking-[0.3em] text-slate-200 uppercase truncate">
                    System Console
                  </h1>
                  <p className="qx-mono text-[9px] text-slate-600 truncate">
                    stream :: {serverId}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <span className="hidden sm:block">
                  <Clock />
                </span>
                <ConnPill live={connected} />
              </div>
            </header>



            {/* ── Log body ── */}
            <div
              ref={bodyRef}
              onScroll={onScroll}
              className="flex-1 overflow-y-auto px-4 md:px-5 py-4 qx-mono text-[11px] md:text-xs leading-[1.75] qx-scroll relative z-10"
              style={{ WebkitOverflowScrolling: "touch" }}
              role="log"
              aria-live="polite"
              aria-label="Server console output"
            >
              {logs.length === 0 && (
                <div className="flex items-center gap-2 text-white/25 py-2">
                  <span className="text-emerald-400/70">❯</span>
                  <span>Awaiting connection</span>
                  <span className="flex gap-[3px] ml-1">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="w-[4px] h-[4px] rounded-full bg-emerald-400/60 inline-block"
                        style={{
                          animation: "qx-dot-bounce 1.4s ease-in-out infinite",
                          animationDelay: `${i * 0.18}s`,
                        }}
                      />
                    ))}
                  </span>
                </div>
              )}

              {logs.length > 0 && visible.length === 0 && (
                <div className="text-white/25 py-2 italic">
                  No “{filter}” lines in buffer.
                </div>
              )}

              {visible.map(({ l, i }) => (
                <div
                  key={i}
                  className="qx-log-line flex items-start py-[3px] px-2 -mx-2 rounded-sm hover:bg-white/[0.03] transition-colors duration-150 group"
                  style={{ animationDelay: `${Math.min(i * 10, 200)}ms` }}
                >
                  <span className="text-white/[0.12] group-hover:text-emerald-300/50 mr-3 select-none shrink-0 w-9 text-right text-[10px] leading-[1.75] transition-colors duration-200 tabular-nums">
                    {i + 1}
                  </span>
                  {renderLine(l)}
                </div>
              ))}

              {visible.length > 0 && (
                <div className="flex items-center py-[3px] px-2 -mx-2">
                  <span className="w-9 mr-3 shrink-0" />
                  <span
                    className="text-emerald-400/50 text-xs select-none"
                    style={{ animation: "qx-blink 1.1s step-end infinite" }}
                  >
                    ▋
                  </span>
                </div>
              )}
            </div>

            {/* ── Jump-to-tail ── */}
            {!atBottom && logs.length > 0 && (
              <button
                onClick={jumpToBottom}
                className="qx-tail-in absolute bottom-32 right-5 z-20 flex items-center gap-1.5 qx-display text-[9px] font-bold uppercase tracking-[0.14em] px-3 py-1.5 bg-black/35 backdrop-blur-md text-emerald-300 border border-emerald-400/30 rounded-sm shadow-[0_4px_20px_-4px_rgba(52,211,153,0.4)] hover:bg-emerald-400/10 transition-colors"
              >
                <ChevronDown size={11} className="animate-bounce" />
                Tail
              </button>
            )}

            {/* ── Quick commands ── */}
            {/* These are Minecraft RCON commands and don't apply to a
                Discord bot process (no such command surface exists), so
                the bar is hidden rather than shown non-functional. */}
            {server?.game !== "discord-bot" && (
              <div className="px-3 md:px-4 pt-2.5 pb-1 flex items-center gap-1.5 overflow-x-auto qx-scroll relative z-10 border-t border-white/[0.05] bg-black/20 backdrop-blur-md">
                <span className="qx-display text-[8px] font-bold uppercase tracking-[0.22em] text-slate-600 shrink-0 mr-1">
                  Quick
                </span>
                {QUICK_COMMANDS.map((q) => (
                  <button
                    key={q.cmd}
                    onClick={() => {
                      setCommand(q.cmd);
                      inputRef.current?.focus();
                    }}
                    className={`qx-mono text-[10px] px-2.5 py-1 rounded-sm border whitespace-nowrap transition-all duration-200 hover:-translate-y-px active:translate-y-0 ${
                      q.danger
                        ? "text-rose-400/80 border-rose-500/20 hover:border-rose-400/50 hover:bg-rose-500/10 hover:text-rose-300"
                        : "text-slate-400 border-white/[0.08] hover:border-emerald-400/40 hover:bg-emerald-400/[0.07] hover:text-emerald-300"
                    }`}
                  >
                    {q.label}
                  </button>
                ))}
                <span className="qx-mono text-[9px] text-slate-700 ml-auto shrink-0 hidden md:block">
                  press <kbd className="text-slate-500 border border-white/10 rounded-sm px-1">/</kbd> to focus
                </span>
              </div>
            )}

            {/* ── Command bar ── */}
            <form
              onSubmit={send}
              className="px-3 md:px-4 py-3 flex gap-2.5 relative z-10 bg-black/30 backdrop-blur-md"
            >
              <div className="qx-input-shell flex-1 flex items-center rounded-md px-4 border border-white/[0.08] bg-white/[0.03] transition-all duration-300">
                <span className="text-emerald-400/80 qx-mono text-xs mr-3 select-none font-semibold whitespace-nowrap">
                  admin@node:~$
                </span>
                <input
                  ref={inputRef}
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  onKeyDown={onInputKey}
                  className="flex-1 bg-transparent py-3 text-emerald-50/90 focus:outline-none qx-mono text-xs placeholder:text-white/15 caret-emerald-400 min-w-0"
                  placeholder="Type a command…"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Server command input"
                />
                {command && (
                  <kbd className="hidden md:inline-block qx-mono text-[9px] text-white/20 border border-white/10 rounded-sm px-1.5 py-0.5 ml-2 select-none">
                    ↵
                  </kbd>
                )}
              </div>

              <button
                type="submit"
                disabled={!command.trim()}
                className="qx-run qx-display shrink-0 px-4 sm:px-6 md:px-7 py-3 text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-200 bg-emerald-400/[0.12] border border-emerald-400/30 disabled:opacity-30 disabled:pointer-events-none whitespace-nowrap"
              >
                Execute
              </button>
            </form>
          </section>
        </div>
      </div>
    </>
  );
}
