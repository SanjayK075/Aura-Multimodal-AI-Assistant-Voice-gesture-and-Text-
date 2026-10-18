/**
 * Every tunable number for hand tracking, in one place.
 *
 * Cameras, lighting and hands differ, so expect to adjust these. Distances
 * marked "ratio" are divided by the size of the hand in the frame, which makes
 * them independent of how far the hand is from the camera.
 */
export const GESTURE_CONFIG = {
  /** Thumb-to-index distance (ratio) below which a pinch starts. Lower = harder to trigger. */
  pinchOn: 0.3,
  /** Distance (ratio) above which a pinch ends. The gap to pinchOn prevents flicker. */
  pinchOff: 0.45,
  /**
   * The Pinch sensitivity setting multiplies pinchOn and pinchOff by one of these.
   * "firm" needs the fingers closer together; "easy" accepts a looser pinch.
   */
  pinchScale: { firm: 0.8, normal: 1, easy: 1.25 },
  /** Consecutive frames a pinch must be seen before it counts (filters single-frame noise). */
  pinchFramesOn: 2,
  /** Consecutive frames of "not pinching" before a pinch is released. */
  pinchFramesOff: 2,

  /**
   * Closing the fingers drags the fingertip down. A click therefore lands where
   * the cursor was this many milliseconds *before* the pinch was detected.
   */
  anchorLookbackMs: 120,
  /**
   * A pinch that starts on a button inside a panel and travels further than this
   * (pixels) becomes a drag of the panel instead of a click.
   */
  clickMaxTravelPx: 70,
  /**
   * A click lands if the pinch is released within this many pixels of the button
   * it started on. Webcam hands are shaky; this keeps a small wobble from losing the click.
   */
  clickSlopPx: 60,

  /** Point and hold: how long the cursor must rest on a button to click it. */
  dwellMs: 1000,
  /** The cursor may wander this far (pixels) during the hold before the timer restarts. */
  dwellRadiusPx: 48,

  /** How long an open palm must be held over a panel to close it. */
  palmHoldMs: 800,
  /** Index-tip to little-finger-tip distance (ratio) required for "open palm". */
  palmSpreadMin: 0.75,
  /** A finger is extended when its tip is this much further from the wrist than its middle joint. */
  fingerExtendedRatio: 1.15,

  /**
   * Fraction of the camera frame ignored at each edge. The remaining centre
   * region is stretched over the whole screen, so the corners can be reached
   * without the hand leaving the camera's view. Chosen by the Sensitivity setting.
   */
  activeMargin: { low: 0.1, medium: 0.18, high: 0.26 },

  /** One Euro filter: lower minCutoff = steadier but laggier cursor. */
  smoothingMinCutoff: 1.4,
  /** One Euro filter: higher beta = less lag during fast movement. */
  smoothingBeta: 0.035,

  /** A hand that vanishes for less than this is treated as still present. */
  lostHandGraceMs: 250,

  /** Smallest and largest panel scale reachable by two-hand zoom. */
  panelScaleMin: 0.6,
  panelScaleMax: 1.8,
  globeZoomMin: 0.6,
  globeZoomMax: 1.7,
  /** Radians of globe rotation per pixel of drag. */
  globeDragSpeed: 0.006,

  /** Camera resolution requested. Higher is more precise but slower. */
  cameraWidth: 640,
  cameraHeight: 480,
  /** Google's hand landmark model, downloaded by the browser on first use (about 8 MB). */
  modelUrl:
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  /** A copy served by the app itself, used instead when present (see `npm run fetch-model`). */
  localModelPath: `${import.meta.env.BASE_URL}models/hand_landmarker.task`,
  wasmPath: `${import.meta.env.BASE_URL}mediapipe/wasm`,
} as const;

export type GestureConfig = typeof GESTURE_CONFIG;
export type Sensitivity = keyof GestureConfig["activeMargin"];
export type PinchFeel = keyof GestureConfig["pinchScale"];
