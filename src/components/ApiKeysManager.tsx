import React, { useState, useEffect } from "react";
import axios from "axios";
import { Key, Plus, Trash2, RefreshCw, Copy, Check } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function ApiKeysManager() {
  const [apiKeys, setApiKeys] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [newKeyString, setNewKeyString] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    fetchApiKeys();
  }, []);

  const fetchApiKeys = async () => {
    try {
      const res = await axios.get("/api/admin/api-keys");
      setApiKeys(res.data);
    } catch (e) {
      console.error("Failed to fetch API keys", e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProcessing(true);
    try {
      const res = await axios.post("/api/admin/api-keys", {
        label: newKeyLabel || "Unnamed Key",
        scopes: ["*"] // Default full access
      });
      setNewKeyString(res.data.key);
      fetchApiKeys();
      setNewKeyLabel("");
    } catch (e) {
      console.error("Failed to create API key", e);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDeleteKey = async (id: string) => {
    if (!confirm("Are you sure you want to delete this API key? This action cannot be undone.")) return;
    try {
      await axios.delete(`/api/admin/api-keys/${id}`);
      fetchApiKeys();
    } catch (e) {
      console.error("Failed to delete API key", e);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  if (isLoading) {
    return <div className="text-zinc-500 animate-pulse">Loading API keys...</div>;
  }

  return (
    <div className="bg-[#0a0a0c] border border-white/5 rounded-2xl p-6 md:p-8 shadow-xl mt-8">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <h2 className="text-xl font-bold flex items-center text-white">
          <Key className="mr-3 text-cyan-300 w-5 h-5" /> API Keys
        </h2>
        <button 
          onClick={() => {
            setNewKeyString(null);
            setShowAddModal(true);
          }}
          className="flex items-center space-x-2 px-4 py-2 bg-cyan-500 hover:bg-sky-600 text-white font-medium rounded-xl transition-all shadow-sm"
        >
          <Plus size={18} />
          <span>Generate Key</span>
        </button>
      </div>

      {newKeyString && !showAddModal && (
        <div className="mb-6 bg-cyan-400/10 border border-cyan-400/30 rounded-xl p-4">
          <h3 className="text-cyan-300 font-bold mb-2">New API Key Generated!</h3>
          <p className="text-zinc-300 text-sm mb-3">Please copy this key now. You will not be able to see it again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-black/40 text-white px-3 py-2 rounded-lg font-mono text-sm break-all">
              {newKeyString}
            </code>
            <button 
              onClick={() => copyToClipboard(newKeyString)}
              className="p-2 bg-cyan-400/20 hover:bg-cyan-400/30 text-cyan-300 rounded-lg transition-colors shrink-0"
            >
              {copiedKey ? <Check size={18} /> : <Copy size={18} />}
            </button>
          </div>
        </div>
      )}

      {apiKeys.length === 0 ? (
        <div className="text-center p-8 border border-white/5 bg-white/[0.02] rounded-xl">
          <p className="text-zinc-500 text-sm">No API keys generated yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {apiKeys.map(key => (
            <div key={key.id} className={`flex flex-col sm:flex-row sm:items-center justify-between p-4 bg-white/[0.02] border border-white/5 rounded-xl transition-colors ${key.revoked ? 'opacity-50' : 'hover:bg-white/[0.04]'}`}>
              <div className="mb-3 sm:mb-0">
                <div className="flex items-center gap-2">
                  <h4 className="font-medium text-white">{key.label}</h4>
                  {key.revoked && <span className="text-[10px] uppercase font-bold tracking-wider bg-red-500/20 text-red-400 px-2 py-0.5 rounded">Revoked</span>}
                </div>
                <div className="text-xs text-zinc-500 mt-1 flex flex-col sm:flex-row sm:gap-4">
                  <span>Created: {new Date(key.created_at).toLocaleDateString()}</span>
                  <span>Last used: {key.last_used_at ? new Date(key.last_used_at).toLocaleDateString() : 'Never'}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => handleDeleteKey(key.id)}
                  className="p-1.5 text-zinc-500 bg-white/[0.03] border border-transparent hover:border-red-500/30 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all" 
                  title="Delete Key"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Modal */}
      <AnimatePresence>
        {showAddModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-[#121214] border border-white/10 shadow-2xl rounded-2xl w-full max-w-md overflow-hidden flex flex-col"
            >
              <div className="flex items-center justify-between p-5 border-b border-white/5 bg-black/20">
                <h3 className="text-lg font-bold text-white">Generate API Key</h3>
                <button onClick={() => setShowAddModal(false)} className="text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-white/5 transition-colors">
                  <Trash2 size={20} className="opacity-0" /> {/* Spacer */}
                </button>
              </div>
              
              <form onSubmit={handleCreateKey} className="p-5">
                <div className="mb-6">
                  <label className="block text-sm font-medium text-zinc-400 mb-2">Key Label (Optional)</label>
                  <input 
                    type="text" 
                    value={newKeyLabel}
                    onChange={(e) => setNewKeyLabel(e.target.value)}
                    placeholder="e.g. CI/CD Pipeline"
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-cyan-400/50 transition-colors"
                  />
                </div>
                
                <div className="flex justify-end space-x-3">
                  <button 
                    type="button"
                    onClick={() => setShowAddModal(false)}
                    className="px-4 py-2 bg-white/5 hover:bg-white/10 text-white font-medium rounded-xl transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit"
                    disabled={isProcessing}
                    className="px-4 py-2 bg-cyan-500 hover:bg-sky-600 text-white font-medium rounded-xl transition-colors disabled:opacity-50"
                  >
                    {isProcessing ? "Generating..." : "Generate"}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
