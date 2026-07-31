import React, { useEffect, useState, useRef } from "react";
import axios from "axios";
import { useAuth } from "../context/AuthContext";
import { useSettings } from "../context/SettingsContext";
import { motion } from "framer-motion";
import { Shield, User, Trash2, Layout, Upload, RefreshCw } from "lucide-react";
import { ImageCropper } from "../components/ImageCropper";
import { LoadingOverlay } from "../components/LoadingOverlay";

export default function SettingsPage() {
  const { user, logout, isAdmin } = useAuth();
  const { panelName, panelLogo, panelBackgroundImage, panelBackgroundBlur, allowRegistration, allowUserServerCreation, fetchSettings } = useSettings();
  const [users, setUsers] = useState<any[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [newPanelName, setNewPanelName] = useState(panelName);
  const [newAllowRegistration, setNewAllowRegistration] = useState(allowRegistration);
  const [newAllowUserServerCreation, setNewAllowUserServerCreation] = useState(allowUserServerCreation);
  const [globalServerDefaults, setGlobalServerDefaults] = useState({ defaultMaxServers: 1, defaultMaxRamGb: 4, defaultMaxCpuPercent: 200, defaultMaxDiskGb: 10 });
  const [isSavingGlobalDefaults, setIsSavingGlobalDefaults] = useState(false);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [croppingType, setCroppingType] = useState<"logo" | "background" | null>(null);
  const [bgAspectRatio, setBgAspectRatio] = useState<number>(16/9);
  const [tempBgBlur, setTempBgBlur] = useState<number>(10);
  const bgFileInputRef = useRef<HTMLInputElement>(null);
  const [oldPassword, setOldPassword] = useState("");
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [adminUserNewPassword, setAdminUserNewPassword] = useState("");
  const [permissionsUserId, setPermissionsUserId] = useState<string | null>(null);
  const [permissionsDraft, setPermissionsDraft] = useState<{ canCreateServers: boolean; maxServers: number; maxRamGb: number; maxCpuPercent: number; maxDiskGb: number }>({
    canCreateServers: false, maxServers: 1, maxRamGb: 4, maxCpuPercent: 200, maxDiskGb: 10,
  });
  const [isSavingPermissions, setIsSavingPermissions] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isCreatingUser, setIsCreatingUser] = useState(false);
  const [isUpdatingLogo, setIsUpdatingLogo] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isUpdatingSystem, setIsUpdatingSystem] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSystemUpdate = async () => {
    try {
      setIsUpdatingSystem(true);
      await axios.post("/api/system/update");
      setIsUpdatingSystem(false);
    } catch (e) {
      alert("Failed to update system. Please check logs.");
      setIsUpdatingSystem(false);
    }
  };

  useEffect(() => {
    setNewPanelName(panelName);
    setNewAllowRegistration(allowRegistration);
    setNewAllowUserServerCreation(allowUserServerCreation);
  }, [panelName, allowRegistration, allowUserServerCreation]);

  useEffect(() => {
    if (!isAdmin) return;
    axios.get("/api/system/settings/server-defaults").then((res) => {
      setGlobalServerDefaults({
        defaultMaxServers: res.data.defaultMaxServers,
        defaultMaxRamGb: res.data.defaultMaxRamGb,
        defaultMaxCpuPercent: res.data.defaultMaxCpuPercent,
        defaultMaxDiskGb: res.data.defaultMaxDiskGb,
      });
    }).catch(() => {});
  }, [isAdmin]);

  const fetchUsers = async () => {
    if (!isAdmin) return;
    try {
      const res = await axios.get("/api/system/users");
      setUsers(res.data);
    } catch (e) {}
  };

  useEffect(() => {
    fetchUsers();
    if (panelBackgroundBlur !== undefined) setTempBgBlur(panelBackgroundBlur);
  }, [user]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: "logo" | "background" = "logo") => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.addEventListener('load', async () => {
        const base64 = reader.result?.toString() || null;
        if (base64) {
          if (type === "logo") {
            setSelectedImage(base64);
            setCroppingType(type);
          } else if (type === "background") {
            setIsProcessing(true);
            try {
              await axios.put("/api/system/settings", { panelBackgroundImage: base64 });
              await fetchSettings();
            } catch(err) {
              console.error(err);
            } finally {
              setIsProcessing(false);
            }
          }
        }
      });
      reader.readAsDataURL(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (bgFileInputRef.current) bgFileInputRef.current.value = "";
  };

  const handleCropComplete = async (croppedImageBase64: string) => {
    const type = croppingType;
    setSelectedImage(null);
    setCroppingType(null);
    if (type === "logo") {
      setIsUpdatingLogo(true);
      try {
        await axios.put("/api/system/settings", { panelLogo: croppedImageBase64 });
        await fetchSettings();
      } catch (err: any) {
        alert(err.response?.data?.error || "Error updating logo");
      } finally {
        setIsUpdatingLogo(false);
      }
    } else if (type === "background") {
      setIsProcessing(true);
      try {
        await axios.put("/api/system/settings", { panelBackgroundImage: croppedImageBase64 });
        await fetchSettings();
      } catch (err: any) {
        alert(err.response?.data?.error || "Error updating background");
      } finally {
        setIsProcessing(false);
      }
    }
  };

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreatingUser(true);
    try {
      await axios.post("/api/system/users", { username, password, role });
      setUsername("");
      setPassword("");
      fetchUsers();
      alert("User created successfully");
    } catch (e: any) {
      alert(e.response?.data?.error || "Error creating user");
    } finally {
      setIsCreatingUser(false);
    }
  };

  const changeUserPassword = async (id: string) => {
    try {
      if (adminUserNewPassword.length < 8) {
         alert("Password must be at least 8 characters");
         return;
      }
      await axios.put(`/api/system/users/${id}/password`, { newPassword: adminUserNewPassword });
      alert("Password changed successfully");
      setEditingUserId(null);
      setAdminUserNewPassword("");
      if (user.id === id) {
        logout();
      }
    } catch(e: any) {
      alert(e.response?.data?.error || "Error changing password");
    }
  };

  const deleteUser = async (id: string) => {
    try {
      await axios.delete(`/api/system/users/${id}`);
      fetchUsers();
    } catch (e) {}
  };

  const openServerPermissions = (u: any) => {
    if (permissionsUserId === u.id) {
      setPermissionsUserId(null);
      return;
    }
    setPermissionsUserId(u.id);
    setPermissionsDraft({
      canCreateServers: !!u.canCreateServers,
      maxServers: u.maxServers ?? 1,
      maxRamGb: u.maxRamGb ?? 4,
      maxCpuPercent: u.maxCpuPercent ?? 200,
      maxDiskGb: u.maxDiskGb ?? 10,
    });
  };

  const saveServerPermissions = async (id: string) => {
    setIsSavingPermissions(true);
    try {
      await axios.put(`/api/system/users/${id}/server-permissions`, permissionsDraft);
      fetchUsers();
      setPermissionsUserId(null);
    } catch (e: any) {
      alert(e.response?.data?.error || "Error updating server access");
    } finally {
      setIsSavingPermissions(false);
    }
  };

  const resetServerPermissionsToGlobal = async (id: string) => {
    setIsSavingPermissions(true);
    try {
      await axios.put(`/api/system/users/${id}/server-permissions`, { clearOverride: true });
      fetchUsers();
      setPermissionsUserId(null);
    } catch (e: any) {
      alert(e.response?.data?.error || "Error resetting server access");
    } finally {
      setIsSavingPermissions(false);
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -15 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="p-5 md:p-10 max-w-7xl mx-auto"
    >
      <div className="mb-10">
        <h1 className="text-4xl md:text-5xl font-black tracking-tight text-white mb-2 drop-shadow-lg">Settings</h1>
        <p className="text-cyan-300/80 font-bold uppercase tracking-widest text-sm mt-2">Configure your account and platform preferences.</p>
      </div>

      <div className="bg-black/40 backdrop-blur-md border border-white/10 rounded-3xl p-6 md:p-10 mb-8 shadow-[0_0_50px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5 relative overflow-hidden">
        {/* Subtle decorative glow */}
        <div className="absolute top-0 right-0 w-64 h-64 bg-cyan-400/5 blur-[80px] rounded-full pointer-events-none" />
        
        <h2 className="text-xl font-bold mb-6 flex items-center text-white relative z-10">
          <User className="mr-3 text-cyan-300 w-5 h-5" /> Account Details
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 relative z-10 mb-8">
          <div className="bg-black/40 backdrop-blur-sm border border-white/10 p-5 rounded-2xl shadow-[0_0_30px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5">
            <p className="text-sm font-medium text-zinc-500 mb-1">Username</p>
            <p className="text-lg font-semibold text-zinc-200">{user.username}</p>
          </div>
          <div className="bg-black/40 backdrop-blur-sm border border-white/10 p-5 rounded-2xl shadow-[0_0_30px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5">
            <p className="text-sm font-medium text-zinc-500 mb-1">Access Role</p>
            <p className="text-lg font-semibold text-zinc-200 capitalize flex items-center gap-2">
              {user.role}
              {user.role === 'admin' && <Shield size={14} className="text-purple-400" />}
            </p>
          </div>
        </div>

        <div className="relative z-10 border-t border-white/5 pt-6">
          <h3 className="text-lg font-semibold text-white mb-4">Change Password</h3>
          <form 
            onSubmit={async (e) => {
              e.preventDefault();
              if (newPassword.length < 8) {
                alert("Password must be at least 8 characters");
                return;
              }
              setIsChangingPassword(true);
              try {
                await axios.put("/api/auth/password", { oldPassword, newPassword });
                setOldPassword("");
                setNewPassword("");
                alert("Password changed successfully. You will be logged out.");
                logout();
              } catch (err: any) {
                alert(err.response?.data?.error || "Error changing password");
              } finally {
                setIsChangingPassword(false);
              }
            }}
            className="max-w-md"
          >
            <div className="flex flex-col gap-3">
              <input 
                required 
                value={oldPassword} 
                onChange={e => setOldPassword(e.target.value)} 
                type="password" 
                placeholder="Current password"
                className="w-full bg-white/[0.03] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-2.5 text-white transition-all shadow-inner outline-none" 
              />
              <div className="flex gap-3">
                <input 
                  required 
                  minLength={8}
                  value={newPassword} 
                  onChange={e => setNewPassword(e.target.value)} 
                  type="password" 
                  placeholder="New password (min 8 chars)"
                  className="flex-1 bg-white/[0.03] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-2.5 text-white transition-all shadow-inner outline-none" 
                />
                <button 
                  type="submit" 
                  disabled={isChangingPassword}
                  className="bg-cyan-500 hover:bg-sky-600 disabled:opacity-50 text-white font-semibold px-6 py-2.5 rounded-xl transition-all shadow-[0_0_15px_rgba(56,189,248,0.3)] active:scale-[0.98] whitespace-nowrap"
                >
                  {isChangingPassword ? "Updating..." : "Update"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>

      {isAdmin && (
        <div className="bg-black/40 backdrop-blur-md border border-white/10 rounded-3xl p-6 md:p-10 mb-8 shadow-[0_0_50px_-15px_rgba(0,0,0,0.5)] ring-1 ring-white/5 relative overflow-hidden">
          <h2 className="text-xl font-bold mb-6 flex items-center text-white relative z-10">
            <Layout className="mr-3 text-emerald-400 w-5 h-5" /> Platform Preferences
          </h2>
          <div className="flex flex-col md:flex-row flex-wrap gap-8 relative z-10">
            <form 
              onSubmit={async (e) => {
                e.preventDefault();
                setIsSavingSettings(true);
                try {
                  await axios.put("/api/system/settings", { panelName: newPanelName });
                  fetchSettings();
                  alert("Settings updated successfully");
                } catch (err: any) {
                  alert(err.response?.data?.error || "Error updating settings");
                } finally {
                  setIsSavingSettings(false);
                }
              }}
              className="flex-1 max-w-md"
            >
              <label className="block text-sm font-medium text-zinc-400 mb-1.5">Panel Name</label>
              <div className="flex gap-3 mb-6">
                <input 
                  required 
                  value={newPanelName} 
                  onChange={e => setNewPanelName(e.target.value)} 
                  type="text" 
                  className="flex-1 bg-white/[0.03] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-2.5 text-white transition-all shadow-inner outline-none" 
                />
                <button disabled={isSavingSettings} type="submit" className="bg-white text-zinc-900 hover:bg-zinc-200 font-semibold px-6 py-2.5 rounded-xl transition-all shadow-sm active:scale-[0.98] whitespace-nowrap disabled:opacity-50">
                  {isSavingSettings ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
            
            <div className="flex-1 max-w-sm">
              <label className="block text-sm font-medium text-zinc-400 mb-1.5 flex items-center gap-2">
                Features
              </label>
              <div className="flex flex-col gap-4 mt-2">
                <label className="flex items-center gap-3 cursor-pointer">
                  <div className="relative flex items-center">
                    <input 
                      type="checkbox" 
                      checked={newAllowRegistration} 
                      onChange={async (e) => {
                        const val = e.target.checked;
                        setNewAllowRegistration(val);
                        try {
                          await axios.put("/api/system/settings", { allowRegistration: val });
                          fetchSettings();
                        } catch (err) {
                          console.error(err);
                        }
                      }}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                  </div>
                  <div>
                    <span className="text-sm font-medium text-zinc-300 block">Allow Public Self-Registration</span>
                    <span className="text-xs text-zinc-500">When off, only admins can create new accounts.</span>
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <div className="relative flex items-center">
                    <input
                      type="checkbox"
                      checked={newAllowUserServerCreation}
                      onChange={async (e) => {
                        const val = e.target.checked;
                        setNewAllowUserServerCreation(val);
                        try {
                          await axios.put("/api/system/settings", { allowUserServerCreation: val });
                          fetchSettings();
                        } catch (err) {
                          console.error(err);
                        }
                      }}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                  </div>
                  <div>
                    <span className="text-sm font-medium text-zinc-300 block">Enable Server Creation For Normal Users</span>
                    <span className="text-xs text-zinc-500">Applies to every user without an individual override below.</span>
                  </div>
                </label>

                {newAllowUserServerCreation && (
                  <div className="ml-14 p-4 bg-white/[0.02] border border-white/5 rounded-xl space-y-3">
                    <p className="text-xs text-zinc-500">Shared limits applied to any normal user who doesn't have their own custom "Server Access" setting.</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-medium text-zinc-500 mb-1">Max Servers per user</label>
                        <input type="number" min={0} max={50} value={globalServerDefaults.defaultMaxServers}
                          onChange={(e) => setGlobalServerDefaults(d => ({ ...d, defaultMaxServers: Number(e.target.value) }))}
                          className="w-full bg-white/[0.03] border border-white/10 focus:border-cyan-500 rounded-lg px-3 py-2 text-sm text-white outline-none" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-zinc-500 mb-1">Max RAM (GB) per server</label>
                        <input type="number" min={0.5} max={128} step={0.5} value={globalServerDefaults.defaultMaxRamGb}
                          onChange={(e) => setGlobalServerDefaults(d => ({ ...d, defaultMaxRamGb: Number(e.target.value) }))}
                          className="w-full bg-white/[0.03] border border-white/10 focus:border-cyan-500 rounded-lg px-3 py-2 text-sm text-white outline-none" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-zinc-500 mb-1">Max CPU (%) per server</label>
                        <input type="number" min={10} max={1600} value={globalServerDefaults.defaultMaxCpuPercent}
                          onChange={(e) => setGlobalServerDefaults(d => ({ ...d, defaultMaxCpuPercent: Number(e.target.value) }))}
                          className="w-full bg-white/[0.03] border border-white/10 focus:border-cyan-500 rounded-lg px-3 py-2 text-sm text-white outline-none" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-zinc-500 mb-1">Max Disk (GB) per server</label>
                        <input type="number" min={1} max={1000} value={globalServerDefaults.defaultMaxDiskGb}
                          onChange={(e) => setGlobalServerDefaults(d => ({ ...d, defaultMaxDiskGb: Number(e.target.value) }))}
                          className="w-full bg-white/[0.03] border border-white/10 focus:border-cyan-500 rounded-lg px-3 py-2 text-sm text-white outline-none" />
                      </div>
                    </div>
                    <button
                      disabled={isSavingGlobalDefaults}
                      onClick={async () => {
                        setIsSavingGlobalDefaults(true);
                        try {
                          await axios.put("/api/system/settings", globalServerDefaults);
                        } catch (err) {
                          console.error(err);
                        } finally {
                          setIsSavingGlobalDefaults(false);
                        }
                      }}
                      className="px-4 py-2 bg-cyan-500 hover:bg-sky-600 text-white text-sm font-medium rounded-lg transition-colors shadow-sm disabled:opacity-50"
                    >
                      {isSavingGlobalDefaults ? "Saving..." : "Save Limits"}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="flex-1 max-w-sm">
              <label className="block text-sm font-medium text-zinc-400 mb-1.5">Panel Logo</label>
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-xl bg-white/[0.03] border border-white/10 flex items-center justify-center overflow-hidden flex-shrink-0 relative group">
                  {panelLogo ? (
                    <img src={panelLogo} alt="Panel Logo" className="w-full h-full object-cover" />
                  ) : (
                    <Layout className="w-8 h-8 text-zinc-600" />
                  )}
                  {panelLogo && (
                    <button 
                      onClick={async () => {
                        try {
                          await axios.put("/api/system/settings", { panelLogo: "" });
                          fetchSettings();
                        } catch(e) {}
                      }}
                      className="absolute inset-0 bg-red-500/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 size={18} className="text-white" />
                    </button>
                  )}
                </div>
                
                <div className="flex-1">
                  <input 
                    type="file" 
                    accept="image/*" 
                    className="hidden" 
                    ref={fileInputRef}
                    onChange={(e) => handleFileChange(e, "logo")}
                  />
                  <button 
                    disabled={isUpdatingLogo}
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center justify-center w-full gap-2 bg-cyan-400/10 hover:bg-cyan-400/20 text-cyan-300 border border-cyan-400/20 font-semibold px-4 py-2.5 rounded-xl transition-all shadow-sm active:scale-[0.98] disabled:opacity-50"
                  >
                    {isUpdatingLogo ? <div className="w-4 h-4 rounded-full border-2 border-cyan-300/50 border-t-cyan-300 animate-spin"></div> : <Upload size={18} />}
                    {isUpdatingLogo ? "Updating..." : (panelLogo ? "Change Logo" : "Upload Logo")}
                  </button>
                  <p className="text-xs text-zinc-500 mt-2">Recommended: Square image, PNG or JPG.</p>
                </div>
              </div>
            </div>

            

          </div>
        </div>
      )}

      {isAdmin && (
        <div className="bg-black/20 backdrop-blur-sm border border-white/5 rounded-2xl p-6 md:p-8 shadow-xl relative overflow-hidden mt-8">
          <h2 className="text-xl font-bold mb-8 flex items-center text-white relative z-10">
            <Layout className="mr-3 text-cyan-300 w-5 h-5" /> Background Configuration
          </h2>
          <div className="max-w-2xl relative z-10">
            <div className="flex flex-col sm:flex-row gap-8">
              <div className="flex-1">
                <label className="block text-sm font-medium text-zinc-400 mb-4">Background Image</label>
                <div className="w-full h-48 rounded-xl bg-white/[0.03] border border-white/10 flex items-center justify-center overflow-hidden relative group mb-4">
                  {panelBackgroundImage ? (
                    <img src={panelBackgroundImage} alt="Panel Background" className="w-full h-full object-cover" />
                  ) : (
                    <Layout className="w-12 h-12 text-zinc-600" />
                  )}
                  {panelBackgroundImage && (
                    <button 
                      onClick={async () => {
                        try {
                          await axios.put("/api/system/settings", { panelBackgroundImage: "" });
                          fetchSettings();
                        } catch(e) {}
                      }}
                      className="absolute inset-0 bg-red-500/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 size={24} className="text-white" />
                    </button>
                  )}
                </div>
                
                <input 
                  type="file" 
                  accept="image/*" 
                  className="hidden" 
                  ref={bgFileInputRef}
                  onChange={(e) => handleFileChange(e, "background")}
                />
                <div className="flex flex-col gap-2">
                  <button 
                    onClick={() => bgFileInputRef.current?.click()}
                    className="w-full flex items-center justify-center gap-2 bg-cyan-400/10 hover:bg-cyan-400/20 text-cyan-300 border border-cyan-400/20 font-semibold px-4 py-3 rounded-xl transition-all shadow-sm active:scale-[0.98]"
                  >
                    <Upload size={18} /> Upload Background Image
                  </button>
                  <button 
                    onClick={async () => {
                      setIsProcessing(true);
                      try {
                        await axios.put("/api/system/settings", { panelBackgroundImage: "" });
                        await fetchSettings();
                      } catch(e) {} finally {
                        setIsProcessing(false);
                      }
                    }}
                    className="w-full flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 font-semibold px-4 py-3 rounded-xl transition-all shadow-sm active:scale-[0.98]"
                  >
                    <Layout size={18} /> Default Theme
                  </button>
                </div>
                <p className="text-xs text-zinc-500 mt-3 text-center">Will be automatically scaled and cropped to fit 16:9 on desktop and 9:16 on mobile.</p>

              </div>

              <div className="flex-1 flex flex-col justify-center">
                <label className="block text-xs font-bold text-cyan-200 uppercase tracking-widest mb-2 drop-shadow-sm">Background Blur: {tempBgBlur}px</label>
                <p className="text-xs text-zinc-500 mb-6">Adjust the blur to make the text and UI elements more readable.</p>
                <input 
                  type="range" 
                  min="0" 
                  max="50" 
                  value={tempBgBlur}
                  onChange={(e) => setTempBgBlur(Number(e.target.value))}
                  onMouseUp={async () => {
                    setIsProcessing(true);
                    try {
                      await axios.put("/api/system/settings", { panelBackgroundBlur: tempBgBlur });
                      await fetchSettings();
                    } catch(e) {} finally {
                      setIsProcessing(false);
                    }
                  }}
                  onTouchEnd={async () => {
                    setIsProcessing(true);
                    try {
                      await axios.put("/api/system/settings", { panelBackgroundBlur: tempBgBlur });
                      await fetchSettings();
                    } catch(e) {} finally {
                      setIsProcessing(false);
                    }
                  }}
                  className="w-full accent-cyan-500"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedImage && (
        <ImageCropper
          imageSrc={selectedImage}
          onCropComplete={handleCropComplete}
          onCancel={() => { setSelectedImage(null); setCroppingType(null); }}
          aspectRatio={croppingType === "background" ? bgAspectRatio : 1}
          title={croppingType === "background" ? "Crop Background" : "Crop Logo"}
        />
      )}

      {isAdmin && (
        <div className="bg-[#0a0a0c] border border-white/5 rounded-2xl p-6 md:p-8 shadow-xl relative overflow-hidden">
          <h2 className="text-xl font-bold mb-8 flex items-center text-white relative z-10">
            <Shield className="mr-3 text-purple-400 w-5 h-5" /> Administrator Controls
          </h2>
          
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 relative z-10">
            <div className="lg:col-span-4 lg:border-r border-white/5 lg:pr-8">
              <h3 className="font-semibold text-sm uppercase tracking-wider text-zinc-500 mb-6">Provision Identity</h3>
              <form onSubmit={createUser} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-zinc-400 mb-1.5">Username</label>
                  <input required value={username} onChange={e=>setUsername(e.target.value)} type="text" className="w-full bg-white/[0.03] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-2.5 text-white transition-all shadow-inner outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-400 mb-1.5">Password</label>
                  <input required minLength={4} value={password} onChange={e=>setPassword(e.target.value)} type="password" className="w-full bg-white/[0.03] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-2.5 text-white transition-all shadow-inner outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-400 mb-1.5">Role Privileges</label>
                  <select value={role} onChange={e=>setRole(e.target.value)} className="w-full bg-white/[0.03] border border-white/10 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-400/50 rounded-xl px-4 py-2.5 text-white transition-all shadow-inner outline-none">
                    <option value="user" className="bg-zinc-900">Standard User</option>
                    <option value="admin" className="bg-zinc-900">Administrator</option>
                  </select>
                </div>
                <button disabled={isCreatingUser} type="submit" className="w-full mt-2 bg-white text-zinc-900 hover:bg-zinc-200 font-semibold py-2.5 rounded-xl transition-all shadow-sm active:scale-[0.98] disabled:opacity-50">
                  {isCreatingUser ? "Creating..." : "Create Identity"}
                </button>
              </form>
            </div>

            <div className="lg:col-span-8">
               <h3 className="font-semibold text-sm uppercase tracking-wider text-zinc-500 mb-6 flex items-center justify-between">
                <span>Active Identities ({users.length})</span>
              </h3>
               <div className="space-y-3">
                 {users.map(u => (
                   <div key={u.id} className="flex flex-col p-4 bg-white/[0.02] border border-white/5 rounded-xl hover:bg-white/[0.04] transition-colors">
                      <div className="flex justify-between items-center">
                        <div>
                          <p className="font-medium text-white flex items-center">
                            {u.username}
                            {u.id === user.id && <span className="ml-3 text-[10px] uppercase font-bold tracking-wider bg-cyan-400/20 text-cyan-300 px-2.5 py-0.5 rounded border border-cyan-400/20">You</span>}
                          </p>
                          <p className={`text-xs mt-1 capitalize font-medium ${u.role === 'admin' ? 'text-purple-400' : 'text-zinc-500'}`}> 
                            Role: {u.role}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          {u.id !== user.id && u.role !== 'admin' && u.role !== 'owner' && (
                            <button onClick={() => openServerPermissions(u)} className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${u.canCreateServers ? 'text-emerald-300 bg-emerald-400/10 hover:bg-emerald-400/20' : 'text-zinc-400 bg-white/[0.04] hover:bg-white/[0.08]'}`}>
                              {permissionsUserId === u.id ? "Cancel" : u.canCreateServers ? "Server Access ✓" : "Server Access"}
                            </button>
                          )}
                          {u.id !== user.id && (
                            <button onClick={() => {
                              if (editingUserId === u.id) {
                                setEditingUserId(null);
                              } else {
                                setEditingUserId(u.id);
                                setAdminUserNewPassword("");
                              }
                            }} className="px-3 py-1.5 text-xs font-medium text-cyan-300 bg-cyan-400/10 hover:bg-cyan-400/20 rounded-lg transition-colors">
                              {editingUserId === u.id ? "Cancel" : "Change Password"}
                            </button>
                          )}
                          {u.id !== user.id && (
                            <button onClick={() => deleteUser(u.id)} className="p-1.5 text-zinc-500 bg-white/[0.03] border border-transparent hover:border-red-500/30 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all" title="Revoke access">
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      </div>
                      {permissionsUserId === u.id && (
                        <div className="mt-4 pt-4 border-t border-white/5 space-y-4">
                          <p className="text-xs text-zinc-500">
                            {u.hasServerPermissionOverride
                              ? "This user has a custom setting that overrides the global default below."
                              : "This user is currently following the panel-wide global default (Server Access section above)."}
                          </p>
                          <label className="flex items-center gap-3 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={permissionsDraft.canCreateServers}
                              onChange={(e) => setPermissionsDraft(d => ({ ...d, canCreateServers: e.target.checked }))}
                              className="w-4 h-4 rounded accent-cyan-500"
                            />
                            <span className="text-sm text-zinc-200">Allow this user to create their own servers</span>
                          </label>
                          {permissionsDraft.canCreateServers && (
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-[11px] font-medium text-zinc-500 mb-1">Max Servers</label>
                                <input type="number" min={0} max={50} value={permissionsDraft.maxServers}
                                  onChange={(e) => setPermissionsDraft(d => ({ ...d, maxServers: Number(e.target.value) }))}
                                  className="w-full bg-white/[0.03] border border-white/10 focus:border-cyan-500 rounded-lg px-3 py-2 text-sm text-white outline-none" />
                              </div>
                              <div>
                                <label className="block text-[11px] font-medium text-zinc-500 mb-1">Max RAM (GB) per server</label>
                                <input type="number" min={0.5} max={128} step={0.5} value={permissionsDraft.maxRamGb}
                                  onChange={(e) => setPermissionsDraft(d => ({ ...d, maxRamGb: Number(e.target.value) }))}
                                  className="w-full bg-white/[0.03] border border-white/10 focus:border-cyan-500 rounded-lg px-3 py-2 text-sm text-white outline-none" />
                              </div>
                              <div>
                                <label className="block text-[11px] font-medium text-zinc-500 mb-1">Max CPU (%) per server</label>
                                <input type="number" min={10} max={1600} value={permissionsDraft.maxCpuPercent}
                                  onChange={(e) => setPermissionsDraft(d => ({ ...d, maxCpuPercent: Number(e.target.value) }))}
                                  className="w-full bg-white/[0.03] border border-white/10 focus:border-cyan-500 rounded-lg px-3 py-2 text-sm text-white outline-none" />
                              </div>
                              <div>
                                <label className="block text-[11px] font-medium text-zinc-500 mb-1">Max Disk (GB) per server</label>
                                <input type="number" min={1} max={1000} value={permissionsDraft.maxDiskGb}
                                  onChange={(e) => setPermissionsDraft(d => ({ ...d, maxDiskGb: Number(e.target.value) }))}
                                  className="w-full bg-white/[0.03] border border-white/10 focus:border-cyan-500 rounded-lg px-3 py-2 text-sm text-white outline-none" />
                              </div>
                            </div>
                          )}
                          <div className="flex gap-2">
                            <button
                              disabled={isSavingPermissions}
                              onClick={() => saveServerPermissions(u.id)}
                              className="px-4 py-2 bg-cyan-500 hover:bg-sky-600 text-white text-sm font-medium rounded-lg transition-colors shadow-sm disabled:opacity-50"
                            >
                              {isSavingPermissions ? "Saving..." : "Save Access"}
                            </button>
                            {u.hasServerPermissionOverride && (
                              <button
                                disabled={isSavingPermissions}
                                onClick={() => resetServerPermissionsToGlobal(u.id)}
                                className="px-4 py-2 bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                              >
                                Use Global Default
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                      {editingUserId === u.id && (
                        <div className="mt-4 pt-4 border-t border-white/5 flex gap-3">
                          <input 
                            type="password" 
                            placeholder="New Password (min 8 chars)" 
                            value={adminUserNewPassword}
                            onChange={(e) => setAdminUserNewPassword(e.target.value)}
                            className="flex-1 bg-white/[0.03] border border-white/10 focus:border-cyan-500 rounded-lg px-3 py-2 text-sm text-white outline-none"
                          />
                          <button 
                            onClick={() => changeUserPassword(u.id)}
                            className="px-4 py-2 bg-cyan-500 hover:bg-sky-600 text-white text-sm font-medium rounded-lg transition-colors shadow-sm"
                          >
                            Save
                          </button>
                        </div>
                      )}
                   </div>

                 ))}
               </div>
            </div>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="bg-[#0a0a0c] border border-white/5 rounded-2xl p-6 md:p-8 shadow-xl mt-8">
          <h2 className="text-xl font-bold mb-4 flex items-center text-white">
            <RefreshCw className="mr-3 text-emerald-400 w-5 h-5" /> System Update
          </h2>
          <p className="text-zinc-400 text-sm mb-6 max-w-2xl">
            Trigger an automatic update of FrostByte Panel. This will run git pull and rebuild the system. The panel will be unavailable for a few seconds during this process.
          </p>
          <button 
            onClick={handleSystemUpdate}
            disabled={isUpdatingSystem}
            className="px-6 py-2.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-medium rounded-xl border border-emerald-500/20 transition-all shadow-sm flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isUpdatingSystem ? "animate-spin" : ""}`} />
            {isUpdatingSystem ? "Updating System..." : "Update Panel"}
          </button>
        </div>
      )}

      {(isProcessing || isUpdatingLogo || isSavingSettings || isChangingPassword || isCreatingUser || isUpdatingSystem) && <LoadingOverlay />}
    </motion.div>
  );
}
