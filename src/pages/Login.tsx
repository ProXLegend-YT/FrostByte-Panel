import React, { useState, useEffect, useRef } from "react";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { useAuth } from "../context/AuthContext";
import { useSettings } from "../context/SettingsContext";
import { useNavigate } from "react-router-dom";
import gsap from "gsap";
import axios from "axios";
import { Snowflake, User, Lock } from "lucide-react";
import "./Login.css";

type Mode = "login" | "register";

export default function Login() {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const { login } = useAuth();
  const { panelName, enableLoginAnimation, allowRegistration } = useSettings();
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (allowRegistration === false && mode === "register") {
      setMode("login");
    }
  }, [allowRegistration]);

  useEffect(() => {
    const ctx = gsap.context(() => {
      if (enableLoginAnimation === false) {
        gsap.set([".frost-brand", ".frost-card"], { autoAlpha: 1, y: 0 });
        return;
      }

      gsap.set([".frost-brand", ".frost-card"], { autoAlpha: 0, y: 24 });
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
      tl.to(".frost-brand", { autoAlpha: 1, y: 0, duration: 0.7 }, 0.15)
        .to(".frost-card", { autoAlpha: 1, y: 0, duration: 0.8 }, 0.35);
    }, rootRef);

    return () => ctx.revert();
  }, [enableLoginAnimation]);

  const displayName = panelName || "FrostByte Panel";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const res = await axios.post(endpoint, { username, password });
      login(res.data.token, res.data.user);
      navigate("/");
    } catch (err: any) {
      setError(err.response?.data?.error || (mode === "login" ? "Login failed" : "Registration failed"));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="frost-wrapper" ref={rootRef}>
      <div className="frost-field">
        <div className="frost-orb frost-orb-a" />
        <div className="frost-orb frost-orb-b" />
      </div>
      <div className="frost-grid" />

      {/* Signature element: hexagonal ice-crystal lattice, draws itself in on load */}
      <div className="frost-crystal-wrap" aria-hidden="true">
        <svg viewBox="0 0 200 200">
          <defs>
            <linearGradient id="frost-crystal-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#5eead4" />
              <stop offset="100%" stopColor="#38bdf8" />
            </linearGradient>
          </defs>
          {/* Outer hex */}
          <polygon
            className="frost-crystal-line"
            points="100,20 165,57.5 165,132.5 100,170 35,132.5 35,57.5"
          />
          {/* Inner spokes */}
          <polygon
            className="frost-crystal-line delay-1"
            points="100,55 135,77.5 135,122.5 100,145 65,122.5 65,77.5"
          />
          <line className="frost-crystal-line delay-2" x1="100" y1="20" x2="100" y2="170" />
          <line className="frost-crystal-line delay-2" x1="35" y1="57.5" x2="165" y2="132.5" />
          <line className="frost-crystal-line delay-2" x1="165" y1="57.5" x2="35" y2="132.5" />
          {[
            [100, 20], [165, 57.5], [165, 132.5], [100, 170], [35, 132.5], [35, 57.5], [100, 95],
          ].map(([cx, cy], i) => (
            <circle key={i} className="frost-crystal-node" cx={cx} cy={cy} r={2.2} style={{ animationDelay: `${0.4 + i * 0.08}s` }} />
          ))}
        </svg>
      </div>

      <div style={{ position: "relative", zIndex: 2, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div className="frost-brand">
          <div className="frost-brand-icon">
            <Snowflake size={26} color="#5eead4" strokeWidth={1.75} />
          </div>
          <h1 className="frost-brand-title">{displayName}</h1>
          <p className="frost-brand-subtitle">Server Management</p>
        </div>

        <div className="frost-card">
          {allowRegistration !== false ? (
            <div className="frost-tabs" role="tablist" aria-label="Authentication mode">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "login"}
                className={`frost-tab ${mode === "login" ? "active" : ""}`}
                onClick={() => { setMode("login"); setError(""); }}
              >
                Sign In
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "register"}
                className={`frost-tab ${mode === "register" ? "active" : ""}`}
                onClick={() => { setMode("register"); setError(""); }}
              >
                Create Account
              </button>
            </div>
          ) : (
            <h2 style={{ textAlign: "center", fontSize: "1.1rem", fontWeight: 700, color: "#e2e8f0", marginBottom: "1.5rem" }}>
              Sign In
            </h2>
          )}

          <form onSubmit={handleSubmit} className="frost-form">
            {error && <div className="frost-error">{error}</div>}

            <div className="frost-input-group">
              <User className="frost-input-icon" size={17} strokeWidth={2} />
              <input
                type="text"
                name="username"
                required
                autoComplete="username"
                placeholder="Username"
                className="frost-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>

            <div className="frost-input-group">
              <Lock className="frost-input-icon" size={17} strokeWidth={2} />
              <input
                type="password"
                name="password"
                required
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                placeholder="Password"
                className="frost-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={mode === "register" ? 8 : undefined}
              />
            </div>

            {mode === "register" && (
              <p className="frost-hint">At least 8 characters. The first account created becomes the panel owner.</p>
            )}

            <button type="submit" className="frost-submit" disabled={isLoading}>
              {isLoading
                ? (mode === "login" ? "Authenticating..." : "Creating account...")
                : (mode === "login" ? "Sign In" : "Create Account")}
            </button>
          </form>

          {allowRegistration !== false && (
            <p className="frost-footnote">
              {mode === "login" ? (
                <>New here? <a href="#" onClick={(e) => { e.preventDefault(); setMode("register"); setError(""); }} style={{ color: "#5eead4" }}>Create an account</a></>
              ) : (
                <>Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); setMode("login"); setError(""); }} style={{ color: "#5eead4" }}>Sign in</a></>
              )}
            </p>
          )}
        </div>
      </div>

      {isLoading && <LoadingOverlay message={mode === "login" ? "Authenticating..." : "Creating your account..."} />}
    </div>
  );
}
