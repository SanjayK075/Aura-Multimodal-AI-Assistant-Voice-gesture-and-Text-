/**
 * Page routing. Plain hash URLs (#/weather) so it works on any static host
 * without server configuration, and the browser Back button just works.
 *
 * PAGES is also the order pages are visited in when swiping by hand or saying
 * "next page", so the order below is the order of the swipe carousel.
 */
import { useSyncExternalStore } from "react";

export type PageId =
  | "home"
  | "command"
  | "agent"
  | "weather"
  | "earth"
  | "satellites"
  | "map"
  | "news"
  | "github"
  | "memory";

export interface PageDef {
  id: PageId;
  path: string;
  title: string;
  blurb: string;
  /** Pages that put the 3D globe behind their content. */
  globe: boolean;
  /** Voice words that open the page: "open the weather page". */
  say: string[];
}

export const PAGES: PageDef[] = [
  { id: "home", path: "/", title: "Home", blurb: "Everything Aura can do, at a glance", globe: true, say: ["home", "home page", "start"] },
  { id: "command", path: "/command", title: "Command", blurb: "Talk to Aura. Answers float over the globe", globe: true, say: ["command", "globe", "assistant", "command centre", "command center"] },
  { id: "agent", path: "/agent", title: "Agent", blurb: "Multi-step planner with a live trace", globe: false, say: ["agent", "planner", "multi step agent", "agent trace"] },
  { id: "weather", path: "/weather", title: "Weather & Air", blurb: "Forecast, hourly outlook and air quality", globe: false, say: ["weather", "air quality", "weather page", "air"] },
  { id: "earth", path: "/earth", title: "Earth Watch", blurb: "Satellite Earth, city lights and day and night", globe: true, say: ["earth", "earth watch", "satellite view", "satellite earth"] },
  { id: "satellites", path: "/satellites", title: "Satellites", blurb: "What is passing over you right now", globe: true, say: ["satellites", "satellite tracker", "starlink"] },
  { id: "map", path: "/map", title: "Street Map", blurb: "Zoom from orbit down to street level", globe: false, say: ["map", "street map", "street view", "streets"] },
  { id: "news", path: "/news", title: "News & Search", blurb: "Headlines and web search", globe: false, say: ["news", "search", "news page"] },
  { id: "github", path: "/github", title: "GitHub", blurb: "Your repositories and open issues", globe: false, say: ["github", "repositories", "repos"] },
  { id: "memory", path: "/memory", title: "Memory", blurb: "What Aura remembers about you", globe: false, say: ["memory", "memories", "remember"] },
];

const BY_ID = new Map(PAGES.map((page) => [page.id, page]));

export function pageById(id: PageId): PageDef {
  return BY_ID.get(id)!;
}

/** The page a hash like "#/weather" points at; unknown or empty hashes mean Home. */
export function pageFromHash(hash: string): PageDef {
  const path = hash.replace(/^#/, "").split("?")[0]!.replace(/\/+$/, "") || "/";
  return PAGES.find((page) => page.path === path) ?? PAGES[0]!;
}

/** The page `step` places along the carousel, wrapping around at both ends. */
export function neighbour(id: PageId, step: 1 | -1): PageDef {
  const index = PAGES.findIndex((page) => page.id === id);
  return PAGES[(index + step + PAGES.length) % PAGES.length]!;
}

/** The page a spoken name refers to ("the weather page" -> weather), if any. */
export function pageFromSpeech(phrase: string): PageDef | null {
  const text = phrase.toLowerCase().trim();
  let best: { page: PageDef; length: number } | null = null;
  for (const page of PAGES) {
    for (const name of [...page.say, page.title.toLowerCase()]) {
      if (text === name && (!best || name.length > best.length)) best = { page, length: name.length };
    }
  }
  return best?.page ?? null;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  window.addEventListener("hashchange", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("hashchange", listener);
  };
}

/** Which way the last navigation moved, so pages can slide the right way. */
let lastDirection: 1 | -1 = 1;
export function slideDirection(): 1 | -1 {
  return lastDirection;
}

export function navigate(id: PageId, direction?: 1 | -1): void {
  const target = pageById(id);
  if (direction) lastDirection = direction;
  else {
    const from = PAGES.findIndex((p) => p.path === pageFromHash(currentHash()).path);
    const to = PAGES.findIndex((p) => p.id === id);
    lastDirection = to >= from ? 1 : -1;
  }
  const hash = `#${target.path}`;
  if (window.location.hash === hash) return;
  window.location.hash = hash;
  listeners.forEach((l) => l());
}

export function swipePage(step: 1 | -1): PageDef {
  const target = neighbour(pageFromHash(currentHash()).id, step);
  navigate(target.id, step);
  return target;
}

export function currentPage(): PageDef {
  return pageFromHash(currentHash());
}

export function useRoute(): PageDef {
  const hash = useSyncExternalStore(subscribe, currentHash, () => "");
  return pageFromHash(hash);
}
