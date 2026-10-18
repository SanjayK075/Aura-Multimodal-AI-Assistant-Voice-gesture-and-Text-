import { describe, expect, it } from "vitest";

import { GESTURE_CONFIG } from "../config/gestures";
import { GestureEngine, type GestureEvent, type Landmark } from "../lib/gestures";
import { OneEuroFilter } from "../lib/oneEuro";
import { handAt } from "./hands";

const VIEW = { width: 1000, height: 1000 };

function engine() {
  return new GestureEngine(GESTURE_CONFIG, () => VIEW, () => 1);
}

/** Feed the same hands for several frames, 33 ms apart; returns every event and the last frame. */
function run(e: GestureEngine, hands: Landmark[][], frames: number, clock: { t: number }) {
  const events: GestureEvent[] = [];
  let last = e.update(hands, clock.t);
  events.push(...last.events);
  for (let i = 1; i < frames; i++) {
    clock.t += 33;
    last = e.update(hands, clock.t);
    events.push(...last.events);
  }
  clock.t += 33;
  return { events, frame: last };
}

describe("cursor position", () => {
  it("puts the cursor where the index fingertip points, mirrored", () => {
    const e = engine();
    const clock = { t: 0 };
    const { frame } = run(e, [handAt(250, 700)], 30, clock);
    expect(frame.hands).toHaveLength(1);
    expect(frame.hands[0]!.x).toBeCloseTo(250, 0);
    expect(frame.hands[0]!.y).toBeCloseTo(700, 0);
    // Moving the hand towards camera-left (smaller x) moves the cursor right.
    const left = handAt(250, 700).map((p) => ({ ...p, x: p.x - 0.1 }));
    const moved = run(e, [left], 30, clock).frame.hands[0]!;
    expect(moved.x).toBeGreaterThan(350);
  });

  it("reaches the screen corners while the hand stays inside the camera frame", () => {
    const e = engine();
    const corner = [{ ...handAt(0, 0)[8]! }];
    expect(corner[0]!.x).toBeLessThan(0.85); // well inside the frame, not at its edge
    const { frame } = run(e, [handAt(-500, -500)], 5, { t: 0 }); // beyond the active region
    expect(frame.hands[0]!.x).toBe(0);
    expect(frame.hands[0]!.y).toBe(0);
  });

  it("maps a wider area at low sensitivity", () => {
    const low = engine();
    low.sensitivity = "low";
    const hand = handAt(100, 500); // built for the medium margin
    const a = run(engine(), [hand], 10, { t: 0 }).frame.hands[0]!.x;
    const b = run(low, [hand], 10, { t: 0 }).frame.hands[0]!.x;
    expect(a).toBeCloseTo(100, 0);
    expect(b).toBeGreaterThan(a); // same hand position lands nearer the centre
  });

  it("removes jitter from a still hand", () => {
    const e = engine();
    const clock = { t: 0 };
    const xs: number[] = [];
    for (let i = 0; i < 60; i++) {
      const noise = (i % 2 ? 1 : -1) * 0.004; // about 6 px of alternating jitter
      const hand = handAt(500, 500).map((p) => ({ ...p, x: p.x + noise }));
      xs.push(e.update([hand], clock.t).hands[0]!.x);
      clock.t += 33;
    }
    const tail = xs.slice(-20);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(4.5); // raw swing is 12.5 px
  });
});

describe("pinch", () => {
  it("starts after two closed frames and ends after two open ones", () => {
    const e = engine();
    const clock = { t: 0 };
    run(e, [handAt(400, 400)], 10, clock);

    const first = e.update([handAt(400, 400, "pinch")], clock.t);
    clock.t += 33;
    expect(first.events).toEqual([]); // a single noisy frame is not a pinch
    const second = e.update([handAt(400, 400, "pinch")], clock.t);
    clock.t += 33;
    expect(second.events.map((ev) => ev.type)).toEqual(["pinchstart"]);
    expect(second.hands[0]!.pinching).toBe(true);
    expect(second.hands[0]!.pinchAmount).toBeGreaterThan(0.9);

    const held = run(e, [handAt(400, 400, "pinch")], 3, clock);
    expect(held.events.every((ev) => ev.type === "pinchmove")).toBe(true);

    const released = run(e, [handAt(400, 400)], 3, clock);
    // The first open frame still counts as pinching; the second ends it.
    expect(released.events.map((ev) => ev.type)).toEqual(["pinchmove", "pinchend"]);
    expect(released.events[1]).toMatchObject({ cancelled: false });
    expect(released.frame.hands[0]!.pinching).toBe(false);
  });

  it("clicks where the cursor was before the fingers closed", () => {
    const e = engine();
    const clock = { t: 0 };
    run(e, [handAt(600, 300)], 15, clock);
    // Closing the fingers pulls the fingertip well away from where it pointed:
    // here by 0.6 of the hand's size, which is over 100 px on this screen.
    const closing = handAt(600, 300, "pinch");
    expect(closing[8]!.y - handAt(600, 300)[8]!.y).toBeCloseTo(0.072, 3);
    const { events } = run(e, [closing], 3, clock);
    const start = events.find((ev) => ev.type === "pinchstart")!;
    expect(start).toMatchObject({ type: "pinchstart" });
    if (start.type === "pinchstart") {
      expect(start.x).toBeCloseTo(600, -1);
      expect(start.y).toBeCloseTo(300, -1);
    }
  });

  it("drags by following the hand, not the pinched fingertip", () => {
    const e = engine();
    const clock = { t: 0 };
    run(e, [handAt(500, 500)], 15, clock);
    run(e, [handAt(500, 500, "pinch")], 4, clock);
    // Move the whole hand 0.1 of the frame to camera-left: 0.1 / 0.64 of the screen to the right.
    const moved = handAt(500, 500, "pinch").map((p) => ({ ...p, x: p.x - 0.1 }));
    const { frame } = run(e, [moved], 25, clock);
    expect(frame.hands[0]!.x).toBeCloseTo(500 + (0.1 / 0.64) * 1000, -1);
    expect(frame.hands[0]!.y).toBeCloseTo(500, -1);
  });

  it("does not flicker when the distance hovers between the two thresholds", () => {
    const e = engine();
    const clock = { t: 0 };
    run(e, [handAt(500, 500)], 5, clock);
    run(e, [handAt(500, 500, "pinch")], 3, clock);
    // Open the fingers slightly: ratio between pinchOn (0.30) and pinchOff (0.45).
    const loose = handAt(500, 500, "pinch");
    loose[4] = { x: loose[8]!.x + 0.045, y: loose[8]!.y, z: 0 }; // 0.045 / 0.12 = 0.375
    const { events, frame } = run(e, [loose], 10, clock);
    expect(events.every((ev) => ev.type === "pinchmove")).toBe(true);
    expect(frame.hands[0]!.pinching).toBe(true);
  });

  it("cancels the pinch if the hand disappears, so nothing gets clicked", () => {
    const e = engine();
    const clock = { t: 0 };
    run(e, [handAt(500, 500)], 5, clock);
    run(e, [handAt(500, 500, "pinch")], 3, clock);

    const brief = e.update([], clock.t); // one dropped frame is ignored
    expect(brief.events).toEqual([]);
    expect(brief.hands).toHaveLength(1);

    clock.t += GESTURE_CONFIG.lostHandGraceMs + 50;
    const gone = e.update([], clock.t);
    expect(gone.events).toEqual([
      expect.objectContaining({ type: "pinchend", cancelled: true }),
      { type: "lost", slot: 0 },
    ]);
    expect(gone.hands).toEqual([]);
  });
});

describe("open palm", () => {
  it("is detected only with all fingers spread", () => {
    const clock = { t: 0 };
    expect(run(engine(), [handAt(500, 500, "open")], 3, clock).frame.hands[0]!.openPalm).toBe(true);
    expect(run(engine(), [handAt(500, 500, "point")], 3, clock).frame.hands[0]!.openPalm).toBe(false);
    expect(run(engine(), [handAt(500, 500, "fist")], 3, clock).frame.hands[0]!.openPalm).toBe(false);
    expect(run(engine(), [handAt(500, 500, "pinch")], 3, clock).frame.hands[0]!.openPalm).toBe(false);
  });

  it("works at any distance from the camera", () => {
    for (const size of [0.06, 0.12, 0.25]) {
      const { frame } = run(engine(), [handAt(500, 500, "open", size)], 3, { t: 0 });
      expect(frame.hands[0]!.openPalm).toBe(true);
      const pinched = run(engine(), [handAt(500, 500, "pinch", size)], 3, { t: 0 });
      expect(pinched.frame.hands[0]!.pinching).toBe(true);
    }
  });
});

describe("two hands", () => {
  it("keeps each hand in its own slot even if the detector swaps their order", () => {
    const e = engine();
    const clock = { t: 0 };
    const left = handAt(200, 500);
    const right = handAt(800, 500);
    const first = run(e, [left, right], 5, clock).frame.hands;
    const slotOfLeft = first.find((h) => h.x < 500)!.slot;

    const swapped = run(e, [right, left], 5, clock).frame.hands;
    expect(swapped.find((h) => h.x < 500)!.slot).toBe(slotOfLeft);
    expect(swapped.map((h) => h.slot).sort()).toEqual([0, 1]);
  });

  it("tracks pinches independently", () => {
    const e = engine();
    const clock = { t: 0 };
    run(e, [handAt(200, 500), handAt(800, 500)], 5, clock);
    const { events, frame } = run(e, [handAt(200, 500, "pinch"), handAt(800, 500)], 3, clock);
    expect(events.filter((ev) => ev.type === "pinchstart")).toHaveLength(1);
    expect(frame.hands.filter((h) => h.pinching)).toHaveLength(1);
  });

  it("ignores incomplete landmark sets and extra hands", () => {
    const e = engine();
    const frame = e.update([handAt(1, 1).slice(0, 10), handAt(200, 200), handAt(500, 500), handAt(800, 800)], 0);
    expect(frame.hands).toHaveLength(2);
  });
});

describe("reset", () => {
  it("cancels anything in progress", () => {
    const e = engine();
    const clock = { t: 0 };
    run(e, [handAt(500, 500)], 5, clock);
    run(e, [handAt(500, 500, "pinch")], 3, clock);
    expect(e.reset()).toEqual([
      expect.objectContaining({ type: "pinchend", cancelled: true }),
      { type: "lost", slot: 0 },
    ]);
    expect(e.update([], clock.t).hands).toEqual([]);
  });
});

describe("One Euro filter", () => {
  it("passes the first sample through and converges on a constant", () => {
    const f = new OneEuroFilter(1, 0.01);
    expect(f.filter(10, 0)).toBe(10);
    let value = 0;
    for (let i = 1; i <= 100; i++) value = f.filter(20, i / 30);
    expect(value).toBeCloseTo(20, 1);
  });

  it("lags less when beta is higher", () => {
    const slow = new OneEuroFilter(1, 0);
    const fast = new OneEuroFilter(1, 0.5);
    let a = 0;
    let b = 0;
    for (let i = 0; i <= 10; i++) {
      a = slow.filter(i * 50, i / 30);
      b = fast.filter(i * 50, i / 30);
    }
    expect(500 - b).toBeLessThan(500 - a);
  });

  it("ignores samples with a non-increasing timestamp", () => {
    const f = new OneEuroFilter();
    f.filter(1, 1);
    expect(f.filter(99, 1)).toBe(1);
  });
});

describe("a whole pinch, start to finish", () => {
  it("returns the cursor to the fingertip on release without dragging anything along", () => {
    const e = engine();
    const clock = { t: 0 };
    run(e, [handAt(500, 500)], 15, clock);
    const during = run(e, [handAt(500, 500, "pinch")], 10, clock);
    // The hand hasn't moved, so nothing should have been dragged while pinching...
    for (const event of during.events) {
      if (event.type === "pinchstart" || event.type === "pinchmove") {
        expect(event.x).toBeCloseTo(500, -1);
        expect(event.y).toBeCloseTo(500, -1);
      }
    }
    // ...nor in the frames where the fingers reopen.
    const release = run(e, [handAt(500, 500)], 4, clock);
    for (const event of release.events) {
      if (event.type === "lost") continue;
      expect(event.x).toBeCloseTo(500, -1);
      expect(event.y).toBeCloseTo(500, -1);
    }
    expect(release.events.at(-1)!.type).toBe("pinchend");
  });
});

describe("pinch sensitivity", () => {
  /** A pointing hand with the thumb tip placed so the pinch ratio is exactly `ratio`. */
  function withGap(ratio: number): Landmark[] {
    const hand = handAt(400, 400, "point");
    const size = Math.abs(hand[0]!.y - hand[9]!.y); // the engine's hand size for this pose
    const tip = hand[8]!;
    hand[4] = { x: tip.x, y: tip.y + ratio * size, z: 0 };
    return hand;
  }

  function startsPinching(feel: "firm" | "normal" | "easy", ratio: number): boolean {
    const e = engine();
    e.pinchFeel = feel;
    const clock = { t: 0 };
    run(e, [handAt(400, 400)], 10, clock);
    return run(e, [withGap(ratio)], 4, clock).frame.hands[0]!.pinching;
  }

  it("reports the ratio the thresholds are compared with", () => {
    const e = engine();
    const frame = e.update([withGap(0.33)], 0);
    expect(frame.hands[0]!.pinchRatio).toBeCloseTo(0.33, 2);
  });

  it("scales the thresholds with the setting", () => {
    const e = engine();
    const normal = e.thresholds();
    e.pinchFeel = "easy";
    expect(e.thresholds().on).toBeGreaterThan(normal.on);
    e.pinchFeel = "firm";
    expect(e.thresholds().on).toBeLessThan(normal.on);
    expect(e.thresholds().off).toBeGreaterThan(e.thresholds().on);
  });

  it("lets a looser pinch count as Easy but not as Normal or Firm", () => {
    expect(startsPinching("normal", 0.34)).toBe(false);
    expect(startsPinching("firm", 0.34)).toBe(false);
    expect(startsPinching("easy", 0.34)).toBe(true);
  });

  it("makes a borderline pinch need to be tighter at Firm", () => {
    expect(startsPinching("normal", 0.27)).toBe(true);
    expect(startsPinching("firm", 0.27)).toBe(false);
  });
});
