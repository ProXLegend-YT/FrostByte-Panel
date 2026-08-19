import React, { useState, useEffect } from "react";
import axios from "axios";
import {
  Clock, Plus, Trash2, RefreshCw, Archive, Terminal, Play, Square,
  AlertTriangle, CheckCircle2, XCircle, Power,
} from "lucide-react";

interface ScheduledTask {
  id: string;
  name: string;
  action: "restart" | "backup" | "command" | "stop" | "start";
  commandText?: string;
  recurrence: {
    frequency: "interval" | "daily" | "weekly";
    intervalMinutes?: number;
    hour?: number;
    minute?: number;
    dayOfWeek?: number;
  };
  enabled: boolean;
  lastRunAt?: string;
  lastRunStatus?: "success" | "error";
  lastRunMessage?: string;
  nextRunAt: string;
}

const ACTION_META: Record<ScheduledTask["action"], { label: string; icon: React.ReactNode; color: string }> = {
  restart: { label: "Restart server", icon: <RefreshCw className="w-4 h-4" />, color: "text-orange-400" },
  backup: { label: "Create backup", icon: <Archive className="w-4 h-4" />, color: "text-cyan-400" },
  command: { label: "Run command", icon: <Terminal className="w-4 h-4" />, color: "text-violet-400" },
  stop: { label: "Stop server", icon: <Square className="w-4 h-4" />, color: "text-red-400" },
  start: { label: "Start server", icon: <Play className="w-4 h-4" />, color: "text-emerald-400" },
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function describeRecurrence(r: ScheduledTask["recurrence"]): string {
  if (r.frequency === "interval") {
    const mins = r.intervalMinutes || 60;
    if (mins % 1440 === 0) return `Every ${mins / 1440} day${mins / 1440 > 1 ? "s" : ""}`;
    if (mins % 60 === 0) return `Every ${mins / 60} hour${mins / 60 > 1 ? "s" : ""}`;
    return `Every ${mins} minutes`;
  }
  const time = `${String(r.hour ?? 3).padStart(2, "0")}:${String(r.minute ?? 0).padStart(2, "0")}`;
  if (r.frequency === "weekly") return `Every ${WEEKDAYS[r.dayOfWeek ?? 0]} at ${time}`;
  return `Daily at ${time}`;
}

function formatRelative(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  const label =
    mins < 60 ? `${mins}m` :
    mins < 1440 ? `${Math.round(mins / 60)}h` :
    `${Math.round(mins / 1440)}d`;
  return diffMs >= 0 ? `in ${label}` : `${label} ago`;
}

export default function ScheduledTasks({ serverId }: { serverId: string }) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [action, setAction] = useState<ScheduledTask["action"]>("restart");
  const [commandText, setCommandText] = useState("");
  const [frequency, setFrequency] = useState<"interval" | "daily" | "weekly">("daily");
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [hour, setHour] = useState(3);
  const [minute, setMinute] = useState(0);
  const [dayOfWeek, setDayOfWeek] = useState(0);

  const fetchTasks = async () => {
    try {
      const res = await axios.get(`/api/servers/${serverId}/schedule`);
      setTasks(res.data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
    // Refresh periodically so "next run" / "last run" stay current without
    // requiring a manual reload — scheduled tasks are inherently a
    // time-based view.
    const interval = setInterval(fetchTasks, 30000);
    return () => clearInterval(interval);
  }, [serverId]);

  const resetForm = () => {
    setName("");
    setAction("restart");
    setCommandText("");
    setFrequency("daily");
    setIntervalMinutes(60);
    setHour(3);
    setMinute(0);
    setDayOfWeek(0);
    setError(null);
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError("Give this task a name.");
      return;
    }
    if (action === "command" && !commandText.trim()) {
      setError("Enter the console command to run.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const recurrence =
        frequency === "interval"
          ? { frequency, intervalMinutes }
          : frequency === "weekly"
          ? { frequency, hour, minute, dayOfWeek }
          : { frequency, hour, minute };

      await axios.post(`/api/servers/${serverId}/schedule`, {
        name: name.trim(),
        action,
        commandText: action === "command" ? commandText.trim() : undefined,
        recurrence,
      });
      resetForm();
      setShowForm(false);
      fetchTasks();
    } catch (e: any) {
      setError(e.response?.data?.error || "Failed to create task.");
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (task: ScheduledTask) => {
    try {
      await axios.put(`/api/servers/${serverId}/schedule/${task.id}`, { enabled: !task.enabled });
      fetchTasks();
    } catch (e) {
      console.error(e);
    }
  };

  const handleDelete = async (task: ScheduledTask) => {
    try {
      await axios.delete(`/api/servers/${serverId}/schedule/${task.id}`);
      fetchTasks();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar p-4 md:p-8 text-white bg-transparent">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl md:text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60 flex items-center">
              <Clock className="w-6 h-6 mr-2 text-cyan-400" /> Scheduled Tasks
            </h2>
            <p className="text-[11px] font-bold text-cyan-300/80 uppercase tracking-widest mt-1">
              Automate restarts, backups, and commands on a recurring schedule.
            </p>
          </div>
          <button
            onClick={() => { setShowForm((v) => !v); resetForm(); }}
            className="px-4 py-2 bg-accent hover:bg-accent-dark text-black font-semibold rounded-xl text-sm flex items-center gap-2 transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" /> New Task
          </button>
        </div>

        {showForm && (
          <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-2xl p-5 space-y-4 ring-1 ring-white/5">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2">Task name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nightly backup"
                className="w-full bg-white/[0.02] border border-white/10 rounded-lg py-2.5 px-4 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-cyan-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2">Action</label>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {(Object.keys(ACTION_META) as ScheduledTask["action"][]).map((a) => (
                  <button
                    key={a}
                    onClick={() => setAction(a)}
                    className={`px-3 py-2.5 rounded-lg text-xs font-medium flex flex-col items-center gap-1.5 transition-colors border ${
                      action === a ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-300" : "bg-white/[0.02] border-white/10 text-zinc-400 hover:border-white/20"
                    }`}
                  >
                    {ACTION_META[a].icon}
                    {ACTION_META[a].label}
                  </button>
                ))}
              </div>
            </div>

            {action === "command" && (
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-2">Console command</label>
                <input
                  type="text"
                  value={commandText}
                  onChange={(e) => setCommandText(e.target.value)}
                  placeholder="say Server restarting in 5 minutes"
                  className="w-full bg-white/[0.02] border border-white/10 rounded-lg py-2.5 px-4 text-sm text-white font-mono placeholder-zinc-500 focus:outline-none focus:border-cyan-500 transition-colors"
                />
                <p className="text-xs text-zinc-500 mt-2">Only runs while the server is online — skipped otherwise.</p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2">Repeats</label>
              <div className="flex gap-2 mb-3">
                {(["daily", "weekly", "interval"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFrequency(f)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                      frequency === f ? "bg-cyan-500/20 text-cyan-300" : "bg-white/[0.03] text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>

              {frequency === "interval" ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-zinc-400">Every</span>
                  <input
                    type="number"
                    min={5}
                    max={10080}
                    value={intervalMinutes}
                    onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                    className="w-24 bg-white/[0.02] border border-white/10 rounded-lg py-1.5 px-3 text-sm text-white focus:outline-none focus:border-cyan-500"
                  />
                  <span className="text-sm text-zinc-400">minutes</span>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {frequency === "weekly" && (
                    <select
                      value={dayOfWeek}
                      onChange={(e) => setDayOfWeek(Number(e.target.value))}
                      className="bg-white/[0.02] border border-white/10 rounded-lg py-1.5 px-3 text-sm text-white focus:outline-none focus:border-cyan-500"
                    >
                      {WEEKDAYS.map((d, i) => (
                        <option key={d} value={i} className="bg-zinc-900">{d}</option>
                      ))}
                    </select>
                  )}
                  <span className="text-sm text-zinc-400">at</span>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={hour}
                    onChange={(e) => setHour(Number(e.target.value))}
                    className="w-16 bg-white/[0.02] border border-white/10 rounded-lg py-1.5 px-3 text-sm text-white text-center focus:outline-none focus:border-cyan-500"
                  />
                  <span className="text-sm text-zinc-400">:</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={minute}
                    onChange={(e) => setMinute(Number(e.target.value))}
                    className="w-16 bg-white/[0.02] border border-white/10 rounded-lg py-1.5 px-3 text-sm text-white text-center focus:outline-none focus:border-cyan-500"
                  />
                  <span className="text-xs text-zinc-500">(server's local time)</span>
                </div>
              )}
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/25 rounded-lg text-sm text-red-300 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleCreate}
                disabled={saving}
                className="px-4 py-2 bg-accent hover:bg-accent-dark text-black font-semibold rounded-lg text-sm transition-colors disabled:opacity-50"
              >
                {saving ? "Creating..." : "Create Task"}
              </button>
              <button
                onClick={() => { setShowForm(false); resetForm(); }}
                className="px-4 py-2 bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 rounded-lg text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-zinc-500 text-sm">Loading tasks...</div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-white/10 rounded-2xl">
            <Clock className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
            <p className="text-zinc-400 text-sm">No scheduled tasks yet.</p>
            <p className="text-zinc-600 text-xs mt-1">Set up automatic backups or restarts to keep the server maintained hands-free.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {tasks.map((task) => {
              const meta = ACTION_META[task.action];
              return (
                <div key={task.id} className={`bg-black/40 backdrop-blur-sm border rounded-2xl p-4 ring-1 transition-colors ${task.enabled ? "border-white/10 ring-white/5" : "border-white/5 ring-transparent opacity-60"}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className={`p-2 rounded-lg bg-white/[0.04] shrink-0 ${meta.color}`}>{meta.icon}</div>
                      <div className="min-w-0">
                        <p className="font-medium text-white truncate">{task.name}</p>
                        <p className="text-xs text-zinc-500 mt-0.5">{meta.label} &middot; {describeRecurrence(task.recurrence)}</p>
                        {task.action === "command" && task.commandText && (
                          <p className="text-xs font-mono text-zinc-600 mt-1 truncate">{task.commandText}</p>
                        )}
                        <div className="flex items-center gap-3 mt-2 text-xs">
                          {task.enabled && (
                            <span className="text-zinc-500">Next run {formatRelative(task.nextRunAt)}</span>
                          )}
                          {task.lastRunAt && (
                            <span className={`flex items-center gap-1 ${task.lastRunStatus === "success" ? "text-emerald-400" : "text-red-400"}`}>
                              {task.lastRunStatus === "success" ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                              Last run {formatRelative(task.lastRunAt)}
                            </span>
                          )}
                        </div>
                        {task.lastRunStatus === "error" && task.lastRunMessage && (
                          <p className="text-xs text-red-400/80 mt-1">{task.lastRunMessage}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => toggleEnabled(task)}
                        title={task.enabled ? "Disable" : "Enable"}
                        className={`p-2 rounded-lg transition-colors ${task.enabled ? "text-emerald-400 bg-emerald-400/10 hover:bg-emerald-400/20" : "text-zinc-500 bg-white/[0.03] hover:bg-white/[0.06]"}`}
                      >
                        <Power className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(task)}
                        title="Delete"
                        className="p-2 text-zinc-500 bg-white/[0.03] hover:bg-red-500/10 hover:text-red-400 rounded-lg transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
