/**
 * What the globe draws on top of the planet, set by whichever page is open.
 * Kept apart from the main store because it is read every animation frame.
 */
import { create } from "zustand";

import type { Tracked } from "../lib/orbits";

export interface EarthLayers {
  /** Satellites to move along their orbits, and the ids to highlight (the ones overhead). */
  satellites: { tracked: Tracked[]; highlight: Set<string> } | null;
  clouds: boolean;
  /** Day and night shading with a glowing terminator line. */
  terminator: boolean;
  /** Spinning hologram rings around the planet. */
  rings: boolean;
  /** A place to mark, e.g. the observer of the satellite page. */
  pin: { lat: number; lon: number; label: string } | null;
  set(patch: Partial<Omit<EarthLayers, "set" | "clear">>): void;
  clear(): void;
}

const EMPTY = { satellites: null, clouds: false, terminator: true, rings: true, pin: null };

export const useEarthLayers = create<EarthLayers>()((set) => ({
  ...EMPTY,
  set: (patch) => set(patch),
  clear: () => set({ ...EMPTY }),
}));
