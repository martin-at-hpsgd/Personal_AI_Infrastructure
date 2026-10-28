"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { apiFetch, apiSend } from "@/lib/api";

export const OBSERVER_STORAGE_KEY = "pulse-observer-mode";

/** The shared obfuscation switch (LIFEOS/TOOLS/Obfuscate.ts): on while OBS runs or after `ob`. */
export const OBFUSCATE_PATH = "/api/obfuscate";
/** How often a visible tab re-reads the switch, so `ob` in a terminal reaches it within seconds. */
export const OBFUSCATE_POLL_MS = 2_000;

interface ObserverModeContextValue {
  observerMode: boolean;
  toggleObserverMode: () => void;
}

const ObserverModeContext = createContext<ObserverModeContextValue>({
  observerMode: false,
  toggleObserverMode: () => {},
});

export function ObserverModeProvider({ children }: { children: ReactNode }) {
  const [observerMode, setObserverMode] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Initial state comes from localStorage after mount; the pre-paint script in
  // layout.tsx already applied the html class, so there is no visible flash while
  // React catches up. The shared switch then takes over.
  useEffect(() => {
    setObserverMode(localStorage.getItem(OBSERVER_STORAGE_KEY) === "1");
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.classList.toggle("observer-active", observerMode);
    localStorage.setItem(OBSERVER_STORAGE_KEY, observerMode ? "1" : "0");
  }, [observerMode, hydrated]);

  // Follow the shared switch. Hidden tabs keep reading too: a tab brought forward mid-stream must already be blurred,
  // never paint first and catch up. A read that fails keeps what the tab already shows.
  useEffect(() => {
    let live = true;
    const read = () => {
      apiFetch<{ on?: unknown }>(OBFUSCATE_PATH)
        .then((s) => { if (live && typeof s.on === "boolean") setObserverMode(s.on); })
        .catch(() => {});
    };
    read();
    const timer = setInterval(read, OBFUSCATE_POLL_MS);
    document.addEventListener("visibilitychange", read);
    return () => { live = false; clearInterval(timer); document.removeEventListener("visibilitychange", read); };
  }, []);

  // The button is the same switch as `ob`; without the daemon it still flips this tab.
  const toggleObserverMode = useCallback(() => {
    apiSend<{ on?: unknown }>(OBFUSCATE_PATH, "POST", { action: "toggle" })
      .then((s) => setObserverMode((prev) => (typeof s.on === "boolean" ? s.on : !prev)))
      .catch(() => setObserverMode((prev) => !prev));
  }, []);

  return (
    <ObserverModeContext.Provider value={{ observerMode, toggleObserverMode }}>
      {children}
    </ObserverModeContext.Provider>
  );
}

export function useObserverMode() {
  return useContext(ObserverModeContext);
}
