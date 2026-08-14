import React, { useState } from "react";
import { Sidebar } from "./Sidebar";
import { Menu, X } from "lucide-react";
import { useLocation, matchPath } from "react-router-dom";
import { useSettings } from "../context/SettingsContext";
import { NotificationBell } from "./NotificationBell";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const { panelName, panelLogo } = useSettings();

  const isServerView = matchPath("/servers/:id/*", location.pathname) && !matchPath("/servers/create", location.pathname);

  if (isServerView) {
    return (
      <div className="flex h-[100dvh] w-full bg-transparent text-zinc-100 font-sans overflow-hidden selection:bg-cyan-400/30">
        <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden relative">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-3xl h-[400px] bg-cyan-400/10 blur-[120px] rounded-full pointer-events-none" />
          <main className="flex-1 w-full h-full relative z-10 overflow-hidden">
            {children}
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex h-[100dvh] w-full bg-transparent text-zinc-100 font-sans overflow-hidden selection:bg-cyan-400/30`}>
      {/* Mobile Sidebar Overlay */}
      {mobileOpen && (
        <div 
          className="fixed inset-0 bg-black/35 backdrop-blur-sm z-40 md:hidden" 
          onClick={() => setMobileOpen(false)} 
        />
      )}
      
      {/* Sidebar Container (always available on mobile, optional on desktop based on layout) */}
      <div className={`fixed inset-y-0 left-0 z-50 transform flex-shrink-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0 transition-transform duration-300 ease-in-out`}>
        <Sidebar onClose={() => setMobileOpen(false)} />
      </div>

      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden relative">
        {/* Subtle background glow effect */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-3xl h-[400px] bg-cyan-400/10 blur-[120px] rounded-full pointer-events-none" />

        {/* Mobile Header (only shown on mobile screens) */}
        <div className="md:hidden flex items-center justify-between p-4 bg-transparent backdrop-blur-md border-b border-white/5 flex-shrink-0 relative z-30">
          <div className="flex items-center gap-2">
            {panelLogo ? (
              <img src={panelLogo} alt="Logo" className="w-6 h-6 rounded object-cover" />
            ) : (
              <div className="w-6 h-6 rounded bg-gradient-to-br from-cyan-500 to-purple-600 shadow-[0_0_10px_rgba(56,189,248,0.5)]" />
            )}
            <h1 className="text-lg font-bold tracking-tight text-white truncate">{panelName}</h1>
          </div>
          <div className="flex items-center gap-2">
            {/* Reserves space for the fixed-position NotificationBell so
                the hamburger button doesn't sit underneath it. */}
            <div className="w-9 h-9" aria-hidden="true" />
            <button onClick={() => setMobileOpen(true)} className="p-2 text-zinc-400 hover:text-white bg-white/5 rounded-lg transition-colors">
              <Menu size={20} />
            </button>
          </div>
        </div>

        {/* Desktop Header — sidebar carries branding, so this row is just spacing for the fixed bell below on md+ screens */}
        <div className="hidden md:flex items-center justify-end px-6 py-3 flex-shrink-0 relative z-30" />

        {/* Notification bell — a single mount for the whole layout, fixed
            in the top-right corner of the viewport, so it sits over both
            the mobile and desktop header rows without needing to be
            rendered twice. Each mount of NotificationBell opens its own
            Socket.IO connection; having the mobile and desktop headers
            each render their own instance (CSS `hidden` doesn't stop
            React from mounting the hidden one) meant two live sockets
            doing the same job on every page, all the time — this is what
            "the whole panel feels laggy" was actually coming from, not
            animation weight. One mount now, always. */}
        <div className="fixed top-3 right-3 md:top-3 md:right-6 z-40">
          <NotificationBell />
        </div>
        
        {/* Main Content */}
        <main className={`flex-1 w-full h-full relative z-10 ${isServerView ? 'overflow-hidden' : 'overflow-x-hidden overflow-y-auto pb-safe custom-scrollbar'}`}>
          {children}
        </main>
      </div>
    </div>
  );
}
