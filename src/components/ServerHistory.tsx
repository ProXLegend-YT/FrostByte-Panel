import React, { useEffect, useState, useMemo } from "react";
import axios from "axios";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { TrendingUp, Cpu, MemoryStick, RefreshCw, AlertCircle } from "lucide-react";

interface Sample {
  t: number;
  cpu: number;
  ram: number;
  disk: number;
}

type Range = "1h" | "6h" | "24h" | "7d" | "30d";

const RANGE_OPTIONS: { key: Range; label: string }[] = [
  { key: "1h", label: "1H" },
  { key: "6h", label: "6H" },
  { key: "24h", label: "24H" },
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
];

// Formats the x-axis differently depending on how wide a window we're
// looking at — showing "14:32" for a 1h view is useful, but showing that
// same format across a 30-day view just produces unreadable clutter, so
// longer ranges fall back to a date instead of a time.
function formatTick(t: number, range: Range): string {
  const d = new Date(t);
  if (range === "1h" || range === "6h") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (range === "24h") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function CustomTooltip({ active, payload, label, range, unit }: any) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="bg-[#0a0e18] border border-white/10 rounded-lg px-3 py-2 text-xs shadow-xl">
      <p className="text-zinc-500 mb-1">{formatTick(label, range)}</p>
      <p className="text-zinc-200 font-mono font-semibold">
        {payload[0].value?.toFixed(1)} {unit}
      </p>
    </div>
  );
}

export default function ServerHistory({ serverId, limitRam, limitCpu }: { serverId: string; limitRam: number; limitCpu: number }) {
  const [range, setRange] = useState<Range>("6h");
  const [samples, setSamples] = useState<Sample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchHistory = async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await axios.get(`/api/servers/${serverId}/stats/history`, { params: { range } });
        if (!cancelled) setSamples(res.data.samples || []);
      } catch (e) {
        if (!cancelled) setError("Couldn't load history for this server.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchHistory();
    // Refresh periodically so the graph keeps moving while the tab is
    // open, without needing a manual reload — every 60s matches the
    // sampler's own interval, so there's no point polling faster.
    const interval = setInterval(fetchHistory, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [serverId, range]);

  const chartData = useMemo(() => samples.map((s) => ({ t: s.t, cpu: s.cpu, ram: s.ram / 1024 })), [samples]);

  const ramLimitGB = limitRam ? limitRam / 1024 : undefined;
  const avgCpu = chartData.length ? chartData.reduce((s, x) => s + x.cpu, 0) / chartData.length : 0;
  const avgRam = chartData.length ? chartData.reduce((s, x) => s + x.ram, 0) / chartData.length : 0;
  const peakCpu = chartData.length ? Math.max(...chartData.map((x) => x.cpu)) : 0;
  const peakRam = chartData.length ? Math.max(...chartData.map((x) => x.ram)) : 0;

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar p-4 md:p-8 text-white bg-transparent">
      <div className="max-w-4xl mx-auto space-y-6 md:space-y-8">
        <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
          <div>
            <h2 className="text-xl md:text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60 mb-1 flex items-center">
              <TrendingUp className="w-6 h-6 mr-2 text-accent" /> Resource History
            </h2>
            <p className="text-[11px] font-bold text-accent-80 uppercase tracking-widest mt-1">
              CPU and memory usage over time
            </p>
          </div>

          <div className="flex bg-white/[0.03] border border-white/10 rounded-xl p-1 shrink-0">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                onClick={() => setRange(opt.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  range === opt.key ? "bg-accent text-black" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-3xl p-8 text-center text-zinc-500 flex flex-col items-center">
            <AlertCircle className="w-8 h-8 mb-3 text-zinc-600" />
            {error}
          </div>
        ) : loading && chartData.length === 0 ? (
          <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-3xl p-8 text-center text-zinc-500 flex flex-col items-center">
            <RefreshCw className="w-6 h-6 animate-spin mb-3 text-accent-50" />
            Loading history...
          </div>
        ) : chartData.length === 0 ? (
          <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-3xl p-8 text-center text-zinc-500 flex flex-col items-center">
            <AlertCircle className="w-8 h-8 mb-3 text-zinc-600" />
            No samples yet for this range — history builds up while the server runs, sampled once a minute.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatChip icon={<Cpu className="w-3.5 h-3.5" />} label="Avg CPU" value={`${avgCpu.toFixed(1)}%`} color="text-accent" />
              <StatChip icon={<Cpu className="w-3.5 h-3.5" />} label="Peak CPU" value={`${peakCpu.toFixed(1)}%`} color="text-accent" />
              <StatChip icon={<MemoryStick className="w-3.5 h-3.5" />} label="Avg RAM" value={`${avgRam.toFixed(1)} GB`} color="text-emerald-400" />
              <StatChip icon={<MemoryStick className="w-3.5 h-3.5" />} label="Peak RAM" value={`${peakRam.toFixed(1)} GB`} color="text-emerald-400" />
            </div>

            <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-3xl p-4 md:p-6 shadow-[0_0_40px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5">
              <h3 className="text-sm font-semibold text-zinc-300 mb-4 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-accent" /> CPU Usage
                {limitCpu ? <span className="text-zinc-600 font-normal">· limit {limitCpu}%</span> : null}
              </h3>
              <div className="h-56 -ml-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="cpuGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="t" tickFormatter={(t) => formatTick(t, range)} stroke="rgba(148,163,184,0.4)" fontSize={11} tickLine={false} axisLine={false} minTickGap={40} />
                    <YAxis stroke="rgba(148,163,184,0.4)" fontSize={11} tickLine={false} axisLine={false} width={36} tickFormatter={(v) => `${v}%`} />
                    <Tooltip content={<CustomTooltip range={range} unit="%" />} />
                    <Area type="monotone" dataKey="cpu" stroke="#22d3ee" strokeWidth={2} fill="url(#cpuGradient)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-3xl p-4 md:p-6 shadow-[0_0_40px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5">
              <h3 className="text-sm font-semibold text-zinc-300 mb-4 flex items-center gap-2">
                <MemoryStick className="w-4 h-4 text-emerald-400" /> Memory Usage
                {ramLimitGB ? <span className="text-zinc-600 font-normal">· limit {ramLimitGB.toFixed(1)} GB</span> : null}
              </h3>
              <div className="h-56 -ml-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="ramGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="t" tickFormatter={(t) => formatTick(t, range)} stroke="rgba(148,163,184,0.4)" fontSize={11} tickLine={false} axisLine={false} minTickGap={40} />
                    <YAxis stroke="rgba(148,163,184,0.4)" fontSize={11} tickLine={false} axisLine={false} width={36} tickFormatter={(v) => `${v}G`} domain={[0, ramLimitGB ? Math.ceil(ramLimitGB * 1.1) : "auto"]} />
                    <Tooltip content={<CustomTooltip range={range} unit="GB" />} />
                    <Area type="monotone" dataKey="ram" stroke="#34d399" strokeWidth={2} fill="url(#ramGradient)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatChip({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-2xl p-3 flex items-center gap-2.5">
      <div className={`${color} shrink-0`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-[10px] text-zinc-500 uppercase tracking-wide truncate">{label}</p>
        <p className={`text-sm font-bold font-mono ${color}`}>{value}</p>
      </div>
    </div>
  );
}
