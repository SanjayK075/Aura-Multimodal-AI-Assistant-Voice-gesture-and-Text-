/**
 * All application state, in one Zustand store.
 *
 * Components subscribe to the slices they render. Code outside React (hand
 * tracking, voice, the chat stream) reads and writes through
 * useStore.getState(), so there is a single source of truth either way.
 */
import { create } from "zustand";

import { GESTURE_CONFIG } from "../config/gestures";
import {
  clampPanel,
  COMPACT_WIDTH,
  freeSlot,
  MAX_STACKED_PANELS,
  panelSlots,
  panelWidth,
  placePanel,
  type Size,
} from "./layout";
import type {
  AgentConfirm,
  AgentRun,
  Caption,
  Connection,
  DrawerName,
  GeoPoint,
  Panel,
  PanelData,
  Phase,
  ServerConfig,
  Settings,
  Toast,
} from "./types";

const SETTINGS_KEY = "aura.settings.v1";

export const DEFAULT_SETTINGS: Settings = {
  defaultCity: "",
  githubUsername: "",
  newsRegion: "IN",
  units: "metric",
  voiceMode: "handsfree",
  speechLang: "en-IN",
  voiceURI: "",
  speechRate: 1,
  sensitivity: "medium",
  pinchFeel: "normal",
  dwellClick: true,
  palmDismiss: true,
  showPreview: true,
  helpSeen: false,
  swipeNav: true,
  wakeWord: false,
  earthStyle: "satellite",
  agentMode: "auto",
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // Private browsing or corrupted data: fall back to defaults.
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable; settings simply won't persist.
  }
}

function viewport(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

let nextId = 1;
const uid = (prefix: string) => `${prefix}${nextId++}`;

export interface State {
  connection: Connection;
  config: ServerConfig | null;

  phase: Phase;
  phaseLabel: string;
  busy: boolean;
  conversationId: string | null;
  followups: string[];
  caption: Caption;

  panels: Panel[];
  focusedId: string | null;
  topZ: number;

  drawer: DrawerName | null;
  cameraOn: boolean;
  cameraState: "off" | "starting" | "on" | "error";
  micOn: boolean;
  muted: boolean;
  toasts: Toast[];
  settings: Settings;

  /** The place the globe should turn towards; nonce changes on every request. */
  globeFocus: (GeoPoint & { nonce: number }) | null;
  /** Bumped whenever something that the drawers list has changed on the server. */
  serverRevision: number;
  /** The multi-step run being shown on the Agent page (the latest one). */
  agent: AgentRun | null;
  /** An action waiting for the person's yes or no. */
  confirmation: AgentConfirm | null;
  /** A page-flip that just happened or is under way, for the on-screen hint. */
  swipe: { nonce: number; direction: "next" | "previous"; title: string } | null;
  swipeProgress: { value: number; direction: "next" | "previous" } | null;
  setAgent(update: AgentRun | null | ((previous: AgentRun | null) => AgentRun | null)): void;
  setConfirmation(confirmation: AgentConfirm | null): void;
  flashSwipe(direction: "next" | "previous", title: string): void;
  setSwipeProgress(progress: State["swipeProgress"]): void;

  setConnection(connection: Connection, config?: ServerConfig | null): void;
  setPhase(phase: Phase, label?: string): void;
  setBusy(busy: boolean): void;
  setConversation(id: string | null): void;
  setFollowups(followups: string[]): void;
  setCaption(patch: Partial<Caption>): void;

  addPanel(data: PanelData, turnId: string, extra?: Partial<Pick<Panel, "summary" | "streaming">>): string;
  updatePanel(id: string, patch: Partial<Pick<Panel, "summary" | "streaming" | "data">>): void;
  closePanel(id: string): void;
  /** Close every panel that isn't pinned. Returns how many closed. */
  closeUnpinned(): number;
  focusPanel(id: string): void;
  movePanel(id: string, dx: number, dy: number): void;
  setPanelScale(id: string, scale: number): void;
  togglePin(id: string): void;
  clampPanels(): void;

  setDrawer(drawer: DrawerName | null): void;
  setCamera(on: boolean): void;
  setCameraState(state: State["cameraState"]): void;
  setMic(on: boolean): void;
  setMuted(muted: boolean): void;
  toast(text: string, kind?: Toast["kind"]): void;
  dismissToast(id: number): void;
  updateSettings(patch: Partial<Settings>): void;

  focusGlobe(point: GeoPoint): void;
  touchServer(): void;
  newConversation(): void;
}

export const useStore = create<State>()((set, get) => ({
  connection: "connecting",
  config: null,

  phase: "idle",
  phaseLabel: "",
  busy: false,
  conversationId: null,
  followups: [],
  caption: { you: "", interim: "", aura: "" },

  panels: [],
  focusedId: null,
  topZ: 10,

  drawer: null,
  cameraOn: false,
  cameraState: "off",
  micOn: false,
  muted: false,
  toasts: [],
  settings: loadSettings(),

  globeFocus: null,
  serverRevision: 0,
  agent: null,
  confirmation: null,
  setConfirmation: (confirmation) => set({ confirmation }),
  swipe: null,
  swipeProgress: null,
  setAgent: (update) => set((s) => ({ agent: typeof update === "function" ? update(s.agent) : update })),
  flashSwipe: (direction, title) => set({ swipe: { nonce: nextId++, direction, title } }),
  setSwipeProgress: (swipeProgress) =>
    set((s) => {
      const a = s.swipeProgress;
      if (a === swipeProgress) return s;
      if (a && swipeProgress && a.direction === swipeProgress.direction && Math.abs(a.value - swipeProgress.value) < 0.04) return s;
      return { swipeProgress };
    }),

  setConnection: (connection, config) =>
    set((s) => ({ connection, config: config === undefined ? s.config : config })),
  setPhase: (phase, label = "") => set({ phase, phaseLabel: label }),
  setBusy: (busy) => set({ busy }),
  setConversation: (conversationId) => set({ conversationId }),
  setFollowups: (followups) => set({ followups }),
  setCaption: (patch) => set((s) => ({ caption: { ...s.caption, ...patch } })),

  addPanel: (data, turnId, extra = {}) => {
    const id = uid("p");
    set((s) => {
      // New answers replace old ones: when every slot beside the globe is in
      // use, the oldest panel goes. Pinned panels, and panels belonging to the
      // answer that is arriving right now, are never the ones removed.
      const view = viewport();
      const width = panelWidth(data);
      const capacity = view.width < COMPACT_WIDTH ? MAX_STACKED_PANELS : panelSlots(view, width).length;
      let panels = s.panels;
      for (;;) {
        const unpinned = panels.filter((p) => !p.pinned);
        const full = unpinned.length >= capacity && (view.width < COMPACT_WIDTH || !freeSlot(view, width, panels));
        const oldest = unpinned.find((p) => p.turnId !== turnId);
        if (!full || !oldest) break;
        panels = panels.filter((p) => p.id !== oldest.id);
      }
      const position = placePanel(view, width, panels);
      const z = s.topZ + 1;
      const panel: Panel = {
        id,
        turnId,
        data,
        ...position,
        scale: 1,
        z,
        pinned: false,
        summary: extra.summary ?? "",
        streaming: extra.streaming ?? false,
      };
      return { panels: [...panels, panel], focusedId: id, topZ: z };
    });
    const point = data.points?.[0];
    if (point) get().focusGlobe(point);
    return id;
  },

  updatePanel: (id, patch) =>
    set((s) => ({ panels: s.panels.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),

  closePanel: (id) =>
    set((s) => {
      const panels = s.panels.filter((p) => p.id !== id);
      const focusedId = s.focusedId === id ? (panels[panels.length - 1]?.id ?? null) : s.focusedId;
      return { panels, focusedId };
    }),

  closeUnpinned: () => {
    const before = get().panels.length;
    set((s) => {
      const panels = s.panels.filter((p) => p.pinned);
      return { panels, focusedId: panels[panels.length - 1]?.id ?? null };
    });
    return before - get().panels.length;
  },

  focusPanel: (id) =>
    set((s) => {
      if (s.focusedId === id && s.panels.find((p) => p.id === id)?.z === s.topZ) return s;
      const z = s.topZ + 1;
      return { focusedId: id, topZ: z, panels: s.panels.map((p) => (p.id === id ? { ...p, z } : p)) };
    }),

  movePanel: (id, dx, dy) =>
    set((s) => ({
      panels: s.panels.map((p) =>
        p.id === id
          ? { ...p, ...clampPanel(viewport(), panelWidth(p.data) * p.scale, { x: p.x + dx, y: p.y + dy }) }
          : p,
      ),
    })),

  setPanelScale: (id, scale) =>
    set((s) => ({
      panels: s.panels.map((p) =>
        p.id === id
          ? {
              ...p,
              scale: Math.min(GESTURE_CONFIG.panelScaleMax, Math.max(GESTURE_CONFIG.panelScaleMin, scale)),
            }
          : p,
      ),
    })),

  togglePin: (id) =>
    set((s) => ({ panels: s.panels.map((p) => (p.id === id ? { ...p, pinned: !p.pinned } : p)) })),

  clampPanels: () =>
    set((s) => ({
      panels: s.panels.map((p) => ({
        ...p,
        ...clampPanel(viewport(), panelWidth(p.data) * p.scale, { x: p.x, y: p.y }),
      })),
    })),

  setDrawer: (drawer) => set({ drawer }),
  setCamera: (cameraOn) => set({ cameraOn }),
  setCameraState: (cameraState) => set({ cameraState }),
  setMic: (micOn) => set({ micOn }),
  setMuted: (muted) => set({ muted }),

  toast: (text, kind = "info") => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.text !== text), { id, kind, text }].slice(-3) }));
    window.setTimeout(() => get().dismissToast(id), kind === "error" ? 9000 : 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  updateSettings: (patch) =>
    set((s) => {
      const settings = { ...s.settings, ...patch };
      saveSettings(settings);
      return { settings };
    }),

  focusGlobe: (point) => set({ globeFocus: { ...point, nonce: nextId++ } }),
  touchServer: () => set((s) => ({ serverRevision: s.serverRevision + 1 })),

  newConversation: () =>
    set((s) => ({
      conversationId: null,
      followups: [],
      caption: { you: "", interim: "", aura: "" },
      panels: s.panels.filter((p) => p.pinned),
      focusedId: null,
    })),
}));

/** Every map marker contributed by the given panels. */
export function globePointsOf(panels: Panel[]): GeoPoint[] {
  return panels.flatMap((panel) => panel.data.points ?? []);
}
