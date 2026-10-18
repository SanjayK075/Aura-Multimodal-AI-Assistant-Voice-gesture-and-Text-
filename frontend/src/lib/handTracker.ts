/**
 * Webcam -> MediaPipe hand landmarks -> gestures -> the page.
 *
 * MediaPipe runs entirely in the browser (WebAssembly, GPU when available).
 * No video ever leaves the machine.
 */
import type { HandLandmarker } from "@mediapipe/tasks-vision";

import { GESTURE_CONFIG } from "../config/gestures";
import { useStore } from "../store/useStore";
import { GestureEngine, type GestureFrame, type Landmark } from "./gestures";
import { globeControl } from "./globeControl";
import { InteractionManager, type CursorView, type InteractionHost } from "./interaction";

/** Pairs of landmark indices joined to draw the hand skeleton in the preview. */
const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

function renderCursor(view: CursorView): void {
  const element = document.getElementById(`hand-cursor-${view.slot}`);
  if (!element) return;
  element.dataset.visible = String(view.visible);
  if (!view.visible) return;
  element.style.transform = `translate3d(${view.x}px, ${view.y}px, 0)`;
  element.dataset.pinching = String(view.pinching);
  element.dataset.target = String(view.overTarget);
  element.dataset.palm = String(view.palmProgress > 0);
  // The point-and-hold ring only appears once the cursor has really settled, not while passing over buttons.
  element.dataset.dwell = String(view.dwellProgress > 0.2);
  element.style.setProperty("--pinch", view.pinchAmount.toFixed(3));
  element.style.setProperty("--palm", view.palmProgress.toFixed(3));
  element.style.setProperty("--dwell", view.dwellProgress.toFixed(3));
}

/** How the interaction layer reaches the real page and the real store. */
const host: InteractionHost = {
  elementAt: (x, y) => document.elementFromPoint(x, y),
  focusPanel: (id) => useStore.getState().focusPanel(id),
  movePanel: (id, dx, dy) => useStore.getState().movePanel(id, dx, dy),
  getPanelScale: (id) => useStore.getState().panels.find((p) => p.id === id)?.scale ?? null,
  setPanelScale: (id, scale) => useStore.getState().setPanelScale(id, scale),
  closePanel: (id) => useStore.getState().closePanel(id),
  rotateGlobe: (dx, dy) => globeControl.rotateBy(dx, dy),
  getGlobeZoom: () => globeControl.zoom,
  setGlobeZoom: (zoom) => globeControl.setZoom(zoom),
  activate: (element) => {
    if (element instanceof HTMLAnchorElement && element.href) {
      // A pinch isn't a "real" click to the browser, so it may block the new tab.
      const opened = window.open(element.href, "_blank");
      if (opened) opened.opener = null;
      else useStore.getState().toast("The browser blocked that new tab. Allow pop-ups for this site, or click links with the mouse.");
    } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus();
      if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) element.click();
    } else {
      (element as HTMLElement).click();
    }
  },
  elementRect: (element) => element.getBoundingClientRect(),
  renderCursor,
  palmDismissEnabled: () => useStore.getState().settings.palmDismiss,
  dwellEnabled: () => useStore.getState().settings.dwellClick,
};

const CAMERA_PROBLEMS: Record<string, string> = {
  NotAllowedError: "Camera access is blocked. Allow it from the address bar's site settings, then turn the camera on again.",
  NotFoundError: "No camera was found on this device.",
  NotReadableError: "The camera is in use by another app. Close it and try again.",
  OverconstrainedError: "The camera doesn't support the requested resolution.",
};

export class HandTracker {
  readonly engine = new GestureEngine(
    GESTURE_CONFIG,
    () => ({ width: window.innerWidth, height: window.innerHeight }),
    () => this.aspect,
  );
  readonly interaction = new InteractionManager(host, GESTURE_CONFIG);

  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private overlay: HTMLCanvasElement | null = null;
  private frameRequest: number | null = null;
  private generation = 0;
  private lastVideoTime = -1;
  private aspect = GESTURE_CONFIG.cameraWidth / GESTURE_CONFIG.cameraHeight;

  /** Use the model file served by this site if there is one, otherwise Google's copy. */
  private async modelUrl(): Promise<string> {
    try {
      const response = await fetch(GESTURE_CONFIG.localModelPath, { method: "HEAD" });
      const type = response.headers.get("content-type") ?? "";
      const size = Number(response.headers.get("content-length") ?? 0);
      // Many hosts answer a missing file with the app's HTML page, so check it's really a model.
      if (response.ok && !type.includes("text/html") && size > 1_000_000) return GESTURE_CONFIG.localModelPath;
    } catch {
      // No local copy; fall through.
    }
    return GESTURE_CONFIG.modelUrl;
  }

  private async loadModel(): Promise<HandLandmarker> {
    if (this.landmarker) return this.landmarker;
    // Loaded on demand: the library is large and only needed once the camera is on.
    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(GESTURE_CONFIG.wasmPath);
    const modelAssetPath = await this.modelUrl();
    const options = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetPath, delegate },
      runningMode: "VIDEO" as const,
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options("GPU"));
    } catch {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options("CPU"));
    }
    return this.landmarker;
  }

  /** Turn the camera on and begin tracking. Throws an Error with a user-facing message. */
  async start(video: HTMLVideoElement, overlay: HTMLCanvasElement | null): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("The camera needs a secure page. Open the app on https or on localhost.");
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: GESTURE_CONFIG.cameraWidth },
          height: { ideal: GESTURE_CONFIG.cameraHeight },
        },
      });
    } catch (error) {
      throw new Error(CAMERA_PROBLEMS[(error as DOMException).name] ?? "The camera couldn't be started.");
    }
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop()); // switched off while starting
      return;
    }
    this.stream = stream;
    this.video = video;
    this.overlay = overlay;
    video.srcObject = stream;
    await video.play().catch(() => undefined);

    let landmarker: HandLandmarker;
    try {
      landmarker = await this.loadModel();
    } catch {
      this.stop();
      throw new Error("The hand-tracking model couldn't be downloaded. Check the internet connection and try again.");
    }
    if (generation !== this.generation) return;

    const tick = () => {
      if (generation !== this.generation) return;
      if (video.readyState >= 2 && video.currentTime !== this.lastVideoTime && video.videoWidth > 0) {
        this.lastVideoTime = video.currentTime;
        this.aspect = video.videoWidth / video.videoHeight;
        const now = performance.now();
        const result = landmarker.detectForVideo(video, now);
        this.process(result.landmarks, now);
      }
      this.frameRequest = requestAnimationFrame(tick);
    };
    this.frameRequest = requestAnimationFrame(tick);
  }

  /** Run one frame of landmarks through gestures and interaction. */
  process(hands: Landmark[][], now: number): GestureFrame {
    const { sensitivity, pinchFeel } = useStore.getState().settings;
    this.engine.sensitivity = sensitivity;
    this.engine.pinchFeel = pinchFeel;
    const frame = this.engine.update(hands, now);
    this.interaction.handle(frame, now);
    this.draw(hands, frame);
    this.updateMeter(frame);
    return frame;
  }

  /**
   * The small readout in the camera box: what the pinch detector currently sees.
   * Pinch your fingers and watch the number fall below the threshold; if it never
   * gets there, raise Pinch sensitivity in Settings.
   */
  private updateMeter(frame: GestureFrame): void {
    const meter = document.getElementById("gesture-meter");
    if (!meter) return;
    const hand = frame.hands[0];
    if (!hand) {
      if (meter.dataset.state !== "none") {
        meter.dataset.state = "none";
        meter.textContent = "no hand seen";
      }
      return;
    }
    const { on } = this.engine.thresholds();
    meter.dataset.state = hand.pinching ? "pinch" : "open";
    meter.textContent = `${hand.pinching ? "PINCH" : "open"} ${(hand.pinchRatio ?? 0).toFixed(2)} · click below ${on.toFixed(2)}`;
  }

  private draw(hands: Landmark[][], frame: GestureFrame): void {
    const canvas = this.overlay;
    const video = this.video;
    if (!canvas || !video || !video.videoWidth) return;
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);

    // Outline the region of the frame that maps onto the screen.
    const margin = GESTURE_CONFIG.activeMargin[this.engine.sensitivity];
    context.strokeStyle = "rgba(159, 232, 255, 0.35)";
    context.lineWidth = 1.5;
    context.setLineDash([6, 6]);
    context.strokeRect(
      margin * canvas.width, margin * canvas.height,
      (1 - 2 * margin) * canvas.width, (1 - 2 * margin) * canvas.height,
    );
    context.setLineDash([]);

    const pinching = frame.hands.some((h) => h.pinching);
    for (const hand of hands) {
      if (hand.length < 21) continue;
      context.strokeStyle = pinching ? "#ffb454" : "#9fe8ff";
      context.lineWidth = 2.5;
      context.beginPath();
      for (const [a, b] of BONES) {
        context.moveTo(hand[a]!.x * canvas.width, hand[a]!.y * canvas.height);
        context.lineTo(hand[b]!.x * canvas.width, hand[b]!.y * canvas.height);
      }
      context.stroke();
      context.fillStyle = "#ffffff";
      for (const tip of [4, 8]) {
        context.beginPath();
        context.arc(hand[tip]!.x * canvas.width, hand[tip]!.y * canvas.height, 4.5, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  stop(): void {
    this.generation += 1;
    if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.lastVideoTime = -1;
    this.engine.reset();
    this.interaction.reset();
    const context = this.overlay?.getContext("2d");
    if (context && this.overlay) context.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.overlay = null;
  }
}

export const handTracker = new HandTracker();
