/**
 * Turns raw hand landmarks into a cursor position and pinch / open-palm state.
 *
 * Input: up to two hands per frame, each 21 points from MediaPipe, with x and y
 * between 0 and 1 across the camera image.
 * Output: for each hand a smoothed screen position plus flags, and a list of
 * events (pinch started / moved / ended) for the interaction layer.
 *
 * This file has no browser or MediaPipe dependencies, so it is tested with
 * hand poses built from plain numbers.
 */
import type { GestureConfig, PinchFeel, Sensitivity } from "../config/gestures";
import { PointFilter } from "./oneEuro";

export interface Landmark {
  x: number;
  y: number;
  z?: number;
}

/** Indices into MediaPipe's 21 hand landmarks. */
export const LM = {
  wrist: 0,
  thumbBase: 2,
  thumbTip: 4,
  indexBase: 5,
  indexMid: 6,
  indexTip: 8,
  middleBase: 9,
  middleMid: 10,
  middleTip: 12,
  ringMid: 14,
  ringTip: 16,
  littleBase: 17,
  littleMid: 18,
  littleTip: 20,
} as const;

export interface HandState {
  /** Stable slot (0 or 1) that follows the same physical hand between frames. */
  slot: number;
  x: number;
  y: number;
  pinching: boolean;
  /** 0 = fingers apart, 1 = touching. Drives the cursor's shrinking ring. */
  pinchAmount: number;
  openPalm: boolean;
  /** Thumb-to-index distance divided by hand size; what the pinch thresholds are compared with. */
  pinchRatio?: number;
}

export type GestureEvent =
  | { type: "pinchstart"; slot: number; x: number; y: number }
  | { type: "pinchmove"; slot: number; x: number; y: number }
  | { type: "pinchend"; slot: number; x: number; y: number; cancelled: boolean }
  | { type: "lost"; slot: number };

export interface GestureFrame {
  hands: HandState[];
  events: GestureEvent[];
}

export interface Viewport {
  width: number;
  height: number;
}

interface Slot {
  active: boolean;
  lastSeen: number;
  wrist: { x: number; y: number };
  filter: PointFilter;
  history: { t: number; x: number; y: number }[];
  pinching: boolean;
  streak: number;
  /** While pinching: the click point, and the knuckle position when it began. */
  anchor: { x: number; y: number };
  knuckleAtPinch: { x: number; y: number };
  state: HandState;
}

export class GestureEngine {
  private readonly slots: Slot[];
  sensitivity: Sensitivity = "medium";
  pinchFeel: PinchFeel = "normal";

  constructor(
    private readonly config: GestureConfig,
    private readonly viewport: () => Viewport,
    /** Camera image width / height. Needed because landmark x and y use different scales. */
    private readonly aspect: () => number = () => 4 / 3,
  ) {
    this.slots = [0, 1].map((slot) => this.emptySlot(slot));
  }

  private emptySlot(slot: number): Slot {
    return {
      active: false,
      lastSeen: -Infinity,
      wrist: { x: 0, y: 0 },
      filter: new PointFilter(this.config.smoothingMinCutoff, this.config.smoothingBeta),
      history: [],
      pinching: false,
      streak: 0,
      anchor: { x: 0, y: 0 },
      knuckleAtPinch: { x: 0, y: 0 },
      state: { slot, x: 0, y: 0, pinching: false, pinchAmount: 0, openPalm: false },
    };
  }

  /** The ratios below and above which a pinch starts and ends, after the Pinch sensitivity setting. */
  thresholds(): { on: number; off: number } {
    const scale = this.config.pinchScale[this.pinchFeel];
    const on = this.config.pinchOn * scale;
    return { on, off: Math.max(on + 0.05, Math.min(this.config.pinchOff * scale, 0.85)) };
  }

  /** Distance between two landmarks, corrected for the camera's aspect ratio. */
  private distance(a: Landmark, b: Landmark): number {
    return Math.hypot((a.x - b.x) * this.aspect(), a.y - b.y);
  }

  /** Mirror the image (so moving right moves the cursor right) and stretch the centre region. */
  private toScreen(point: Landmark): { x: number; y: number } {
    const margin = this.config.activeMargin[this.sensitivity];
    const span = 1 - 2 * margin;
    const u = Math.min(1, Math.max(0, (1 - point.x - margin) / span));
    const v = Math.min(1, Math.max(0, (point.y - margin) / span));
    const { width, height } = this.viewport();
    return { x: u * width, y: v * height };
  }

  /** Same scaling as toScreen but without clamping; used for movement deltas. */
  private toScreenUnclamped(point: Landmark): { x: number; y: number } {
    const span = 1 - 2 * this.config.activeMargin[this.sensitivity];
    const { width, height } = this.viewport();
    return { x: ((1 - point.x) / span) * width, y: (point.y / span) * height };
  }

  /**
   * Decide which slot each detected hand belongs to. MediaPipe does not keep a
   * stable order, so hands are matched to wherever each slot's wrist was last.
   */
  private assign(hands: Landmark[][], now: number): (number | null)[] {
    const wrists = hands.map((h) => h[LM.wrist]!);
    const live = (slot: Slot) => slot.active || now - slot.lastSeen < this.config.lostHandGraceMs;
    const cost = (wrist: Landmark, slot: Slot) =>
      live(slot) ? Math.hypot(wrist.x - slot.wrist.x, wrist.y - slot.wrist.y) : 0.5;

    if (wrists.length === 0) return [];
    const [s0, s1] = this.slots as [Slot, Slot];
    if (wrists.length === 1) {
      const w = wrists[0]!;
      if (live(s0) && !live(s1)) return [0];
      if (live(s1) && !live(s0)) return [1];
      return [cost(w, s0) <= cost(w, s1) ? 0 : 1];
    }
    const [a, b] = wrists as [Landmark, Landmark];
    const straight = cost(a, s0) + cost(b, s1);
    const crossed = cost(a, s1) + cost(b, s0);
    return straight <= crossed ? [0, 1] : [1, 0];
  }

  private isOpenPalm(hand: Landmark[], handSize: number): boolean {
    const wrist = hand[LM.wrist]!;
    const ratio = this.config.fingerExtendedRatio;
    const extended = (tip: number, mid: number) =>
      this.distance(wrist, hand[tip]!) > this.distance(wrist, hand[mid]!) * ratio;
    const fingers =
      extended(LM.indexTip, LM.indexMid) &&
      extended(LM.middleTip, LM.middleMid) &&
      extended(LM.ringTip, LM.ringMid) &&
      extended(LM.littleTip, LM.littleMid);
    const thumbOut = this.distance(hand[LM.thumbTip]!, hand[LM.indexBase]!) > handSize * 0.45;
    const spread =
      this.distance(hand[LM.indexTip]!, hand[LM.littleTip]!) / handSize > this.config.palmSpreadMin;
    return fingers && thumbOut && spread;
  }

  /** Process one camera frame. `now` is in milliseconds. */
  update(hands: Landmark[][], now: number): GestureFrame {
    const events: GestureEvent[] = [];
    const valid = hands.filter((h) => h.length >= 21).slice(0, 2);
    const assignment = this.assign(valid, now);
    const seen = new Set<number>();

    valid.forEach((hand, index) => {
      const slotIndex = assignment[index];
      if (slotIndex === null || slotIndex === undefined) return;
      const slot = this.slots[slotIndex]!;
      seen.add(slotIndex);

      if (!slot.active && now - slot.lastSeen >= this.config.lostHandGraceMs) {
        // A new hand: forget the previous one's smoothing and history.
        slot.filter.reset();
        slot.history = [];
        slot.pinching = false;
        slot.streak = 0;
      }
      slot.active = true;
      slot.lastSeen = now;
      slot.wrist = { x: hand[LM.wrist]!.x, y: hand[LM.wrist]!.y };

      const handSize = Math.max(
        this.distance(hand[LM.wrist]!, hand[LM.middleBase]!),
        this.distance(hand[LM.indexBase]!, hand[LM.littleBase]!) * 1.2,
        1e-6,
      );
      const pinchRatio = this.distance(hand[LM.thumbTip]!, hand[LM.indexTip]!) / handSize;

      // Hysteresis plus a frame count: a pinch needs to be clearly closed for
      // a couple of frames to start, and clearly open for a couple to end.
      const { on, off } = this.thresholds();
      const wantsPinch = slot.pinching ? pinchRatio < off : pinchRatio < on;
      if (wantsPinch !== slot.pinching) {
        slot.streak += 1;
      } else {
        slot.streak = 0;
      }
      const needed = slot.pinching ? this.config.pinchFramesOff : this.config.pinchFramesOn;
      const knuckle = this.toScreenUnclamped(hand[LM.indexBase]!);
      let started = false;
      let ended = false;
      if (wantsPinch !== slot.pinching && slot.streak >= needed) {
        slot.pinching = wantsPinch;
        slot.streak = 0;
        if (wantsPinch) {
          started = true;
          const target = now - this.config.anchorLookbackMs;
          const past = [...slot.history].reverse().find((h) => h.t <= target) ?? slot.history[0];
          slot.anchor = past ? { x: past.x, y: past.y } : this.toScreen(hand[LM.indexTip]!);
          slot.knuckleAtPinch = knuckle;
        } else {
          ended = true;
        }
      }

      // While pinching the cursor follows the knuckle's movement from the
      // anchor, because the fingertip itself is busy pinching.
      const { width, height } = this.viewport();
      const raw = slot.pinching
        ? {
            x: Math.min(width, Math.max(0, slot.anchor.x + knuckle.x - slot.knuckleAtPinch.x)),
            y: Math.min(height, Math.max(0, slot.anchor.y + knuckle.y - slot.knuckleAtPinch.y)),
          }
        : this.toScreen(hand[LM.indexTip]!);
      if (started) slot.filter.reset(); // jump straight to the anchor, don't glide there
      const smooth = slot.filter.filter(raw.x, raw.y, now / 1000);

      if (!slot.pinching) {
        slot.history.push({ t: now, x: smooth.x, y: smooth.y });
        while (slot.history.length > 0 && now - slot.history[0]!.t > 400) slot.history.shift();
      }

      const span = off * 1.6 - on;
      slot.state = {
        slot: slotIndex,
        x: smooth.x,
        y: smooth.y,
        pinching: slot.pinching,
        pinchAmount: Math.min(1, Math.max(0, 1 - (pinchRatio - on) / span)),
        openPalm: !slot.pinching && this.isOpenPalm(hand, handSize),
        pinchRatio,
      };

      if (started) events.push({ type: "pinchstart", slot: slotIndex, x: smooth.x, y: smooth.y });
      else if (ended) events.push({ type: "pinchend", slot: slotIndex, x: smooth.x, y: smooth.y, cancelled: false });
      else if (slot.pinching) events.push({ type: "pinchmove", slot: slotIndex, x: smooth.x, y: smooth.y });
    });

    // Hands that were not detected this frame.
    this.slots.forEach((slot, slotIndex) => {
      if (seen.has(slotIndex) || !slot.active) return;
      if (now - slot.lastSeen < this.config.lostHandGraceMs) return; // brief dropout: hold state
      slot.active = false;
      if (slot.pinching) {
        slot.pinching = false;
        // A pinch interrupted by losing the hand must not click whatever is under it.
        events.push({ type: "pinchend", slot: slotIndex, x: slot.state.x, y: slot.state.y, cancelled: true });
      }
      events.push({ type: "lost", slot: slotIndex });
    });

    return { hands: this.slots.filter((s) => s.active).map((s) => s.state), events };
  }

  /** Forget everything, e.g. when the camera is switched off. */
  reset(): GestureEvent[] {
    const events: GestureEvent[] = [];
    this.slots.forEach((slot, index) => {
      if (slot.active && slot.pinching) {
        events.push({ type: "pinchend", slot: index, x: slot.state.x, y: slot.state.y, cancelled: true });
      }
      if (slot.active) events.push({ type: "lost", slot: index });
      this.slots[index] = this.emptySlot(index);
    });
    return events;
  }
}
