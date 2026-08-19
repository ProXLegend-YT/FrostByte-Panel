import React, { createContext, useContext, useState, useEffect } from "react";
import axios from "axios";

export const SettingsContext = createContext<any>(null);

// Converts a hex color like "#0EA5E9" into HSL components so we can drive
// the --accent-light/--accent-dark CSS variable variants (see index.css)
// from a single admin-picked color, without shipping a full HSL picker UI.
const hexToHsl = (hex: string): { h: number; s: number; l: number } | null => {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
};

export const SettingsProvider = ({ children }: { children: React.ReactNode }) => {
  const [panelName, setPanelName] = useState<string>("FrostByte Panel");
  const [panelLogo, setPanelLogo] = useState<string>("");
  const [panelBackgroundImage, setPanelBackgroundImage] = useState<string>("");
  const [panelBackgroundBlur, setPanelBackgroundBlur] = useState<number>(10);
  const [allowRegistration, setAllowRegistration] = useState<boolean>(true);
  const [allowUserServerCreation, setAllowUserServerCreation] = useState<boolean>(false);
  const [enablePlayit, setEnablePlayit] = useState<boolean>(false);
  const [accentColor, setAccentColor] = useState<string>("#0EA5E9");

  const fetchSettings = async () => {
    try {
      const res = await axios.get("/api/settings");
      if (res.data.panelName) setPanelName(res.data.panelName);
      if (res.data.panelLogo !== undefined) setPanelLogo(res.data.panelLogo);
      if (res.data.panelBackgroundImage !== undefined) setPanelBackgroundImage(res.data.panelBackgroundImage);
      if (res.data.panelBackgroundBlur !== undefined) setPanelBackgroundBlur(res.data.panelBackgroundBlur);
      if (res.data.allowRegistration !== undefined) setAllowRegistration(res.data.allowRegistration);
      if (res.data.allowUserServerCreation !== undefined) setAllowUserServerCreation(res.data.allowUserServerCreation);
      if (res.data.enablePlayit !== undefined) setEnablePlayit(res.data.enablePlayit);
      if (res.data.accentColor) setAccentColor(res.data.accentColor);
    } catch (e) {}
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  // Applies the chosen accent color as CSS custom properties on :root.
  // Falls back silently to the default frost-cyan if the stored value
  // isn't valid hex (e.g. corrupted settings.json) rather than breaking
  // the whole panel's styling.
  useEffect(() => {
    const hsl = hexToHsl(accentColor);
    if (!hsl) return;
    const root = document.documentElement.style;
    root.setProperty("--accent-h", String(hsl.h));
    root.setProperty("--accent-s", `${hsl.s}%`);
    root.setProperty("--accent-l", `${hsl.l}%`);
  }, [accentColor]);

  return (
    <SettingsContext.Provider value={{ 
      panelName, setPanelName, 
      panelLogo, setPanelLogo, 
      panelBackgroundImage, setPanelBackgroundImage, 
      panelBackgroundBlur, setPanelBackgroundBlur, 
      allowRegistration, setAllowRegistration,
      allowUserServerCreation, setAllowUserServerCreation,
      enablePlayit, setEnablePlayit,
      accentColor, setAccentColor,
      fetchSettings 
    }}>
      {children}
    </SettingsContext.Provider>
  );
};

export const useSettings = () => useContext(SettingsContext);
