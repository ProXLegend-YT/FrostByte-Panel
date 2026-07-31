import React, { createContext, useContext, useState, useEffect } from "react";
import axios from "axios";

export const SettingsContext = createContext<any>(null);

export const SettingsProvider = ({ children }: { children: React.ReactNode }) => {
  const [panelName, setPanelName] = useState<string>("FrostByte Panel");
  const [panelLogo, setPanelLogo] = useState<string>("");
  const [panelBackgroundImage, setPanelBackgroundImage] = useState<string>("");
  const [panelBackgroundBlur, setPanelBackgroundBlur] = useState<number>(10);
  const [allowRegistration, setAllowRegistration] = useState<boolean>(true);
  const [allowUserServerCreation, setAllowUserServerCreation] = useState<boolean>(false);

  const fetchSettings = async () => {
    try {
      const res = await axios.get("/api/settings");
      if (res.data.panelName) setPanelName(res.data.panelName);
      if (res.data.panelLogo !== undefined) setPanelLogo(res.data.panelLogo);
      if (res.data.panelBackgroundImage !== undefined) setPanelBackgroundImage(res.data.panelBackgroundImage);
      if (res.data.panelBackgroundBlur !== undefined) setPanelBackgroundBlur(res.data.panelBackgroundBlur);
      if (res.data.allowRegistration !== undefined) setAllowRegistration(res.data.allowRegistration);
      if (res.data.allowUserServerCreation !== undefined) setAllowUserServerCreation(res.data.allowUserServerCreation);
    } catch (e) {}
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  return (
    <SettingsContext.Provider value={{ 
      panelName, setPanelName, 
      panelLogo, setPanelLogo, 
      panelBackgroundImage, setPanelBackgroundImage, 
      panelBackgroundBlur, setPanelBackgroundBlur, 
      allowRegistration, setAllowRegistration,
      allowUserServerCreation, setAllowUserServerCreation,
      fetchSettings 
    }}>
      {children}
    </SettingsContext.Provider>
  );
};

export const useSettings = () => useContext(SettingsContext);
