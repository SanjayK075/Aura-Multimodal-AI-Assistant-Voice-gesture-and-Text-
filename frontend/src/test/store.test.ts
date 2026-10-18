import { beforeEach, describe, expect, it } from "vitest";

import type { PanelData } from "../store/types";
import { globePointsOf, useStore } from "../store/useStore";

const answer = (title: string): PanelData => ({ type: "answer", title, text: "..." });
const weather = (city: string): PanelData =>
  ({
    type: "weather",
    title: `Weather in ${city}`,
    points: [{ lat: 13, lon: 80, label: city, kind: "city" }],
  }) as PanelData;
function resize(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
}

const titles = () => useStore.getState().panels.map((p) => p.data.title);

beforeEach(() => {
  resize(1440, 900); // a laptop: one slot either side of the globe
  useStore.setState({ panels: [], focusedId: null, followups: [], conversationId: null, globeFocus: null });
});

describe("adding panels", () => {
  it("places the first two beside the globe and focuses the newest", () => {
    const store = useStore.getState();
    const a = store.addPanel(answer("A"), "t1");
    const b = store.addPanel(answer("B"), "t2");
    const [first, second] = useStore.getState().panels;
    expect([first!.x, second!.x]).toEqual([20, 1440 - 440 - 20]);
    expect(first!.y).toBe(second!.y);
    expect(useStore.getState().focusedId).toBe(b);
    expect(second!.z).toBeGreaterThan(first!.z);
    expect(a).not.toBe(b);
  });

  it("replaces the oldest panel once both slots are in use", () => {
    const store = useStore.getState();
    store.addPanel(answer("A"), "t1");
    store.addPanel(answer("B"), "t2");
    store.addPanel(answer("C"), "t3");
    expect(titles()).toEqual(["B", "C"]);
    expect(useStore.getState().panels[1]!.x).toBe(20); // C took the slot A left
  });

  it("never removes a pinned panel", () => {
    const store = useStore.getState();
    const a = store.addPanel(answer("A"), "t1");
    store.togglePin(a);
    store.addPanel(answer("B"), "t2");
    store.addPanel(answer("C"), "t3");
    store.addPanel(answer("D"), "t4");
    expect(titles()).toContain("A");
    expect(titles()).toHaveLength(3); // the pinned one plus the two newest
    expect(titles().slice(-2)).toEqual(["C", "D"]);
  });

  it("keeps every panel from one answer together, even past the slot count", () => {
    const store = useStore.getState();
    store.addPanel(answer("old"), "t1");
    store.addPanel(answer("one"), "t2");
    store.addPanel(answer("two"), "t2");
    store.addPanel(answer("three"), "t2");
    expect(titles()).toEqual(["one", "two", "three"]);
    const positions = new Set(useStore.getState().panels.map((p) => `${p.x},${p.y}`));
    expect(positions.size).toBe(3);
  });

  it("allows four panels on a tall window", () => {
    resize(1920, 1200);
    const store = useStore.getState();
    for (const name of ["A", "B", "C", "D", "E"]) store.addPanel(answer(name), `t${name}`);
    expect(titles()).toEqual(["B", "C", "D", "E"]);
  });

  it("stacks up to six on a narrow screen", () => {
    resize(390, 800);
    const store = useStore.getState();
    for (let i = 0; i < 8; i++) store.addPanel(answer(`P${i}`), `t${i}`);
    expect(titles()).toEqual(["P2", "P3", "P4", "P5", "P6", "P7"]);
  });

  it("turns the globe to a panel's place", () => {
    useStore.getState().addPanel(weather("Chennai"), "t1");
    expect(useStore.getState().globeFocus).toMatchObject({ lat: 13, lon: 80, label: "Chennai" });
  });
});

describe("working with panels", () => {
  it("moves within bounds, scales within limits, and focuses by raising", () => {
    const store = useStore.getState();
    const a = store.addPanel(answer("A"), "t1");
    const b = store.addPanel(answer("B"), "t2");
    store.movePanel(a, 100, 50);
    expect(useStore.getState().panels[0]).toMatchObject({ x: 120, y: 122 });
    store.movePanel(a, -99999, -99999);
    expect(useStore.getState().panels[0]).toMatchObject({ x: 120 - 440, y: 56 });

    store.setPanelScale(a, 99);
    expect(useStore.getState().panels[0]!.scale).toBe(1.8);
    store.setPanelScale(a, 0.01);
    expect(useStore.getState().panels[0]!.scale).toBe(0.6);

    store.focusPanel(a);
    const [pa, pb] = useStore.getState().panels;
    expect(pa!.z).toBeGreaterThan(pb!.z);
    expect(useStore.getState().focusedId).toBe(a);
    expect(b).toBe(pb!.id);
  });

  it("closing moves focus to the newest remaining panel", () => {
    const store = useStore.getState();
    const a = store.addPanel(answer("A"), "t1");
    const b = store.addPanel(answer("B"), "t2");
    store.closePanel(b);
    expect(useStore.getState().focusedId).toBe(a);
    store.closePanel(a);
    expect(useStore.getState().focusedId).toBeNull();
  });

  it("clear and new conversation keep pinned panels", () => {
    const store = useStore.getState();
    const a = store.addPanel(answer("A"), "t1");
    store.addPanel(answer("B"), "t2");
    store.togglePin(a);
    expect(store.closeUnpinned()).toBe(1);
    expect(titles()).toEqual(["A"]);

    store.addPanel(answer("C"), "t3");
    store.setConversation("abc");
    store.setFollowups(["x"]);
    store.newConversation();
    const state = useStore.getState();
    expect(titles()).toEqual(["A"]);
    expect(state.conversationId).toBeNull();
    expect(state.followups).toEqual([]);
  });

  it("collects globe markers from the open panels", () => {
    const store = useStore.getState();
    store.addPanel(weather("Chennai"), "t1");
    const id = store.addPanel(answer("No markers"), "t2");
    expect(globePointsOf(useStore.getState().panels).map((p) => p.label)).toEqual(["Chennai"]);
    store.closePanel(id);
    expect(globePointsOf(useStore.getState().panels)).toHaveLength(1);
  });
});

describe("settings and toasts", () => {
  it("persists settings to localStorage", () => {
    useStore.getState().updateSettings({ defaultCity: "Vellore", units: "imperial" });
    const saved = JSON.parse(localStorage.getItem("aura.settings.v1")!);
    expect(saved).toMatchObject({ defaultCity: "Vellore", units: "imperial", newsRegion: "IN" });
  });

  it("shows at most three toasts and doesn't repeat an identical one", () => {
    const store = useStore.getState();
    useStore.setState({ toasts: [] });
    store.toast("one");
    store.toast("one");
    store.toast("two");
    store.toast("three", "error");
    store.toast("four");
    expect(useStore.getState().toasts.map((t) => t.text)).toEqual(["two", "three", "four"]);
    store.dismissToast(useStore.getState().toasts[0]!.id);
    expect(useStore.getState().toasts).toHaveLength(2);
  });
});
