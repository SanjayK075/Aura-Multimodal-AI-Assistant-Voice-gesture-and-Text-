/**
 * Makes a tracked hand behave like a pointer.
 *
 * Every control in the app is an ordinary button or link that already works
 * with a mouse. This layer finds the element under each hand's cursor and
 * hovers, clicks or drags it, so nothing needs a separate "gesture version":
 *
 *   quick pinch on a button      -> click it (released on or near the button)
 *   rest on a button for a second-> click it (point and hold, no pinch needed)
 *   pinch and move on a panel    -> drag the panel
 *   pinch and move on empty space-> spin the globe
 *   both hands pinching          -> resize the panel (or zoom the globe)
 *   open palm held over a panel  -> close it
 *
 * All access to the page goes through the InteractionHost interface, which is
 * what lets the tests drive this with a fake page.
 */
import type { GestureConfig } from "../config/gestures";
import type { GestureFrame, HandState } from "./gestures";

export const INTERACTIVE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="button"], [data-hand-target]';

export interface CursorView {
  slot: number;
  visible: boolean;
  x: number;
  y: number;
  pinching: boolean;
  pinchAmount: number;
  /** True when a pinch here would click something. */
  overTarget: boolean;
  /** 0..1 progress of an open-palm hold. */
  palmProgress: number;
  /** 0..1 progress of a point-and-hold click. */
  dwellProgress: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface InteractionHost {
  elementAt(x: number, y: number): Element | null;
  focusPanel(id: string): void;
  movePanel(id: string, dx: number, dy: number): void;
  getPanelScale(id: string): number | null;
  setPanelScale(id: string, scale: number): void;
  closePanel(id: string): void;
  rotateGlobe(dx: number, dy: number): void;
  getGlobeZoom(): number;
  setGlobeZoom(zoom: number): void;
  /** Click, focus or open the element, as a mouse click would. */
  activate(element: Element): void;
  /** Where an element sits on screen, for judging whether a pinch was released on it. */
  elementRect(element: Element): Box;
  renderCursor(view: CursorView): void;
  palmDismissEnabled(): boolean;
  /** Whether point-and-hold clicking is switched on in Settings. */
  dwellEnabled(): boolean;
}

type Grab =
  | { kind: "press"; element: Element; panelId: string | null; startX: number; startY: number; lastX: number; lastY: number }
  | { kind: "panel"; panelId: string; lastX: number; lastY: number }
  | { kind: "resize"; panelId: string; startScale: number; startX: number; startY: number }
  | { kind: "globe"; lastX: number; lastY: number };

interface Zoom {
  panelId: string | null;
  startDistance: number;
  startScale: number;
}

interface Dwell {
  element: Element;
  since: number;
  x: number;
  y: number;
  /** Already clicked; the cursor must leave the element before it can click again. */
  fired: boolean;
}

interface Palm {
  panelId: string | null;
  since: number;
  /** After closing a panel, the palm must be lowered before it can close another. */
  armed: boolean;
}

function panelIdOf(element: Element | null): string | null {
  return element?.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? null;
}

export class InteractionManager {
  private readonly grabs = new Map<number, Grab>();
  private readonly positions = new Map<number, { x: number; y: number }>();
  private readonly hovered = new Map<number, Element>();
  private readonly palms = new Map<number, Palm>();
  private readonly dwells = new Map<number, Dwell>();
  private zoom: Zoom | null = null;

  constructor(
    private readonly host: InteractionHost,
    private readonly config: GestureConfig,
  ) {}

  private clampScale(scale: number): number {
    return Math.min(this.config.panelScaleMax, Math.max(this.config.panelScaleMin, scale));
  }

  private setHover(slot: number, element: Element | null): void {
    const previous = this.hovered.get(slot);
    if (previous === element) return;
    if (previous && ![...this.hovered.entries()].some(([s, e]) => s !== slot && e === previous)) {
      previous.removeAttribute("data-hand-hover");
    }
    if (element) {
      element.setAttribute("data-hand-hover", "true");
      this.hovered.set(slot, element);
    } else {
      this.hovered.delete(slot);
    }
  }

  private clearPress(grab: Grab | undefined): void {
    if (grab?.kind === "press") grab.element.removeAttribute("data-hand-press");
  }

  private pinchStart(slot: number, x: number, y: number): void {
    const element = this.host.elementAt(x, y);
    const interactive = element?.closest(INTERACTIVE_SELECTOR) ?? null;
    const panelId = panelIdOf(element);
    if (panelId) this.host.focusPanel(panelId);

    if (element?.closest("[data-resize-handle]") && panelId) {
      const startScale = this.host.getPanelScale(panelId) ?? 1;
      this.grabs.set(slot, { kind: "resize", panelId, startScale, startX: x, startY: y });
    } else if (interactive) {
      interactive.setAttribute("data-hand-press", "true");
      this.grabs.set(slot, { kind: "press", element: interactive, panelId, startX: x, startY: y, lastX: x, lastY: y });
    } else if (panelId) {
      this.grabs.set(slot, { kind: "panel", panelId, lastX: x, lastY: y });
    } else if (!element || element.closest("[data-globe-surface]")) {
      this.grabs.set(slot, { kind: "globe", lastX: x, lastY: y });
    }
    this.updateZoom();
  }

  private pinchMove(slot: number, x: number, y: number): void {
    let grab = this.grabs.get(slot);
    if (!grab) return;

    if (grab.kind === "press") {
      grab.lastX = x;
      grab.lastY = y;
      // A button outside any panel stays pressed whatever the hand does; where it is
      // released decides whether it counts (see pinchEnd).
      if (!grab.panelId) return;
      const travelled = Math.hypot(x - grab.startX, y - grab.startY);
      if (travelled <= this.config.clickMaxTravelPx) return;
      // On a panel, moving this far means the person is dragging the panel, not clicking.
      this.clearPress(grab);
      grab = { kind: "panel", panelId: grab.panelId, lastX: grab.startX, lastY: grab.startY };
      this.grabs.set(slot, grab);
    }
    if (this.zoom) return; // two-hand zoom owns the movement

    if (grab.kind === "panel") {
      this.host.movePanel(grab.panelId, x - grab.lastX, y - grab.lastY);
      grab.lastX = x;
      grab.lastY = y;
    } else if (grab.kind === "globe") {
      this.host.rotateGlobe(x - grab.lastX, y - grab.lastY);
      grab.lastX = x;
      grab.lastY = y;
    } else if (grab.kind === "resize") {
      const delta = (x - grab.startX + (y - grab.startY)) / 400;
      this.host.setPanelScale(grab.panelId, this.clampScale(grab.startScale + delta));
    }
  }

  /** True if the pinch ended on, or close enough to, the button it began on. */
  private releasedOnTarget(grab: Extract<Grab, { kind: "press" }>): boolean {
    const box = this.host.elementRect(grab.element);
    const slop = this.config.clickSlopPx;
    return (
      grab.lastX >= box.left - slop &&
      grab.lastX <= box.right + slop &&
      grab.lastY >= box.top - slop &&
      grab.lastY <= box.bottom + slop
    );
  }

  private pinchEnd(slot: number, cancelled: boolean, now: number): void {
    const grab = this.grabs.get(slot);
    this.grabs.delete(slot);
    this.clearPress(grab);
    if (grab?.kind === "press" && !cancelled && this.releasedOnTarget(grab)) {
      this.host.activate(grab.element);
      // The hand is still over this button; don't let point-and-hold click it a second time.
      this.dwells.set(slot, { element: grab.element, since: now, x: grab.lastX, y: grab.lastY, fired: true });
    }
    this.updateZoom();
  }

  /** Enter or leave two-hand zoom depending on how many hands are pinching. */
  private updateZoom(): void {
    const pinching = [...this.grabs.entries()].filter(([, g]) => g.kind !== "press");
    const both = this.grabs.size === 2 && pinching.length >= 1;
    if (!both) {
      if (this.zoom) {
        this.zoom = null;
        // Restart any surviving drag from the hand's current position to avoid a jump.
        for (const [slot, grab] of this.grabs) {
          const at = this.positions.get(slot);
          if (at && (grab.kind === "panel" || grab.kind === "globe")) {
            grab.lastX = at.x;
            grab.lastY = at.y;
          }
        }
      }
      return;
    }
    if (this.zoom) return;
    const a = this.positions.get(0);
    const b = this.positions.get(1);
    if (!a || !b) return;
    // A pending click on one hand turns into part of the zoom.
    for (const [slot, grab] of this.grabs) {
      if (grab.kind === "press") {
        this.clearPress(grab);
        this.grabs.set(
          slot,
          grab.panelId
            ? { kind: "panel", panelId: grab.panelId, lastX: grab.startX, lastY: grab.startY }
            : { kind: "globe", lastX: grab.startX, lastY: grab.startY },
        );
      }
    }
    let panelId: string | null = null;
    for (const grab of this.grabs.values()) {
      if (grab.kind === "panel" || grab.kind === "resize") panelId = grab.panelId;
    }
    const startScale = panelId ? (this.host.getPanelScale(panelId) ?? 1) : this.host.getGlobeZoom();
    this.zoom = {
      panelId,
      startDistance: Math.max(40, Math.hypot(a.x - b.x, a.y - b.y)),
      startScale,
    };
  }

  private applyZoom(): void {
    if (!this.zoom) return;
    const a = this.positions.get(0);
    const b = this.positions.get(1);
    if (!a || !b) return;
    const factor = Math.hypot(a.x - b.x, a.y - b.y) / this.zoom.startDistance;
    if (this.zoom.panelId) {
      this.host.setPanelScale(this.zoom.panelId, this.clampScale(this.zoom.startScale * factor));
    } else {
      const zoom = this.zoom.startScale * factor;
      this.host.setGlobeZoom(Math.min(this.config.globeZoomMax, Math.max(this.config.globeZoomMin, zoom)));
    }
  }

  /** Returns 0..1 hold progress; closes the panel under the palm when it reaches 1. */
  private updatePalm(hand: HandState, element: Element | null, now: number): number {
    const state = this.palms.get(hand.slot) ?? { panelId: null, since: now, armed: true };
    this.palms.set(hand.slot, state);
    if (!hand.openPalm) {
      state.armed = true;
      state.panelId = null;
      return 0;
    }
    if (!state.armed || !this.host.palmDismissEnabled() || this.grabs.size > 0) {
      state.panelId = null;
      return 0;
    }
    const panelId = panelIdOf(element);
    if (panelId !== state.panelId) {
      state.panelId = panelId;
      state.since = now;
    }
    if (!panelId) return 0;
    const progress = (now - state.since) / this.config.palmHoldMs;
    if (progress >= 1) {
      this.host.closePanel(panelId);
      state.armed = false;
      state.panelId = null;
      return 0;
    }
    return progress;
  }

  /**
   * Point and hold: resting the cursor on a button for dwellMs clicks it.
   * Returns 0..1 progress for the cursor's ring.
   */
  private updateDwell(hand: HandState, target: Element | null, hasGrab: boolean, now: number): number {
    const slot = hand.slot;
    const eligible =
      target !== null &&
      !target.matches("a[href], [data-no-dwell]") && // links open tabs, which browsers block without a real click
      this.host.dwellEnabled() &&
      !hand.pinching &&
      !hand.openPalm &&
      !hasGrab;
    if (!eligible) {
      this.dwells.delete(slot);
      return 0;
    }
    let dwell = this.dwells.get(slot);
    if (!dwell || dwell.element !== target) {
      dwell = { element: target, since: now, x: hand.x, y: hand.y, fired: false };
      this.dwells.set(slot, dwell);
      return 0;
    }
    if (dwell.fired) return 0;
    if (Math.hypot(hand.x - dwell.x, hand.y - dwell.y) > this.config.dwellRadiusPx) {
      dwell.since = now; // drifted: start the hold again from here
      dwell.x = hand.x;
      dwell.y = hand.y;
      return 0;
    }
    const progress = (now - dwell.since) / this.config.dwellMs;
    if (progress >= 1) {
      dwell.fired = true;
      this.host.activate(target);
      return 0;
    }
    return progress;
  }

  /** Apply one frame of gesture output. `now` is in milliseconds. */
  handle(frame: GestureFrame, now: number): void {
    for (const hand of frame.hands) this.positions.set(hand.slot, { x: hand.x, y: hand.y });

    for (const event of frame.events) {
      if (event.type === "pinchstart") this.pinchStart(event.slot, event.x, event.y);
      else if (event.type === "pinchmove") this.pinchMove(event.slot, event.x, event.y);
      else if (event.type === "pinchend") this.pinchEnd(event.slot, event.cancelled, now);
      else if (event.type === "lost") {
        this.setHover(event.slot, null);
        this.palms.delete(event.slot);
        this.dwells.delete(event.slot);
        this.positions.delete(event.slot);
        this.host.renderCursor({
          slot: event.slot, visible: false, x: 0, y: 0, pinching: false, pinchAmount: 0, overTarget: false, palmProgress: 0, dwellProgress: 0,
        });
      }
    }
    this.applyZoom();

    for (const hand of frame.hands) {
      const element = this.host.elementAt(hand.x, hand.y);
      const grab = this.grabs.get(hand.slot);
      // While pressing, keep the pressed element highlighted even if the cursor drifts slightly.
      const target = grab?.kind === "press" ? grab.element : (element?.closest(INTERACTIVE_SELECTOR) ?? null);
      this.setHover(hand.slot, hand.pinching && grab?.kind !== "press" ? null : target);
      const palmProgress = this.updatePalm(hand, element, now);
      const dwellProgress = this.updateDwell(hand, target, grab !== undefined, now);
      this.host.renderCursor({
        slot: hand.slot,
        visible: true,
        x: hand.x,
        y: hand.y,
        pinching: hand.pinching,
        pinchAmount: hand.pinchAmount,
        overTarget: target !== null,
        palmProgress,
        dwellProgress,
      });
    }
  }

  /** Drop all state, e.g. when the camera turns off. */
  reset(): void {
    for (const grab of this.grabs.values()) this.clearPress(grab);
    for (const slot of [0, 1]) {
      this.setHover(slot, null);
      this.host.renderCursor({
        slot, visible: false, x: 0, y: 0, pinching: false, pinchAmount: 0, overTarget: false, palmProgress: 0, dwellProgress: 0,
      });
    }
    this.grabs.clear();
    this.positions.clear();
    this.palms.clear();
    this.dwells.clear();
    this.zoom = null;
  }
}
