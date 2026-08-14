import React, { useEffect, useState } from "react";
import axios from "axios";
import { motion } from "framer-motion";
import { Coins, Server, Cpu, MemoryStick, HardDrive, ShoppingBag, History, AlertCircle } from "lucide-react";

interface CoinSettings {
  enabled: boolean;
  currencyName: string;
  currencySymbol: string;
}

interface StoreItem {
  id: string;
  name: string;
  description: string;
  cost: number;
  grant: { type: "maxServers" | "maxRamGb" | "maxCpuPercent" | "maxDiskGb"; amount: number };
}

interface Transaction {
  id: string;
  amount: number;
  balanceAfter: number;
  reason: string;
  type: string;
  createdAt: string;
}

const GRANT_META: Record<string, { icon: React.ReactNode; unit: string }> = {
  maxServers: { icon: <Server className="w-4 h-4" />, unit: "server slot(s)" },
  maxRamGb: { icon: <MemoryStick className="w-4 h-4" />, unit: "GB RAM" },
  maxCpuPercent: { icon: <Cpu className="w-4 h-4" />, unit: "% CPU" },
  maxDiskGb: { icon: <HardDrive className="w-4 h-4" />, unit: "GB disk" },
};

export default function StorePage() {
  const [settings, setSettings] = useState<CoinSettings | null>(null);
  const [items, setItems] = useState<StoreItem[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [purchasingId, setPurchasingId] = useState<string | null>(null);
  const [tab, setTab] = useState<"store" | "history">("store");

  const load = async () => {
    try {
      setLoading(true);
      const [settingsRes, balanceRes] = await Promise.all([
        axios.get("/api/system/coins/settings"),
        axios.get("/api/system/coins/balance"),
      ]);
      setSettings(settingsRes.data);
      setBalance(balanceRes.data.balance);

      if (settingsRes.data.enabled) {
        const [itemsRes, txRes] = await Promise.all([
          axios.get("/api/system/store/items"),
          axios.get("/api/system/coins/transactions"),
        ]);
        setItems(itemsRes.data || []);
        setTransactions(txRes.data || []);
      }
    } catch {
      /* leave state as-is; render below handles null/empty gracefully */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const purchase = async (item: StoreItem) => {
    if (balance === null || balance < item.cost) return;
    if (!confirm(`Redeem ${item.cost} ${settings?.currencySymbol || "coins"} for ${item.name}?`)) return;
    try {
      setPurchasingId(item.id);
      const res = await axios.post("/api/system/store/purchase", { itemId: item.id });
      setBalance(res.data.balance);
      await load();
    } catch (e: any) {
      alert(e.response?.data?.error || "Purchase failed.");
    } finally {
      setPurchasingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <motion.div
          animate={{ scale: [1, 1.2, 1], rotate: [0, 180, 360] }}
          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
          className="w-12 h-12 border-2 border-amber-400 border-t-transparent rounded-full"
        />
      </div>
    );
  }

  if (!settings?.enabled) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <Coins className="w-10 h-10 text-zinc-700 mb-4" />
        <p className="text-zinc-500 max-w-sm">
          The coin store isn't enabled on this panel yet. Ask an admin to turn it on from Settings if you'd like to use it.
        </p>
      </div>
    );
  }

  const currency = settings.currencyName || "Coins";
  const symbol = settings.currencySymbol || "coin";

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar p-4 md:p-8 text-white">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <ShoppingBag className="w-6 h-6 text-amber-400" /> {currency} Store
            </h1>
            <p className="text-sm text-zinc-500 mt-1">Redeem {currency.toLowerCase()} for extra server resources.</p>
          </div>
          <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 rounded-2xl px-5 py-3 shrink-0">
            <Coins className="w-5 h-5 text-amber-400" />
            <div>
              <p className="text-[10px] uppercase tracking-wide text-amber-300/70 font-semibold">Balance</p>
              <p className="text-lg font-bold text-amber-300 leading-none">{balance ?? 0} <span className="text-xs font-normal text-amber-300/60">{symbol}</span></p>
            </div>
          </div>
        </div>

        <div className="flex bg-white/[0.03] border border-white/10 rounded-xl p-1 w-fit">
          <button
            onClick={() => setTab("store")}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${tab === "store" ? "bg-amber-500 text-black" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            <ShoppingBag className="w-3.5 h-3.5" /> Store
          </button>
          <button
            onClick={() => setTab("history")}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${tab === "history" ? "bg-amber-500 text-black" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            <History className="w-3.5 h-3.5" /> History
          </button>
        </div>

        {tab === "store" ? (
          items.length === 0 ? (
            <div className="bg-black/40 border border-white/10 rounded-3xl p-8 text-center text-zinc-500 flex flex-col items-center">
              <AlertCircle className="w-8 h-8 mb-3 text-zinc-600" />
              Nothing's for sale yet — check back later.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {items.map((item) => {
                const meta = GRANT_META[item.grant.type];
                const affordable = balance !== null && balance >= item.cost;
                return (
                  <div key={item.id} className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-2xl p-5 flex flex-col shadow-[0_0_30px_-15px_rgba(0,0,0,0.5)]">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <h3 className="font-semibold text-white">{item.name}</h3>
                      <span className="flex items-center gap-1 text-amber-300 font-bold text-sm shrink-0">
                        <Coins className="w-3.5 h-3.5" /> {item.cost}
                      </span>
                    </div>
                    {item.description && <p className="text-xs text-zinc-500 mb-3 flex-1">{item.description}</p>}
                    <div className="flex items-center gap-1.5 text-xs text-zinc-400 mb-4">
                      {meta?.icon} +{item.grant.amount} {meta?.unit}
                    </div>
                    <button
                      onClick={() => purchase(item)}
                      disabled={!affordable || purchasingId !== null}
                      className={`w-full py-2 rounded-xl text-sm font-semibold transition-all active:scale-[0.98] ${
                        affordable
                          ? "bg-amber-500 hover:bg-amber-400 text-black"
                          : "bg-white/5 text-zinc-600 cursor-not-allowed"
                      } disabled:opacity-50`}
                    >
                      {purchasingId === item.id ? "Redeeming..." : affordable ? "Redeem" : "Not enough " + symbol}
                    </button>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-3xl overflow-hidden">
            {transactions.length === 0 ? (
              <div className="p-8 text-center text-zinc-500">No transactions yet.</div>
            ) : (
              <div className="divide-y divide-white/5">
                {transactions.map((tx) => (
                  <div key={tx.id} className="p-4 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm text-zinc-200 truncate">{tx.reason}</p>
                      <p className="text-xs text-zinc-500 mt-0.5">{new Date(tx.createdAt).toLocaleString()}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-sm font-bold ${tx.amount >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {tx.amount >= 0 ? "+" : ""}{tx.amount}
                      </p>
                      <p className="text-[11px] text-zinc-600">balance: {tx.balanceAfter}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
