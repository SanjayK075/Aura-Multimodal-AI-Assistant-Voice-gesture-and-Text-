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

/** Where the globe sits in the view: offset (world units) and size multiplier. */
export interface GlobeLayout {
  x: number;
  y: number;
  scale: number;
}

export const DEFAULT_LAYOUT: GlobeLayout = { x: 0, y: 0.2, scale: 1 };
const START = { yaw: -2.95, pitch: 0.3 }; // facing India

export const globeControl = {
  yaw: START.yaw,
  pitch: START.pitch,
  zoom: 1,
  /** Where an eased turn is heading, or null when the user is in control. */
  target: null as { yaw: number; pitch: number } | null,
  lastInput: -Infinity,
  /** The layout the scene is easing towards; pages set it with setLayout. */
  layout: { ...DEFAULT_LAYOUT } as GlobeLayout,
  /** Extra spin speed (radians a second) added while idle or on the home page. */
  drift: 0.05,
  /** Screen positions of marker labels, written by the scene, read by the label layer. */
  labels: [] as LabelPosition[],

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

  /** Back to the starting view: facing India, normal size. */
  reset(): void {
    this.target = { yaw: START.yaw, pitch: START.pitch };
    this.zoom = 1;
    this.lastInput = performance.now();
  },

  setLayout(layout: Partial<GlobeLayout>): void {
    this.layout = { ...DEFAULT_LAYOUT, ...layout };
  },
};
