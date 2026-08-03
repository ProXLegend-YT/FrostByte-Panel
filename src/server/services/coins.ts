import { readJSON, updateJSON, writeJSON } from "./db.js";
import { randomUUID } from "crypto";
import { logActivity } from "./activityLog.js";

export interface CoinTransaction {
  id: string;
  userId: string;
  amount: number; // positive = credit, negative = debit
  balanceAfter: number;
  reason: string;
  // "admin" for manual admin grants/deductions, "purchase" for store buys,
  // "system" for automated grants (e.g. a future daily-login bonus),
  // "refund" for reversed purchases.
  type: "admin" | "purchase" | "system" | "refund";
  actorId: string; // who caused this transaction — the user themself for a
                    // purchase, or an admin's id for a manual grant
  createdAt: string;
}

export interface StoreItem {
  id: string;
  name: string;
  description: string;
  cost: number;
  // What this item actually grants when purchased — kept generic so the
  // store can offer more than one kind of thing without needing a schema
  // change every time (e.g. resource bumps now, cosmetics or server slots
  // later).
  grant: {
    type: "maxServers" | "maxRamGb" | "maxCpuPercent" | "maxDiskGb";
    amount: number; // added to the user's current per-user override
  };
  enabled: boolean;
  createdAt: string;
}

const SETTINGS_FILE = "settings.json";
const TRANSACTIONS_FILE = "coinTransactions.json";
const STORE_FILE = "storeItems.json";

export interface CoinSettings {
  enabled: boolean;
  currencyName: string; // e.g. "Coins", "Credits", "Gems" — fully renameable
  currencySymbol: string; // e.g. emoji or short string
  startingBalance: number; // granted to new accounts on registration
}

export async function getCoinSettings(): Promise<CoinSettings> {
  const settings = (await readJSON(SETTINGS_FILE)) || {};
  return {
    enabled: settings.coinsEnabled === true,
    currencyName: settings.coinsCurrencyName || "Coins",
    currencySymbol: settings.coinsCurrencySymbol || "coin",
    startingBalance: typeof settings.coinsStartingBalance === "number" ? settings.coinsStartingBalance : 100,
  };
}

export async function updateCoinSettings(patch: Partial<CoinSettings>): Promise<CoinSettings> {
  const settings = (await readJSON(SETTINGS_FILE)) || {};
  if (patch.enabled !== undefined) settings.coinsEnabled = patch.enabled;
  if (patch.currencyName !== undefined) settings.coinsCurrencyName = patch.currencyName;
  if (patch.currencySymbol !== undefined) settings.coinsCurrencySymbol = patch.currencySymbol;
  if (patch.startingBalance !== undefined) settings.coinsStartingBalance = patch.startingBalance;
  await writeJSON(SETTINGS_FILE, settings);
  return getCoinSettings();
}

export async function getBalance(userId: string): Promise<number> {
  const users = (await readJSON("users.json")) || [];
  const user = users.find((u: any) => u.id === userId);
  return typeof user?.coins === "number" ? user.coins : 0;
}

// Core mutation — every balance change in the whole system goes through
// this, so the ledger can never drift out of sync with the actual balance
// stored on the user record. Rejects any change that would take a balance
// negative, since coins represent a spendable resource, not a line of
// credit.
async function applyTransaction(userId: string, amount: number, reason: string, type: CoinTransaction["type"], actorId: string): Promise<{ ok: boolean; error?: string; balance?: number }> {
  let result: { ok: boolean; error?: string; balance?: number } = { ok: false };

  await updateJSON<any[]>("users.json", (users) => {
    const list = users || [];
    const idx = list.findIndex((u) => u.id === userId);
    if (idx === -1) {
      result = { ok: false, error: "User not found." };
      return list;
    }
    const current = typeof list[idx].coins === "number" ? list[idx].coins : 0;
    const next = current + amount;
    if (next < 0) {
      result = { ok: false, error: "Insufficient balance." };
      return list;
    }
    list[idx] = { ...list[idx], coins: next };
    result = { ok: true, balance: next };
    return list;
  });

  if (result.ok) {
    const tx: CoinTransaction = {
      id: randomUUID(),
      userId,
      amount,
      balanceAfter: result.balance!,
      reason,
      type,
      actorId,
      createdAt: new Date().toISOString(),
    };
    // Cap the ledger at the most recent 5000 entries — enough history to
    // be genuinely useful without the file growing unbounded on a busy
    // panel.
    await updateJSON<CoinTransaction[]>(TRANSACTIONS_FILE, (list) => [...(list || []), tx].slice(-5000));
  }

  return result;
}

export async function grantCoins(userId: string, amount: number, reason: string, actorId: string): Promise<{ ok: boolean; error?: string; balance?: number }> {
  if (amount <= 0) return { ok: false, error: "Grant amount must be positive." };
  return applyTransaction(userId, amount, reason, "admin", actorId);
}

export async function deductCoins(userId: string, amount: number, reason: string, actorId: string): Promise<{ ok: boolean; error?: string; balance?: number }> {
  if (amount <= 0) return { ok: false, error: "Deduct amount must be positive." };
  return applyTransaction(userId, -amount, reason, "admin", actorId);
}

export async function getTransactions(userId?: string, limit: number = 100): Promise<CoinTransaction[]> {
  const all = (await readJSON(TRANSACTIONS_FILE)) || [];
  const filtered = userId ? all.filter((t: CoinTransaction) => t.userId === userId) : all;
  return filtered.slice(-limit).reverse();
}

// --- Store -----------------------------------------------------------------

export async function getStoreItems(includeDisabled = false): Promise<StoreItem[]> {
  const items: StoreItem[] = (await readJSON(STORE_FILE)) || [];
  return includeDisabled ? items : items.filter((i) => i.enabled);
}

export async function createStoreItem(input: Omit<StoreItem, "id" | "createdAt">): Promise<StoreItem> {
  const item: StoreItem = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  await updateJSON<StoreItem[]>(STORE_FILE, (list) => [...(list || []), item]);
  return item;
}

export async function updateStoreItem(id: string, patch: Partial<Omit<StoreItem, "id" | "createdAt">>): Promise<StoreItem | null> {
  let updated: StoreItem | null = null;
  await updateJSON<StoreItem[]>(STORE_FILE, (list) => {
    const items = list || [];
    return items.map((i) => {
      if (i.id !== id) return i;
      updated = { ...i, ...patch };
      return updated;
    });
  });
  return updated;
}

export async function deleteStoreItem(id: string): Promise<boolean> {
  let existed = false;
  await updateJSON<StoreItem[]>(STORE_FILE, (list) => {
    const items = list || [];
    existed = items.some((i) => i.id === id);
    return items.filter((i) => i.id !== id);
  });
  return existed;
}

// Purchasing a store item both debits the user's coin balance and bumps
// their per-user resource override (the same fields createServer already
// reads for quota enforcement). This makes a purchase take effect
// immediately without needing any separate "apply my purchase" step, and
// it composes correctly with the existing per-user vs global-default
// permission resolution built earlier this session.
export async function purchaseStoreItem(userId: string, itemId: string): Promise<{ ok: boolean; error?: string; balance?: number }> {
  const items = (await readJSON(STORE_FILE)) || [];
  const item: StoreItem | undefined = items.find((i: StoreItem) => i.id === itemId);
  if (!item || !item.enabled) return { ok: false, error: "This item isn't available." };

  const debit = await applyTransaction(userId, -item.cost, `Purchased: ${item.name}`, "purchase", userId);
  if (!debit.ok) return debit;

  await updateJSON<any[]>("users.json", (users) => {
    const list = users || [];
    return list.map((u) => {
      if (u.id !== userId) return u;
      const current = typeof u[item.grant.type] === "number" ? u[item.grant.type] : 0;
      return { ...u, [item.grant.type]: current + item.grant.amount };
    });
  });

  const users = (await readJSON("users.json")) || [];
  const purchaser = users.find((u: any) => u.id === userId);

  logActivity({
    actorId: userId,
    actorUsername: purchaser?.username || "unknown",
    action: "store.purchase",
    target: item.name,
  });

  return debit;
}
