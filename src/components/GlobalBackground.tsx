import React from 'react';
import { useSettings } from '../context/SettingsContext';

export function GlobalBackground() {
  const { panelBackgroundImage, panelBackgroundBlur } = useSettings();

  if (panelBackgroundImage) {
    return (
      <div
        className="fixed inset-0 z-[-1] bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: `url(${panelBackgroundImage})`,
          filter: `blur(${panelBackgroundBlur || 0}px)`,
          transform: 'scale(1.1)', // To prevent blurred edges from showing the background behind it
        }}
      >
        <div className="absolute inset-0 bg-black/40" /> {/* Dark overlay for readability */}
      </div>
    );
  }

  // Default FrostByte ambient background — a quiet drifting frost glow.
  // Admins can override this entirely by setting a custom background image.
  return (
    <div className="fixed inset-0 z-[-1] overflow-hidden bg-[#030308]" aria-hidden="true">
      <div
        className="absolute rounded-full"
        style={{
          width: '46vw', height: '46vw', top: '-14vw', right: '-10vw',
          // Raised from 0.10 — the whole point of a transparent login card
          // is to reveal this glow, so it needs to be visible enough to be
          // worth revealing. Too faint here made "more transparent" look
          // like "more plain black" no matter how light the card got.
          background: 'radial-gradient(circle, rgba(56,189,248,0.18) 0%, transparent 70%)',
          filter: 'blur(90px)',
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          width: '38vw', height: '38vw', bottom: '-12vw', left: '-8vw',
          background: 'radial-gradient(circle, rgba(124,111,240,0.15) 0%, transparent 70%)',
          filter: 'blur(90px)',
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(rgba(94,234,212,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(94,234,212,0.025) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black 20%, transparent 85%)',
          WebkitMaskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black 20%, transparent 85%)',
        }}
      />
    </div>
  );
}
