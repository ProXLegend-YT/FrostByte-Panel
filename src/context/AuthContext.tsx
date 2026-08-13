import React, { createContext, useContext, useState, useEffect } from "react";
import axios from "axios";

export const AuthContext = createContext<any>(null);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<any>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem("frostbyte_token"));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
      axios.get("/api/auth/me").then(res => {
        setUser(res.data.user);
        setLoading(false);
      }).catch(() => {
        setToken(null);
        localStorage.removeItem("frostbyte_token");
        setUser(null);
        setLoading(false);
      });
    } else {
      setLoading(false);
    }
  }, [token]);

  // Re-fetches just the /me payload without touching the token — used
  // after actions that change account-level fields (like toggling 2FA)
  // that the JWT itself doesn't carry, so the UI reflects the new state
  // without forcing a full re-login.
  const refreshUser = async () => {
    if (!token) return;
    try {
      const res = await axios.get("/api/auth/me");
      setUser(res.data.user);
    } catch { /* leave existing user state as-is on failure */ }
  };

  useEffect(() => {
    const interceptor = axios.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          setToken(null);
          setUser(null);
          localStorage.removeItem("frostbyte_token");
          delete axios.defaults.headers.common["Authorization"];
        }
        return Promise.reject(error);
      }
    );
    return () => axios.interceptors.response.eject(interceptor);
  }, []);

  const login = (token: string, user: any) => {
    setToken(token);
    setUser(user);
    localStorage.setItem("frostbyte_token", token);
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem("frostbyte_token");
    delete axios.defaults.headers.common["Authorization"];
  };

  // "owner" is the highest-privilege role (granted automatically to the very
  // first account registered on a fresh instance) and must have every
  // capability an "admin" has. Anywhere the UI checks for admin-only
  // features, use isAdmin rather than comparing role === "admin" directly.
  const isAdmin = user?.role === "admin" || user?.role === "owner";

  // Normal users can be individually granted server-creation rights by an
  // admin (see Settings → Administrator Controls). Admins/owners always
  // have this implicitly.
  const canCreateServers = isAdmin || !!user?.canCreateServers;

  return (
    <AuthContext.Provider value={{ user, token, login, logout, loading, isAdmin, canCreateServers, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
