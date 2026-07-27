import React from "react";
import { motion } from "framer-motion";
import ApiKeysManager from "../components/ApiKeysManager";
import { useAuth } from "../context/AuthContext";

export default function ApiKeysPage() {
  const { isAdmin } = useAuth();

  if (!isAdmin) {
    return (
      <div className="flex-1 p-6 md:p-8 flex items-center justify-center text-zinc-400">
        You do not have permission to view this page.
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex-1 p-6 md:p-8 max-w-5xl mx-auto w-full"
    >
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white tracking-tight mb-2">API Keys</h1>
        <p className="text-zinc-400">Manage API keys for accessing the panel via the dashboard.</p>
      </div>

      <ApiKeysManager />
    </motion.div>
  );
}
