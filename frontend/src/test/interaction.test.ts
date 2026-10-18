import { beforeEach, describe, expect, it } from "vitest";

import { GESTURE_CONFIG } from "../config/gestures";
import type { GestureEvent, GestureFrame, HandState } from "../lib/gestures";
import { InteractionManager, type CursorView, type InteractionHost } from "../lib/interaction";

/** A fake page: named rectangles stand in for real layout, which jsdom doesn't compute. */
class FakePage implements InteractionHost {
  regions: { element: Element; x: number; y: number; w: number; h: number }[] = [];
  log: string[] = [];
  scales = new Map<string, number>();
  globeZoom = 1;
  cursors = new Map<number, CursorView>();
  palmEnabled = true;
  dwellOn = true;

  add(html: string, x: number, y: number, w: number, h: number, parent?: Element): Element {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const element = holder.firstElementChild!;
    (parent ?? document.body).appendChild(element);
    this.regions.unshift({ element, x, y, w, h }); // later additions sit on top
    return element;
  }

  elementAt(x: number, y: number): Element | null {
    return this.regions.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)?.element ?? null;
  }
  focusPanel(id: string) { this.log.push(`focus ${id}`); }
  movePanel(id: string, dx: number, dy: number) { this.log.push(`move ${id} ${Math.round(dx)},${Math.round(dy)}`); }
  getPanelScale(id: string) { return this.scales.get(id) ?? 1; }
  setPanelScale(id: string, scale: number) { this.scales.set(id, scale); }
  closePanel(id: string) { this.log.push(`close ${id}`); }
  rotateGlobe(dx: number, dy: number) { this.log.push(`rotate ${Math.round(dx)},${Math.round(dy)}`); }
  getGlobeZoom() { return this.globeZoom; }
  setGlobeZoom(zoom: number) { this.globeZoom = zoom; }
  activate(element: Element) { this.log.push(`activate ${element.id}`); }
  renderCursor(view: CursorView) { this.cursors.set(view.slot, view); }
  palmDismissEnabled() { return this.palmEnabled; }
  dwellEnabled() { return this.dwellOn; }
  elementRect(element: Element) {
    const r = this.regions.find((region) => region.element === element)!;
    return { left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h };
  }
}

function hand(slot: number, x: number, y: number, extra: Partial<HandState> = {}): HandState {
  return { slot, x, y, pinching: false, pinchAmount: 0, openPalm: false, ...extra };
}

function frame(hands: HandState[], events: GestureEvent[] = []): GestureFrame {
  return { hands, events };
}

let page: FakePage;
let manager: InteractionManager;
let panel: Element;
let closeButton: Element;
let dockButton: Element;

beforeEach(() => {
  document.body.innerHTML = "";
  page = new FakePage();
  manager = new InteractionManager(page, GESTURE_CONFIG);
  page.add('<div data-globe-surface id="scene"></div>', 0, 0, 1000, 1000);
  panel = page.add('<section data-panel-id="p1" id="panel"></section>', 100, 100, 300, 300);
  closeButton = page.add('<button id="close">Close</button>', 360, 110, 30, 30, panel);
  dockButton = page.add('<button id="weather">Weather</button>', 450, 900, 100, 40);
});

/** Pinch at a point, optionally move, then release. */
function pinch(slot: number, from: [number, number], to: [number, number] = from, steps = 4, t = 0) {
  manager.handle(frame([hand(slot, ...from, { pinching: true })], [{ type: "pinchstart", slot, x: from[0], y: from[1] }]), t);
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps;
    const y = from[1] + ((to[1] - from[1]) * i) / steps;
    manager.handle(frame([hand(slot, x, y, { pinching: true })], [{ type: "pinchmove", slot, x, y }]), t + i * 33);
  }
  manager.handle(frame([hand(slot, ...to)], [{ type: "pinchend", slot, x: to[0], y: to[1], cancelled: false }]), t + 200);
}

describe("hover", () => {
  it("highlights the control under the cursor and clears it on leaving", () => {
    manager.handle(frame([hand(0, 500, 920)]), 0);
    expect(dockButton.getAttribute("data-hand-hover")).toBe("true");
    expect(page.cursors.get(0)).toMatchObject({ visible: true, x: 500, y: 920, overTarget: true });

    manager.handle(frame([hand(0, 700, 500)]), 33);
    expect(dockButton.hasAttribute("data-hand-hover")).toBe(false);
    expect(page.cursors.get(0)!.overTarget).toBe(false);
  });

  it("ignores disabled buttons", () => {
    dockButton.setAttribute("disabled", "");
    manager.handle(frame([hand(0, 500, 920)]), 0);
    expect(dockButton.hasAttribute("data-hand-hover")).toBe(false);
  });

  it("hides the cursor and hover when the hand is lost", () => {
    manager.handle(frame([hand(0, 500, 920)]), 0);
    manager.handle(frame([], [{ type: "lost", slot: 0 }]), 33);
    expect(dockButton.hasAttribute("data-hand-hover")).toBe(false);
    expect(page.cursors.get(0)!.visible).toBe(false);
  });
});

describe("click", () => {
  it("activates a button on a pinch that stays put", () => {
    pinch(0, [500, 920], [506, 925]);
    expect(page.log).toEqual(["activate weather"]);
    expect(dockButton.hasAttribute("data-hand-press")).toBe(false);
  });

  it("shows the pressed state while the pinch is held", () => {
    manager.handle(frame([hand(0, 500, 920, { pinching: true })], [{ type: "pinchstart", slot: 0, x: 500, y: 920 }]), 0);
    expect(dockButton.getAttribute("data-hand-press")).toBe("true");
  });

  it("does not click when the pinch is cancelled by losing the hand", () => {
    manager.handle(frame([hand(0, 500, 920, { pinching: true })], [{ type: "pinchstart", slot: 0, x: 500, y: 920 }]), 0);
    manager.handle(frame([], [{ type: "pinchend", slot: 0, x: 500, y: 920, cancelled: true }, { type: "lost", slot: 0 }]), 400);
    expect(page.log).toEqual([]);
  });

  it("abandons the click if the hand wanders off a button outside any panel", () => {
    pinch(0, [500, 920], [700, 700]);
    expect(page.log).toEqual([]);
  });

  it("clicks a button inside a panel and focuses that panel", () => {
    pinch(0, [370, 120]);
    expect(page.log).toEqual(["focus p1", "activate close"]);
  });
});

describe("drag", () => {
  it("moves a panel by the distance the hand moved", () => {
    pinch(0, [200, 250], [320, 310]);
    const moves = page.log.filter((l) => l.startsWith("move"));
    const total = moves.reduce(
      (sum, l) => {
        const [dx, dy] = l.split(" ")[2]!.split(",").map(Number);
        return [sum[0]! + dx!, sum[1]! + dy!];
      },
      [0, 0],
    );
    expect(page.log[0]).toBe("focus p1");
    expect(total).toEqual([120, 60]);
    expect(page.log.some((l) => l.startsWith("activate"))).toBe(false);
  });

  it("turns a press on a panel's button into a drag once it travels far enough", () => {
    pinch(0, [370, 120], [530, 220]);
    expect(page.log.some((l) => l.startsWith("activate"))).toBe(false);
    const total = page.log
      .filter((l) => l.startsWith("move"))
      .map((l) => l.split(" ")[2]!.split(",").map(Number))
      .reduce((s, [dx, dy]) => [s[0]! + dx!, s[1]! + dy!], [0, 0]);
    expect(total).toEqual([160, 100]); // no movement is lost in the hand-over
    expect(closeButton.hasAttribute("data-hand-press")).toBe(false);
  });

  it("spins the globe when pinching empty space", () => {
    pinch(0, [700, 500], [760, 480]);
    expect(page.log.every((l) => l.startsWith("rotate"))).toBe(true);
    expect(page.log.length).toBe(4);
  });

  it("resizes from the corner handle", () => {
    page.add('<div data-resize-handle id="grip"></div>', 380, 380, 20, 20, panel);
    pinch(0, [390, 390], [490, 490]);
    expect(page.scales.get("p1")).toBeCloseTo(1.5, 5);
    expect(page.log.filter((l) => l.startsWith("move"))).toEqual([]);
  });

  it("does nothing when pinching chrome that is neither a control, a panel nor the globe", () => {
    page.add('<header id="bar"></header>', 0, 0, 1000, 50);
    pinch(0, [500, 20], [600, 30]);
    expect(page.log).toEqual([]);
  });
});

describe("two-hand zoom", () => {
  function start(a: [number, number], b: [number, number]) {
    manager.handle(frame([hand(0, ...a, { pinching: true }), hand(1, ...b)], [{ type: "pinchstart", slot: 0, x: a[0], y: a[1] }]), 0);
    manager.handle(
      frame([hand(0, ...a, { pinching: true }), hand(1, ...b, { pinching: true })], [{ type: "pinchstart", slot: 1, x: b[0], y: b[1] }]),
      33,
    );
  }
  function moveBoth(a: [number, number], b: [number, number], t: number) {
    manager.handle(
      frame(
        [hand(0, ...a, { pinching: true }), hand(1, ...b, { pinching: true })],
        [{ type: "pinchmove", slot: 0, x: a[0], y: a[1] }, { type: "pinchmove", slot: 1, x: b[0], y: b[1] }],
      ),
      t,
    );
  }

  it("scales the grabbed panel by how far apart the hands move", () => {
    start([200, 250], [700, 500]); // one hand on the panel, one on empty space
    const before = page.log.length;
    moveBoth([100, 250], [850, 500], 66); // 559 px apart -> 791 px apart
    expect(page.scales.get("p1")).toBeCloseTo(791 / 559, 1);
    expect(page.log.length).toBe(before); // the panel is resized, not dragged
  });

  it("clamps to the configured limits", () => {
    start([200, 250], [700, 500]);
    moveBoth([0, 0], [5000, 5000], 66);
    expect(page.scales.get("p1")).toBe(GESTURE_CONFIG.panelScaleMax);
    moveBoth([400, 400], [401, 400], 99);
    expect(page.scales.get("p1")).toBe(GESTURE_CONFIG.panelScaleMin);
  });

  it("zooms the globe when neither hand holds a panel", () => {
    start([600, 500], [800, 500]);
    moveBoth([550, 500], [850, 500], 66);
    expect(page.globeZoom).toBeCloseTo(1.5, 5);
    expect(page.log.filter((l) => l.startsWith("rotate"))).toEqual([]);
  });

  it("continues as a smooth one-hand drag when one hand lets go", () => {
    start([200, 250], [700, 500]);
    moveBoth([150, 250], [800, 500], 66);
    manager.handle(
      frame([hand(0, 150, 250, { pinching: true }), hand(1, 800, 500)], [{ type: "pinchend", slot: 1, x: 800, y: 500, cancelled: false }]),
      99,
    );
    page.log = [];
    manager.handle(frame([hand(0, 160, 255, { pinching: true })], [{ type: "pinchmove", slot: 0, x: 160, y: 255 }]), 132);
    expect(page.log).toEqual(["move p1 10,5"]); // not a jump back by the 50 px moved during the zoom
  });

  it("does not zoom when both hands are pressing buttons", () => {
    start([500, 920], [370, 120]);
    moveBoth([502, 921], [372, 121], 66);
    expect(page.scales.size).toBe(0);
    expect(page.globeZoom).toBe(1);
  });
});

describe("open palm", () => {
  const palm = (x: number, y: number, open = true) => frame([hand(0, x, y, { openPalm: open })]);

  it("closes the panel under it after the hold time, showing progress", () => {
    manager.handle(palm(200, 250), 0);
    manager.handle(palm(200, 250), 400);
    expect(page.cursors.get(0)!.palmProgress).toBeCloseTo(0.5, 5);
    expect(page.log).toEqual([]);
    manager.handle(palm(200, 250), GESTURE_CONFIG.palmHoldMs + 1);
    expect(page.log).toEqual(["close p1"]);
  });

  it("needs the palm lowered before it can close another panel", () => {
    page.add('<section data-panel-id="p2"></section>', 500, 100, 300, 300);
    manager.handle(palm(200, 250), 0);
    manager.handle(palm(200, 250), 900);
    manager.handle(palm(600, 250), 1000);
    manager.handle(palm(600, 250), 3000);
    expect(page.log).toEqual(["close p1"]);

    manager.handle(palm(600, 250, false), 3100);
    manager.handle(palm(600, 250), 3200);
    manager.handle(palm(600, 250), 3200 + GESTURE_CONFIG.palmHoldMs + 1);
    expect(page.log).toEqual(["close p1", "close p2"]);
  });

  it("restarts the timer when the palm moves to a different panel or closes", () => {
    page.add('<section data-panel-id="p2"></section>', 500, 100, 300, 300);
    manager.handle(palm(200, 250), 0);
    manager.handle(palm(600, 250), 700);
    manager.handle(palm(600, 250), 900);
    expect(page.log).toEqual([]);
    manager.handle(palm(600, 250, false), 1000);
    manager.handle(palm(600, 250), 1100);
    manager.handle(palm(600, 250), 1700);
    expect(page.log).toEqual([]);
  });

  it("does nothing over empty space, when disabled, or while dragging", () => {
    manager.handle(palm(700, 600), 0);
    manager.handle(palm(700, 600), 5000);
    expect(page.log).toEqual([]);

    page.palmEnabled = false;
    manager.handle(palm(200, 250), 6000);
    manager.handle(palm(200, 250), 9000);
    expect(page.log).toEqual([]);
  });
});

describe("reset", () => {
  it("clears hover, press and cursors", () => {
    manager.handle(frame([hand(0, 500, 920, { pinching: true })], [{ type: "pinchstart", slot: 0, x: 500, y: 920 }]), 0);
    manager.reset();
    expect(dockButton.hasAttribute("data-hand-press")).toBe(false);
    expect(dockButton.hasAttribute("data-hand-hover")).toBe(false);
    expect(page.cursors.get(0)!.visible).toBe(false);
    // The abandoned pinch must not fire later.
    manager.handle(frame([hand(0, 500, 920)], [{ type: "pinchend", slot: 0, x: 500, y: 920, cancelled: false }]), 100);
    expect(page.log).toEqual([]);
  });
});

describe("click tolerance", () => {
  it("still clicks when the hand drifts well past the old limit but stays near the button", () => {
    pinch(0, [500, 920], [560, 935]); // 60 px of drift, released just beside the button
    expect(page.log).toEqual(["activate weather"]);
  });

  it("does not click when the pinch is released far from the button", () => {
    pinch(0, [500, 920], [720, 920]);
    expect(page.log).toEqual([]);
  });

  it("clicks a button when the pinch is released a little off to one side", () => {
    pinch(0, [540, 915], [590, 960]);
    expect(page.log).toEqual(["activate weather"]);
  });
});

describe("point and hold", () => {
  /** Keep the cursor at one spot, a frame every 100 ms. */
  function rest(x: number, y: number, from: number, to: number) {
    for (let t = from; t <= to; t += 100) manager.handle(frame([hand(0, x, y)]), t);
  }

  it("clicks a button once the cursor has rested on it long enough", () => {
    rest(500, 920, 0, 900);
    expect(page.log).toEqual([]);
    rest(500, 920, 1000, 1100);
    expect(page.log).toEqual(["activate weather"]);
  });

  it("reports hold progress for the cursor ring", () => {
    rest(500, 920, 0, 600);
    expect(page.cursors.get(0)!.dwellProgress).toBeCloseTo(0.6, 1);
  });

  it("clicks only once while the cursor stays put", () => {
    rest(500, 920, 0, 4000);
    expect(page.log).toEqual(["activate weather"]);
  });

  it("clicks again after the cursor leaves and comes back", () => {
    rest(500, 920, 0, 1100);
    rest(700, 500, 1200, 1300);
    rest(500, 920, 1400, 2500);
    expect(page.log).toEqual(["activate weather", "activate weather"]);
  });

  it("restarts the hold if the cursor wanders too far", () => {
    rest(500, 920, 0, 800);
    rest(548, 938, 900, 1700); // still on the button, but beyond the allowed wobble
    expect(page.log).toEqual([]);
    rest(548, 938, 1800, 1900);
    expect(page.log).toEqual(["activate weather"]);
  });

  it("does nothing when it is switched off", () => {
    page.dwellOn = false;
    rest(500, 920, 0, 3000);
    expect(page.log).toEqual([]);
  });

  it("does not click links, which browsers block without a real click", () => {
    page.add('<a href="#x" id="link">Link</a>', 600, 600, 100, 30);
    rest(620, 610, 0, 3000);
    expect(page.log).toEqual([]);
  });

  it("does not click empty space", () => {
    rest(700, 500, 0, 3000);
    expect(page.log).toEqual([]);
  });

  it("does not click a second time right after a pinch click on the same button", () => {
    pinch(0, [500, 920], [500, 920], 4, 0);
    rest(500, 920, 300, 3000);
    expect(page.log).toEqual(["activate weather"]);
  });

  it("does not run while the palm is open", () => {
    for (let t = 0; t <= 3000; t += 100) manager.handle(frame([hand(0, 500, 920, { openPalm: true })]), t);
    expect(page.log).toEqual([]);
  });

  it("forgets the hold when the hand is lost", () => {
    rest(500, 920, 0, 800);
    manager.handle(frame([], [{ type: "lost", slot: 0 }]), 900);
    rest(500, 920, 1000, 1800); // a new hold, only 800 ms so far
    expect(page.log).toEqual([]);
  });
});
