/**
 * The globe's orientation, held outside React.
 *
 * It changes every animation frame (auto-rotation, drags, easing towards a
 * city), and re-rendering React 60 times a second for that would be wasteful.
 * The 3D scene reads this object directly inside its frame loop instead.
 */
import { GESTURE_CONFIG } from "../config/gestures";
import { rotationToFace } from "./geo";

const MAX_PITCH = 1.25;

export interface LabelPosition {
  x: number;
  y: number;
  visible: boolean;
}

export const globeControl = {
  yaw: -2.95, // start facing India
  pitch: 0.3,
  zoom: 1,
  /** Where an eased turn is heading, or null when the user is in control. */
  target: null as { yaw: number; pitch: number } | null,
  lastInput: -Infinity,
  /** Screen positions of marker labels, written by the scene, read by the label layer. */
  labels: [] as LabelPosition[],
  issLabel: { x: 0, y: 0, visible: false } as LabelPosition,

  rotateBy(dx: number, dy: number): void {
    this.target = null;
    this.yaw += dx * GESTURE_CONFIG.globeDragSpeed;
    this.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.pitch + dy * GESTURE_CONFIG.globeDragSpeed));
    this.lastInput = performance.now();
  },

  setZoom(zoom: number): void {
    this.zoom = Math.min(GESTURE_CONFIG.globeZoomMax, Math.max(GESTURE_CONFIG.globeZoomMin, zoom));
    this.lastInput = performance.now();
  },

  /** Turn so a place faces the viewer. */
  faceTowards(lat: number, lon: number): void {
    const { pitch, yaw } = rotationToFace(lat, lon);
    this.target = { yaw, pitch: Math.min(MAX_PITCH, Math.max(-MAX_PITCH, pitch)) };
    this.lastInput = performance.now();
  },
};
