import { useEffect } from "react";

import { useEarthLayers, type EarthLayers } from "../store/earthLayers";
import { DEFAULT_LAYOUT, globeControl, type GlobeLayout } from "./globeControl";

/**
 * Set where the globe sits while a page is open, and what layers it draws.
 * On leaving, everything goes back to normal. `side` tucks the globe to the
 * right (or left) of the screen on wide windows so page content has room.
 */
export function useGlobeStage(
  layout: Partial<GlobeLayout> & { side?: "right" | "left" | "centre" },
  layers: Partial<Omit<EarthLayers, "set" | "clear">> = {},
  drift = 0.05,
): void {
  const { side = "centre", ...place } = layout;
  const wide = typeof window !== "undefined" && window.innerWidth >= 1000;
  const shift = side === "centre" || !wide ? 0 : (side === "right" ? 1 : -1) * 1.35;
  const key = JSON.stringify([place, shift, drift]);
  useEffect(() => {
    globeControl.setLayout({ ...DEFAULT_LAYOUT, ...place, x: shift + (place.x ?? 0) });
    globeControl.drift = drift;
    return () => {
      globeControl.setLayout({});
      globeControl.drift = 0.05;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const layerKey = JSON.stringify(Object.keys(layers));
  useEffect(() => {
    useEarthLayers.getState().set(layers);
    return () => useEarthLayers.getState().clear();
    // Layers with large payloads (quakes, satellites) are set by their pages; only the flags matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerKey]);
}
