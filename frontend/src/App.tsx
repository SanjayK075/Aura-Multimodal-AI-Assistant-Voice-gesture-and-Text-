import { useEffect, useMemo } from "react";

import { HandCursors, Toasts } from "./components/CameraPreview";
import { Dock } from "./components/Dock";
import { Drawer } from "./components/drawers/Drawer";
import { PanelLayer } from "./components/PanelLayer";
import { Scene } from "./components/Scene";
import { TopBar } from "./components/TopBar";
import { WelcomeHero } from "./components/WelcomeHero";
import { api } from "./lib/api";
import { ask, handleUtterance, stopEverything } from "./lib/assistant";
import { globeControl } from "./lib/globeControl";
import { handTracker } from "./lib/handTracker";
import { isTrackingIss, useStore } from "./store/useStore";

/** Keep trying to reach the backend. Free hosts sleep when idle and take a while to wake. */
function useServerConnection(): void {
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let attempts = 0;
    const connect = async () => {
      try {
        const config = await api.config();
        if (stopped) return;
        useStore.getState().setConnection("ready", config);
      } catch {
        if (stopped) return;
        attempts += 1;
        if (attempts >= 2) useStore.getState().setConnection("unreachable");
        timer = window.setTimeout(connect, 3000);
      }
    };
    void connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);
}

/** While a space-station panel is open, fetch its position every five seconds. */
function useStationTracking(): void {
  const panels = useStore((s) => s.panels);
  const tracking = useMemo(() => isTrackingIss(panels), [panels]);
  useEffect(() => {
    if (!tracking) {
      useStore.getState().setIss(null);
      return;
    }
    const controller = new AbortController();
    const update = () =>
      api
        .iss(controller.signal)
        .then((position) => useStore.getState().setIss(position))
        .catch(() => undefined); // keep the last known position
    void update();
    const timer = window.setInterval(update, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [tracking]);
}

export function App() {
  useServerConnection();
  useStationTracking();

  useEffect(() => {
    // Show the guide once, the first time someone opens the app.
    const { settings, setDrawer, updateSettings } = useStore.getState();
    if (!settings.helpSeen) {
      setDrawer("help");
      updateSettings({ helpSeen: true });
    }

    const onKey = (event: KeyboardEvent) => {
      const state = useStore.getState();
      if (event.key === "Escape" && !state.drawer && (state.busy || state.phase === "speaking")) stopEverything();
    };
    window.addEventListener("keydown", onKey);

    // ?testhooks in the address exposes ways to feed in hand positions and spoken
    // phrases without a camera or microphone. Used by the automated browser test,
    // and handy for debugging gestures.
    if (new URLSearchParams(window.location.search).has("testhooks")) {
      (window as unknown as Record<string, unknown>).__aura = {
        store: useStore,
        globe: globeControl,
        ask,
        /** Behave as if this phrase had just been heard by the microphone. */
        say: (text: string, confidence = 0.9) => handleUtterance(text, confidence),
        injectHands: (hands: { x: number; y: number }[][], now?: number) =>
          handTracker.process(hands, now ?? performance.now()),
      };
    }
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <Scene />
      <WelcomeHero />
      <PanelLayer />
      <TopBar />
      <Dock />
      <Drawer />
      <Toasts />
      <HandCursors />
    </>
  );
}
