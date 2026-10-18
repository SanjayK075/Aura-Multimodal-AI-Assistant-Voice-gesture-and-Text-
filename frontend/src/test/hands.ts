/** Builds synthetic 21-point hands for tests, so gestures can be tested without a camera. */
import type { Landmark } from "../lib/gestures";

export type Pose = "point" | "pinch" | "open" | "fist";

/**
 * A hand positioned so that its index finger, when pointing, has its tip at
 * (tipX, tipY) in camera coordinates (0..1). The palm stays put whatever the
 * pose, as a real one does: pinching or making a fist only moves the fingers,
 * so the fingertip ends up somewhere else. `size` is the wrist-to-knuckle
 * length; a bigger hand is closer to the camera.
 */
export function makeHand(tipX: number, tipY: number, pose: Pose = "point", size = 0.12): Landmark[] {
  const S = size;
  const cx = tipX + 0.3 * S;
  const cy = tipY + 0.95 * S;
  const at = (dx: number, dy: number): Landmark => ({ x: cx + dx * S, y: cy + dy * S, z: 0 });
  const hand: Landmark[] = Array.from({ length: 21 }, () => at(0, 0));

  hand[0] = at(0, 1); // wrist
  hand[5] = at(-0.25, 0.05); // index knuckle
  hand[9] = at(0, 0); // middle knuckle
  hand[13] = at(0.2, 0.05);
  hand[17] = at(0.35, 0.15); // little-finger knuckle

  const extended = pose === "open";
  const curled = (x: number) => [at(x, 0.3), at(x, 0.4), at(x, 0.3)] as const;
  const straight = (x: number, tipXOff: number, length: number) =>
    [at((x + tipXOff) / 2, -length / 2), at((x + tipXOff) / 2, -length * 0.7), at(tipXOff, -length)] as const;

  // Index finger: extended when pointing or open, bent in a pinch, curled in a fist.
  if (pose === "pinch") [hand[6], hand[7], hand[8]] = [at(-0.3, -0.25), at(-0.32, -0.33), at(-0.3, -0.35)];
  else if (pose === "fist") [hand[6], hand[7], hand[8]] = curled(-0.25);
  else [hand[6], hand[7], hand[8]] = straight(-0.25, -0.3, 0.95);

  [hand[10], hand[11], hand[12]] = extended ? straight(0, 0, 1.0) : curled(0);
  [hand[14], hand[15], hand[16]] = extended ? straight(0.2, 0.25, 0.9) : curled(0.2);
  [hand[18], hand[19], hand[20]] = extended ? straight(0.35, 0.6, 0.7) : curled(0.35);

  // Thumb: touching the index tip in a pinch, stuck out for an open palm, tucked otherwise.
  hand[1] = at(-0.3, 0.7);
  hand[2] = at(-0.45, 0.5);
  hand[3] = at(-0.55, 0.35);
  if (pose === "pinch") hand[4] = at(-0.27, -0.3);
  else if (pose === "open") hand[4] = at(-0.85, 0.2);
  else hand[4] = at(-0.62, 0.15);
  return hand;
}

/** Camera x for a desired screen x, undoing the mirror and active-region stretch. */
export function cameraX(screenX: number, width = 1000, margin = 0.18): number {
  return 1 - (margin + (screenX / width) * (1 - 2 * margin));
}

export function cameraY(screenY: number, height = 1000, margin = 0.18): number {
  return margin + (screenY / height) * (1 - 2 * margin);
}

/** A hand whose cursor lands on the given screen pixel. */
export function handAt(screenX: number, screenY: number, pose: Pose = "point", size = 0.12): Landmark[] {
  return makeHand(cameraX(screenX), cameraY(screenY), pose, size);
}
