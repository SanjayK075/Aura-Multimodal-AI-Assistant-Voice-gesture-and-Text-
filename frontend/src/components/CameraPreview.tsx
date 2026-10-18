import { useEffect, useRef } from "react";

import { handTracker } from "../lib/handTracker";
import { useStore } from "../store/useStore";

/**
 * Owns the webcam: starts and stops hand tracking as the camera toggle
 * changes, and shows a small mirrored preview with the tracked hand drawn on it.
 */
export function CameraPreview() {
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const cameraOn = useStore((s) => s.cameraOn);
  const showPreview = useStore((s) => s.settings.showPreview);

  useEffect(() => {
    const { setCamera, setCameraState, toast } = useStore.getState();
    if (!cameraOn) {
      handTracker.stop();
      setCameraState("off");
      return;
    }
    if (!video.current) return;
    let cancelled = false;
    setCameraState("starting");
    const slow = window.setTimeout(
      () => toast("Starting the camera. The first time, this downloads the hand-tracking model (about 8 MB)."),
      1500,
    );
    handTracker
      .start(video.current, overlay.current)
      .then(() => {
        if (!cancelled) setCameraState("on");
      })
      .finally(() => window.clearTimeout(slow))
      .catch((error: Error) => {
        if (cancelled) return;
        toast(error.message, "error");
        setCameraState("error");
        setCamera(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(slow);
      handTracker.stop();
    };
  }, [cameraOn]);

  return (
    <aside className="camera" data-on={cameraOn} data-visible={cameraOn && showPreview} aria-label="Camera preview">
      <video ref={video} playsInline muted />
      <canvas ref={overlay} />
      <div id="gesture-meter" className="camera-meter" data-state="none">
        no hand seen
      </div>
    </aside>
  );
}

/** The two on-screen cursors that follow your hands. Positioned directly by the tracker. */
export function HandCursors() {
  return (
    <div className="hand-cursors" aria-hidden="true">
      {[0, 1].map((slot) => (
        <div key={slot} id={`hand-cursor-${slot}`} className="hand-cursor" data-visible="false">
          <span className="hand-cursor-ring" />
          <span className="hand-cursor-dot" />
        </div>
      ))}
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button type="button" key={toast.id} className="toast" data-kind={toast.kind} onClick={() => dismiss(toast.id)}>
          {toast.text}
        </button>
      ))}
    </div>
  );
}
