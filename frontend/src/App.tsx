import { useEffect, type ReactNode } from "react";

import { HandCursors, Toasts } from "./components/CameraPreview";
import { ConfirmCard } from "./components/ConfirmCard";
import { Dock } from "./components/Dock";
import { Drawer } from "./components/drawers/Drawer";
import { Scene } from "./components/Scene";
import { SwipeHint } from "./components/SwipeHint";
import { TopBar } from "./components/TopBar";
import { api } from "./lib/api";
import { ask, handleUtterance, stopEverything } from "./lib/assistant";
import { globeControl } from "./lib/globeControl";
import { handTracker } from "./lib/handTracker";
import { subsolarPoint } from "./lib/sun";
import { slideDirection, useRoute, type PageId } from "./lib/router";
import { AgentPage } from "./pages/AgentPage";
import { CommandPage } from "./pages/CommandPage";
import { EarthPage } from "./pages/EarthPage";
import { GithubPage } from "./pages/GithubPage";
import { HomePage } from "./pages/HomePage";
import { MapPage } from "./pages/MapPage";
import { MemoryPage } from "./pages/MemoryPage";
import { NewsPage } from "./pages/NewsPage";
import { SatellitesPage } from "./pages/SatellitesPage";
import { WeatherPage } from "./pages/WeatherPage";
import { useStore } from "./store/useStore";

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

const PAGE_BODIES: Record<PageId, () => ReactNode> = {
  home: () => <HomePage />,
  command: () => <CommandPage />,
  agent: () => <AgentPage />,
  weather: () => <WeatherPage />,
  earth: () => <EarthPage />,
  satellites: () => <SatellitesPage />,
  map: () => <MapPage />,
  news: () => <NewsPage />,
  github: () => <GithubPage />,
  memory: () => <MemoryPage />,
};

/** Pages where dragging or scrolling on the globe turns it. */
const INTERACTIVE_GLOBE: PageId[] = ["command", "earth", "home", "satellites"];

/** Shows the current page. Changing page replaces it and slides the new one in from the side the hand or button moved. */
function PageHost() {
  const route = useRoute();
  return (
    <div className="page-host">
      <div className="page" key={route.id} data-page={route.id} data-globe={route.globe} data-slide={slideDirection() === 1 ? "next" : "previous"}>
        {PAGE_BODIES[route.id]()}
      </div>
    </div>
  );
}

export function App() {
  useServerConnection();
  const route = useRoute();

  useEffect(() => {
    // Open on the sunlit side of the Earth, turning in from the default view.
    const sun = subsolarPoint(new Date());
    globeControl.faceTowards(sun.lat, sun.lon);

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
      <Scene active={route.globe} interactive={route.globe && INTERACTIVE_GLOBE.includes(route.id)} />
      <PageHost />
      <TopBar />
      <Dock />
      <Drawer />
      <ConfirmCard />
      <SwipeHint />
      <Toasts />
      <HandCursors />
    </>
  );
}
