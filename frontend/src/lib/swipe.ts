/**
 * Page-flip gesture: wave an open hand sideways, quickly, like turning a page.
 *
 * Only an open palm counts, because that is the one hand shape nothing else
 * uses for pointing or clicking. A swipe is a mostly horizontal sweep that
 * covers a good part of the screen in about half a second. After one fires,
 * further swipes are ignored briefly so a single wave can't flip two pages.
 *
 * Coordinates are screen pixels with x already mirrored (moving your hand to
 * your right moves x up), as GestureEngine produces them. Moving the hand
 * from right to left is "next", like turning a page of a book.
 */
export interface SwipeConfig {
  /** Horizontal travel needed, as a fraction of the screen width. */
  minTravel: number;
  /** The sweep must finish within this many milliseconds. */
  windowMs: number;
  /** Vertical travel may be at most this fraction of horizontal travel. */
  maxSlope: number;
  /** Peak speed needed, in pixels per millisecond (slow drifting doesn't count). */
  minSpeed: number;
  /** Quiet time after a swipe. */
  cooldownMs: number;
}

export const SWIPE_CONFIG: SwipeConfig = {
  minTravel: 0.3,
  windowMs: 600,
  maxSlope: 0.55,
  minSpeed: 0.9,
  cooldownMs: 1100,
};

export type SwipeDirection = "next" | "previous";

interface Sample {
  t: number;
  x: number;
  y: number;
}

export interface SwipeHand {
  slot: number;
  x: number;
  y: number;
  openPalm: boolean;
  pinching: boolean;
}

export class SwipeDetector {
  private readonly tracks = new Map<number, Sample[]>();
  private blockedUntil = -Infinity;
  /** 0..1: how far the best current sweep is towards firing. Drives the on-screen hint. */
  progress = 0;
  /** Which way the sweep in progress is heading. */
  leaning: SwipeDirection = "next";

  constructor(
    private readonly viewportWidth: () => number,
    private readonly config: SwipeConfig = SWIPE_CONFIG,
  ) {}

  /** Feed one frame. Returns a direction when a swipe just completed. */
  update(hands: SwipeHand[], now: number): SwipeDirection | null {
    const seen = new Set<number>();
    let best = 0;
    let fired: SwipeDirection | null = null;

    for (const hand of hands) {
      seen.add(hand.slot);
      if (!hand.openPalm || hand.pinching || hands.length > 1) {
        this.tracks.delete(hand.slot);
        continue;
      }
      const track = this.tracks.get(hand.slot) ?? [];
      track.push({ t: now, x: hand.x, y: hand.y });
      while (track.length > 0 && now - track[0]!.t > this.config.windowMs) track.shift();
      this.tracks.set(hand.slot, track);
      if (now < this.blockedUntil || track.length < 3) continue;

      const first = track[0]!;
      const last = track[track.length - 1]!;
      const dx = last.x - first.x;
      const dy = Math.abs(last.y - first.y);
      const needed = this.config.minTravel * this.viewportWidth();
      const travel = Math.abs(dx) / needed;
      if (dy <= Math.abs(dx) * this.config.maxSlope && Math.min(1, travel) >= best) {
        best = Math.min(1, travel);
        this.leaning = dx < 0 ? "next" : "previous";
      }

      if (travel >= 1 && dy <= Math.abs(dx) * this.config.maxSlope && this.peakSpeed(track) >= this.config.minSpeed) {
        fired = dx < 0 ? "next" : "previous";
        this.blockedUntil = now + this.config.cooldownMs;
        this.tracks.clear();
        best = 0;
        break;
      }
    }
    for (const slot of [...this.tracks.keys()]) if (!seen.has(slot)) this.tracks.delete(slot);
    this.progress = now < this.blockedUntil ? 0 : best;
    return fired;
  }

  private peakSpeed(track: Sample[]): number {
    let peak = 0;
    for (let i = 1; i < track.length; i++) {
      const dt = track[i]!.t - track[i - 1]!.t;
      if (dt > 0) peak = Math.max(peak, Math.abs(track[i]!.x - track[i - 1]!.x) / dt);
    }
    // One noisy frame must not count as speed: use the average over a few frames.
    const span = track[track.length - 1]!.t - track[0]!.t;
    const average = span > 0 ? Math.abs(track[track.length - 1]!.x - track[0]!.x) / span : 0;
    return Math.min(peak, average * 2.2);
  }

  reset(): void {
    this.tracks.clear();
    this.progress = 0;
  }
}
