import React, { useState, useRef } from "react";
import { LoadingOverlay } from "../components/LoadingOverlay";
import axios from "axios";
import { Globe2, UploadCloud, Link2, RefreshCw, AlertTriangle, CheckCircle2, FileArchive } from "lucide-react";

type InstallMode = "upload" | "url";

export default function WorldManager({ serverId, serverStatus }: { serverId: string; serverStatus?: string }) {
  const [mode, setMode] = useState<InstallMode>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [worldName, setWorldName] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isOnline = serverStatus === "online";

  const pickFile = (f: File | null) => {
    setResult(null);
    if (f && !f.name.toLowerCase().endsWith(".zip")) {
      setResult({ ok: false, message: "Please choose a .zip file — that's the format Minecraft world saves are exported as." });
      setFile(null);
      return;
    }
    setFile(f);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files?.[0] || null;
    pickFile(dropped);
  };

  const handleInstall = async () => {
    if (isOnline) {
      setResult({ ok: false, message: "Stop the server first — swapping world files while it's running can corrupt the save." });
      return;
    }
    if (mode === "upload" && !file) {
      setResult({ ok: false, message: "Choose a world .zip to upload first." });
      return;
    }
    if (mode === "url" && !sourceUrl.trim()) {
      setResult({ ok: false, message: "Paste a direct download link to a world .zip first." });
      return;
    }

    setIsInstalling(true);
    setResult(null);
    try {
      let res;
      if (mode === "upload" && file) {
        const formData = new FormData();
        formData.append("file", file);
        if (worldName.trim()) formData.append("worldName", worldName.trim());
        res = await axios.post(`/api/servers/${serverId}/worlds/install`, formData, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      } else {
        res = await axios.post(`/api/servers/${serverId}/worlds/install`, {
          sourceUrl: sourceUrl.trim(),
          worldName: worldName.trim() || undefined,
        });
      }
      setResult({ ok: true, message: res.data.message || "World installed successfully." });
      setFile(null);
      setSourceUrl("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e: any) {
      setResult({ ok: false, message: e.response?.data?.error || "Failed to install world." });
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar p-4 md:p-8 text-white bg-transparent">
      <div className="max-w-4xl mx-auto space-y-6 md:space-y-8">

        <div>
          <h2 className="text-xl md:text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60 mb-1 flex items-center">
            <Globe2 className="w-6 h-6 mr-2 text-cyan-400" /> World Installer
          </h2>
          <p className="text-[11px] font-bold text-cyan-300/80 uppercase tracking-widest mt-1">
            Install a world save in one click — upload a zip, or point at a direct download link.
          </p>
        </div>

        {isOnline && (
          <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-sm text-amber-200/90">
              <p className="font-medium text-amber-300">Stop the server before installing a world.</p>
              <p className="text-amber-200/70 mt-0.5">Swapping world files while it's running can corrupt the save.</p>
            </div>
          </div>
        )}

        <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-3xl overflow-hidden shadow-[0_0_40px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5">
          <div className="p-4 border-b border-white/5">
            <div className="flex gap-1 p-1 bg-white/[0.03] rounded-xl w-fit">
              <button
                onClick={() => { setMode("upload"); setResult(null); }}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${mode === "upload" ? "bg-cyan-500/20 text-cyan-300" : "text-zinc-400 hover:text-zinc-200"}`}
              >
                <UploadCloud className="w-4 h-4" /> Upload zip
              </button>
              <button
                onClick={() => { setMode("url"); setResult(null); }}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${mode === "url" ? "bg-cyan-500/20 text-cyan-300" : "text-zinc-400 hover:text-zinc-200"}`}
              >
                <Link2 className="w-4 h-4" /> From URL
              </button>
            </div>
          </div>

          <div className="p-5 space-y-4">
            {mode === "upload" ? (
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-colors ${
                  isDragging ? "border-cyan-400 bg-cyan-400/5" : "border-white/10 hover:border-white/20"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip"
                  className="hidden"
                  onChange={(e) => pickFile(e.target.files?.[0] || null)}
                />
                {file ? (
                  <div className="flex flex-col items-center gap-2">
                    <FileArchive className="w-8 h-8 text-cyan-400" />
                    <p className="text-sm font-medium text-zinc-200">{file.name}</p>
                    <p className="text-xs text-zinc-500">{(file.size / (1024 * 1024)).toFixed(1)} MB — click to choose a different file</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <UploadCloud className="w-8 h-8 text-zinc-500" />
                    <p className="text-sm font-medium text-zinc-300">Drop a world .zip here, or click to browse</p>
                    <p className="text-xs text-zinc-500">The zip should contain your world folder (with level.dat inside).</p>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-2">World download URL</label>
                <div className="relative">
                  <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                  <input
                    type="text"
                    placeholder="https://example.com/my-world.zip"
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                    className="w-full bg-white/[0.02] border border-white/10 rounded-lg py-2.5 pl-9 pr-4 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-cyan-500 transition-colors"
                  />
                </div>
                <p className="text-xs text-zinc-500 mt-2">A direct link to a .zip file. Only install worlds from sources you trust.</p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2">World name <span className="text-zinc-500 font-normal">(optional)</span></label>
              <input
                type="text"
                placeholder="Leave blank to keep the current level-name"
                value={worldName}
                onChange={(e) => setWorldName(e.target.value)}
                className="w-full bg-white/[0.02] border border-white/10 rounded-lg py-2.5 px-4 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-cyan-500 transition-colors"
              />
              <p className="text-xs text-zinc-500 mt-2">
                If a world is already installed under this name, it's automatically backed up before being replaced.
              </p>
            </div>

            {result && (
              <div className={`p-3.5 rounded-xl flex items-start gap-2.5 text-sm ${
                result.ok ? "bg-emerald-500/10 border border-emerald-500/25 text-emerald-300" : "bg-red-500/10 border border-red-500/25 text-red-300"
              }`}>
                {result.ok ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
                <span>{result.message}</span>
              </div>
            )}

            <button
              onClick={handleInstall}
              disabled={isInstalling}
              className="w-full px-4 py-3 bg-gradient-to-r from-cyan-500 to-sky-500 hover:from-cyan-400 hover:to-sky-400 text-black font-semibold rounded-xl text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-lg shadow-cyan-500/10"
            >
              {isInstalling ? (
                <><RefreshCw className="w-4 h-4 animate-spin" /> Installing world...</>
              ) : (
                <><Globe2 className="w-4 h-4" /> Install World</>
              )}
            </button>
          </div>
        </div>
      </div>

      {isInstalling && <LoadingOverlay message="Installing world — this can take a moment for larger saves..." />}
    </div>
  );
}
