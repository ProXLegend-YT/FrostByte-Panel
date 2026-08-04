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
  const { panelName, allowRegistration } = useSettings();
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (allowRegistration === false && mode === "register") {
      setMode("login");
    }
  }, [allowRegistration]);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set([".frost-brand", ".frost-card-shell"], { autoAlpha: 0, y: 24 });
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
      tl.to(".frost-brand", { autoAlpha: 1, y: 0, duration: 0.7 }, 0.15)
        .to(".frost-card-shell", { autoAlpha: 1, y: 0, duration: 0.8 }, 0.35);
    }, rootRef);

    return () => ctx.revert();
  }, []);

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
      {/* No local orb/grid/particle layers here anymore — GlobalBackground
          (mounted at the app root) already supplies the ambient atmosphere.
          Rendering a second full set on top of it was the main cause of both
          the lag (2x blurred, animating layers compositing at once on
          mobile GPUs) and the login card reading as murkier than intended
          (two stacked semi-opaque layers behind the glass instead of one). */}

      <div style={{ position: "relative", zIndex: 2, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div className="frost-brand">
          <div className="frost-brand-icon">
            <Snowflake size={26} color="#5eead4" strokeWidth={1.75} />
          </div>
          <h1 className="frost-brand-title">{displayName}</h1>
          <p className="frost-brand-subtitle">Server Management</p>
        </div>

        <div className="frost-card-shell">
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
            <h2 className="frost-solo-heading">Sign In</h2>
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
      </div>

      {isLoading && <LoadingOverlay message={mode === "login" ? "Authenticating..." : "Creating your account..."} />}
    </div>
  );
}
